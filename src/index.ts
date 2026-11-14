import { AwsClient } from 'aws4fetch';
import { gzipSync } from 'fflate';

export interface Env {
	readonly S3_ACCESS_KEY: string;
	readonly S3_ACCESS_SECRET: string;
	readonly S3_REGION: string;
	readonly S3_BUCKET: string;
	readonly S3_ENDPOINT: string;
}

const REDIRECT_URL = 'https://github.com/tweedge/workers-email-archiver';
const REDIRECT_STATUS = 307;
const UPLOAD_ATTEMPTS = 4;
const INITIAL_RETRY_MS = 250;
const UPLOAD_TIMEOUT_MS = 15_000;

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
 * delimiters, whitespace, and the RFC 3986 sub-delims the signer normalizes)
 * so object keys stay readable.
 */
function encodeKeySegment(value: string): string {
	return value.toLowerCase().replace(/[%+=?#\s!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
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
 * and transport failures. Each attempt gets its own timeout so a hung
 * connection cannot block the handler indefinitely.
 */
async function uploadWithRetry(aws: AwsClient, url: string, body: Uint8Array, label: string): Promise<void> {
	let lastError: UploadError | undefined;

	for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			const backoff = INITIAL_RETRY_MS * 2 ** (attempt - 1);
			await delay(backoff + Math.random() * INITIAL_RETRY_MS);
		}

		let response: Response;
		try {
			response = await aws.fetch(url, {
				method: 'PUT',
				// lib.dom's BodyInit omits ArrayBufferView; the Workers runtime accepts it.
				body: body as unknown as BodyInit,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
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

export default {
	async fetch(_request: Request): Promise<Response> {
		return Response.redirect(REDIRECT_URL, REDIRECT_STATUS);
	},

	async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
		const timeNow = Date.now();
		const rawEmail = await readMessage(message.raw, message.rawSize);

		const compressedEmail = gzipSync(rawEmail, {
			// GZIP-specific: the filename and time to use when decompressed
			filename: `${timeNow}.eml`,
			mtime: timeNow,
			level: 9,
		});

		const { domain } = splitAddress(message.to, 'recipient');
		const { domain: srcDomain } = splitAddress(message.from, 'sender');

		const aws = new AwsClient({
			accessKeyId: env.S3_ACCESS_KEY,
			secretAccessKey: env.S3_ACCESS_SECRET,
			service: 's3',
			region: env.S3_REGION,
			retries: 0,
		});

		const endpoint = `https://${env.S3_BUCKET}.${env.S3_ENDPOINT}/`;
		const filename = `${encodeKeySegment(domain)}/${encodeKeySegment(message.to)}/${encodeKeySegment(srcDomain)}/${timeNow}.eml.gz`;

		await uploadWithRetry(aws, `${endpoint}${filename}`, compressedEmail, endpoint);

		console.log(`Archived ${filename}`);
	},
} satisfies ExportedHandler<Env>;
