import { AwsClient } from 'aws4fetch';

export interface ArchiveMessage {
	readonly key: string;
	readonly body: Uint8Array;
}

export interface Env {
	readonly S3_ACCESS_KEY: string;
	readonly S3_ACCESS_SECRET: string;
	readonly S3_REGION: string;
	readonly S3_BUCKET: string;
	readonly S3_ENDPOINT: string;
	readonly ARCHIVE_QUEUE: Queue<ArchiveMessage>;
}

const REDIRECT_URL = 'https://github.com/tweedge/workers-email-archiver';
const REDIRECT_STATUS = 307;
const UPLOAD_ATTEMPTS = 4;
const INITIAL_RETRY_MS = 250;
// Email Workers have no documented wall-clock limit, but inbound SMTP wants a
// prompt answer and the platform has historically cut email handlers off
// around 30s. Keep the whole retry sequence inside a budget well under that.
const UPLOAD_BUDGET_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 8_000;
// Queue consumers get 15 minutes of wall time, so they can afford a longer
// sequence per message. Bounded anyway so a batch of failures stays well
// inside that limit.
const QUEUE_UPLOAD_BUDGET_MS = 30_000;
const QUEUE_UPLOAD_TIMEOUT_MS = 10_000;
// Queues caps a message at 128 KB of payload plus ~100 bytes of framework
// metadata (1 KB counts as 1000 bytes). Leave headroom for the envelope and
// the object key so a send near the limit can never be rejected after we have
// already answered the sender.
const MAX_QUEUED_PAYLOAD_BYTES = 120_000;
const GZIP_HEADER_LENGTH = 10;
const GZIP_FLAG_FNAME = 0x08;

class UploadError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = 'UploadError';
		this.retryable = retryable;
	}
}

/**
 * Reads the raw message to completion, then verifies it matched the size
 * Cloudflare reported. `message.rawSize` is treated as an assertion rather
 * than an allocation size, so a mismatched value can never archive a
 * truncated or zero-padded message.
 */
async function readMessage(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			chunks.push(value);
			bytesRead += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	if (bytesRead !== expectedSize) {
		throw new Error(`Raw message size mismatch: read ${bytesRead} bytes but expected ${expectedSize}`);
	}

	if (chunks.length === 1) {
		return chunks[0]!;
	}

	const raw = new Uint8Array(bytesRead);
	let offset = 0;
	for (const chunk of chunks) {
		raw.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return raw;
}

/**
 * Splits an envelope address into its local part and domain. The last `@` is
 * the separator so quoted local parts containing `@` still resolve to a
 * domain. Addresses without a valid domain are rejected rather than written
 * to a bogus path segment.
 */
function splitAddress(address: string, field: string): { local: string; domain: string } {
	const at = address.lastIndexOf('@');
	if (at <= 0 || at === address.length - 1) {
		throw new Error(`Invalid ${field} address: ${JSON.stringify(address)}`);
	}
	return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * Encodes the characters in a key segment that would otherwise make the
 * request path disagree with SigV4's canonical URI. Notably `+` is decoded as
 * a space by the signer, which breaks signatures for plus-addressed mail.
 * Percent-encoding is kept deliberately narrow (`+`, `=`, `%`, query/fragment
 * delimiters, whitespace, `\`, and the RFC 3986 sub-delims the signer
 * normalizes) so object keys stay readable.
 *
 * `/` is intentionally left raw: encoding it to `%2F` would make the stored
 * key diverge from the signer's canonical path, because aws4fetch collapses
 * `%2F` back to `/` when canonicalizing. Each character is encoded
 * individually so multi-byte whitespace (e.g. U+00A0, U+2028) produces valid
 * UTF-8 escapes rather than truncated code-unit escapes.
 */
function encodeKeySegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[%+=?#\s!'()*\\]/g, (char) =>
			encodeURIComponent(char).replace(/[!'()*]/g, (escaped) => '%' + escaped.charCodeAt(0).toString(16).toUpperCase()),
		);
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

const gzipEncoder = new TextEncoder();

/**
 * Compresses with the runtime's native gzip (`CompressionStream`) instead of a
 * JS deflate implementation, which cuts CPU time several-fold on large mail.
 * The native encoder writes a bare 10-byte header, so the archive timestamp
 * and filename are patched into a fresh header; the deflate payload and the
 * CRC32/ISIZE trailer are preserved byte-for-byte.
 */
async function compressMessage(raw: Uint8Array, filename: string, mtimeMs: number): Promise<Uint8Array> {
	const gzipped = new Uint8Array(
		await new Response(new Response(raw as unknown as BodyInit).body!.pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
	);

	const name = gzipEncoder.encode(filename);
	const header = new Uint8Array(GZIP_HEADER_LENGTH);
	new DataView(header.buffer).setUint32(4, Math.floor(mtimeMs / 1000), true);
	header[0] = 0x1f;
	header[1] = 0x8b;
	header[2] = 8;
	header[3] = GZIP_FLAG_FNAME;
	header[9] = 3;

	const payload = gzipped.subarray(GZIP_HEADER_LENGTH);
	const body = new Uint8Array(GZIP_HEADER_LENGTH + name.length + 1 + payload.length);
	body.set(header, 0);
	body.set(name, GZIP_HEADER_LENGTH);
	body[GZIP_HEADER_LENGTH + name.length] = 0;
	body.set(payload, GZIP_HEADER_LENGTH + name.length + 1);
	return body;
}

function toUploadError(error: unknown, label: string): UploadError {
	if (error instanceof Error) {
		const retryable = error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError;
		return new UploadError(`${error.name}: ${error.message} (upload to ${label})`, retryable);
	}
	return new UploadError(`Upload to ${label} failed`, true);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Uploads with a bounded retry policy covering 5xx/429 responses, timeouts,
 * and transport failures. The whole sequence shares one overall deadline so
 * retries can never outlive the caller's invocation, and each attempt is
 * additionally capped by that remaining budget.
 */
async function uploadWithRetry(
	aws: AwsClient,
	url: string,
	body: Uint8Array,
	label: string,
	budgetMs: number = UPLOAD_BUDGET_MS,
	timeoutMs: number = UPLOAD_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	let lastError: UploadError | undefined;

	for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			const backoff = INITIAL_RETRY_MS * 2 ** (attempt - 1);
			await delay(Math.min(backoff + Math.random() * INITIAL_RETRY_MS, Math.max(0, deadline - Date.now())));
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;

		let response: Response;
		try {
			response = await aws.fetch(url, {
				method: 'PUT',
				// lib.dom's BodyInit omits ArrayBufferView; the Workers runtime accepts it.
				body: body as unknown as BodyInit,
				signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
			});
		} catch (error) {
			const uploadError = toUploadError(error, label);
			if (!uploadError.retryable) throw uploadError;
			lastError = uploadError;
			continue;
		}

		if (response.ok) return;

		const statusError = new UploadError(`Bad status code from ${label}: ${response.status}`, isRetryableStatus(response.status));
		if (!statusError.retryable) throw statusError;
		lastError = statusError;
	}

	throw lastError!;
}

function createAwsClient(env: Env): AwsClient {
	return new AwsClient({
		accessKeyId: env.S3_ACCESS_KEY,
		secretAccessKey: env.S3_ACCESS_SECRET,
		service: 's3',
		region: env.S3_REGION,
		retries: 0,
	});
}

function endpointOf(env: Env): string {
	return `https://${env.S3_BUCKET}.${env.S3_ENDPOINT}/`;
}

/**
 * Builds the archive key from the envelope addresses and the archive
 * timestamp. The timestamp doubles as the gzip filename and the object
 * basename, and is generated once per message so a queue retry always
 * overwrites the same object instead of creating a duplicate.
 */
function archiveKey(to: string, from: string, timeNow: number): string {
	const { domain } = splitAddress(to, 'recipient');
	const { domain: srcDomain } = splitAddress(from, 'sender');
	return `${encodeKeySegment(domain)}/${encodeKeySegment(to)}/${encodeKeySegment(srcDomain)}/${timeNow}.eml.gz`;
}

async function uploadToArchive(env: Env, key: string, body: Uint8Array, budgetMs?: number, timeoutMs?: number): Promise<void> {
	await uploadWithRetry(createAwsClient(env), `${endpointOf(env)}${key}`, body, endpointOf(env), budgetMs, timeoutMs);
}

export default {
	async fetch(_request: Request): Promise<Response> {
		return Response.redirect(REDIRECT_URL, REDIRECT_STATUS);
	},

	async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
		const timeNow = Date.now();
		const rawEmail = await readMessage(message.raw, message.rawSize);

		const compressedEmail = await compressMessage(rawEmail, `${timeNow}.eml`, timeNow);

		const key = archiveKey(message.to, message.from, timeNow);

		if (compressedEmail.byteLength <= MAX_QUEUED_PAYLOAD_BYTES) {
			await env.ARCHIVE_QUEUE.send({ key, body: compressedEmail }, { contentType: 'v8' });
			console.log(`Queued ${key}`);
			return;
		}

		// Too large to fit a queue message; archive inline as before.
		await uploadToArchive(env, key, compressedEmail);

		console.log(`Archived ${key}`);
	},

	async queue(batch: MessageBatch<ArchiveMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
		for (const message of batch.messages) {
			const { key, body } = message.body;
			try {
				await uploadToArchive(env, key, body, QUEUE_UPLOAD_BUDGET_MS, QUEUE_UPLOAD_TIMEOUT_MS);
			} catch (error) {
				console.error(`Retrying ${key} (attempt ${message.attempts}): ${String(error)}`);
				message.retry({ delaySeconds: Math.min(2 ** message.attempts, 3_600) });
				continue;
			}
			console.log(`Archived ${key}`);
			message.ack();
		}
	},
} satisfies ExportedHandler<Env, ArchiveMessage>;
