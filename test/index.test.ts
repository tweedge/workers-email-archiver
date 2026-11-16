import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import worker from '../src/index';
import type { ArchiveMessage, Env } from '../src/index';

const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const PROJECT_URL = 'https://github.com/tweedge/workers-email-archiver';
const MAX_QUEUED_PAYLOAD_BYTES = 120_000;

interface CapturedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: Uint8Array;
}

interface QueuedMessage {
	readonly key: string;
	readonly body: Uint8Array;
	readonly contentType: string | undefined;
}

const BASE_ENV = {
	S3_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
	S3_ACCESS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	S3_REGION: 'VA-SSD',
	S3_BUCKET: 'archive-bucket',
	S3_ENDPOINT: 'p2v3.va.idrivee2-43.com',
} as const;

const encoder = new TextEncoder();
const DEFAULT_BODY = encoder.encode('Subject: test\r\n\r\nhello');

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function makeMessage(overrides: {
	raw?: ReadableStream<Uint8Array>;
	rawSize?: number;
	to?: string;
	from?: string;
}): ForwardableEmailMessage {
	const raw = overrides.raw ?? streamOf([DEFAULT_BODY]);
	return {
		raw,
		rawSize: overrides.rawSize ?? DEFAULT_BODY.byteLength,
		to: overrides.to ?? 'recipient@example.com',
		from: overrides.from ?? 'sender@sender.example',
		headers: new Headers(),
		setReject: vi.fn(),
		forward: vi.fn(),
		reply: vi.fn(),
	} as unknown as ForwardableEmailMessage;
}

function makeContext(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
		props: {},
	} as unknown as ExecutionContext;
}

interface FakeQueue {
	readonly sends: QueuedMessage[];
	failWith: Error | undefined;
}

let queue: FakeQueue;

function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		...BASE_ENV,
		ARCHIVE_QUEUE: {
			send: async (message: ArchiveMessage, options?: QueueSendOptions) => {
				if (queue.failWith) throw queue.failWith;
				queue.sends.push({ key: message.key, body: message.body, contentType: options?.contentType });
			},
		},
		...overrides,
	} as unknown as Env;
}

function bodyStream(chunks: readonly (string | Uint8Array)[]): {
	raw: ReadableStream<Uint8Array>;
	rawSize: number;
} {
	let rawSize = 0;
	const bytes = chunks.map((chunk) => {
		const value = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
		rawSize += value.byteLength;
		return value;
	});
	return { raw: streamOf(bytes), rawSize };
}

let captured: CapturedRequest | undefined;
let fetchImpl: (request: Request) => Promise<Response>;

async function withImmediateRetries<T>(fn: () => Promise<T>): Promise<T> {
	const realSetTimeout = globalThis.setTimeout;
	vi.stubGlobal('setTimeout', (callback: () => void) => {
		queueMicrotask(callback);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	});
	try {
		return await fn();
	} finally {
		vi.stubGlobal('setTimeout', realSetTimeout);
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	captured = undefined;
	queue = { sends: [], failWith: undefined };
	fetchImpl = async (request) => {
		captured = {
			url: request.url,
			method: request.method,
			headers: new Headers(request.headers),
			body: new Uint8Array(await request.arrayBuffer()),
		};
		return new Response(null, { status: 200 });
	};
	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		if (!(input instanceof Request)) throw new TypeError('Expected a Request instance');
		return fetchImpl(input);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

interface GzipHeader {
	readonly id1: number;
	readonly id2: number;
	readonly method: number;
	readonly flags: number;
	readonly mtime: number;
	readonly xfl: number;
	readonly os: number;
	readonly filename: string | undefined;
}

function parseGzipHeader(data: Uint8Array): GzipHeader {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const flags = data[3] ?? 0;
	let offset = 10;
	let filename: string | undefined;
	if ((flags & 0x08) !== 0) {
		const bytes: number[] = [];
		while (offset < data.length && data[offset] !== 0) {
			bytes.push(data[offset] ?? 0);
			offset += 1;
		}
		filename = new TextDecoder().decode(Uint8Array.from(bytes));
	}
	return {
		id1: data[0] ?? -1,
		id2: data[1] ?? -1,
		method: data[2] ?? -1,
		flags,
		mtime: view.getUint32(4, true),
		xfl: data[8] ?? -1,
		os: data[9] ?? -1,
		filename,
	};
}

function decompressBody(entry: CapturedRequest): Uint8Array {
	return new Uint8Array(gunzipSync(entry.body));
}

function objectPath(entry: CapturedRequest): string {
	return new URL(entry.url).pathname;
}

function decompressQueued(entry: QueuedMessage): Uint8Array {
	return new Uint8Array(gunzipSync(entry.body));
}

function onlySend(): QueuedMessage {
	expect(queue.sends).toHaveLength(1);
	return queue.sends[0]!;
}

/** Incompressible body that gzips to more than the queue payload limit. */
function oversizedBody(size = 200_000): Uint8Array {
	return new Uint8Array(randomBytes(size));
}

function archiveMessage(overrides: Partial<ArchiveMessage> = {}): ArchiveMessage {
	return {
		key: 'example.com/recipient@example.com/sender.example/1700000000000.eml.gz',
		body: new Uint8Array(gzipSync(encoder.encode('Subject: queued\r\n\r\nbody'))),
		...overrides,
	};
}

interface FakeMessage {
	readonly body: ArchiveMessage;
	readonly attempts: number;
	readonly ack: ReturnType<typeof vi.fn>;
	readonly retry: ReturnType<typeof vi.fn>;
}

function makeQueueMessage(body: ArchiveMessage, attempts = 1): FakeMessage {
	return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function makeBatch(messages: readonly FakeMessage[]): MessageBatch<ArchiveMessage> {
	return {
		queue: 'email-archiver-spool',
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<ArchiveMessage>;
}

describe('worker module', () => {
	it('exposes a default export with fetch, email, and queue handlers', () => {
		expect(typeof worker.fetch).toBe('function');
		expect(typeof worker.email).toBe('function');
		expect(typeof worker.queue).toBe('function');
	});
});

describe('fetch handler', () => {
	it('redirects to the project URL with a permanent 307', async () => {
		const response = await worker.fetch(new Request('https://archive.example/anything'));
		expect(response.status).toBe(307);
		expect(response.headers.get('location')).toBe(PROJECT_URL);
	});

	it('redirects regardless of path, method, or body', async () => {
		const response = await worker.fetch(new Request('https://archive.example/some/deep/path?query=1', { method: 'POST', body: 'payload' }));
		expect(response.status).toBe(307);
		expect(response.headers.get('location')).toBe(PROJECT_URL);
	});

	it('does not perform any network upload for a browser request', async () => {
		await worker.fetch(new Request('https://archive.example/'));
		expect(captured).toBeUndefined();
		expect(queue.sends).toHaveLength(0);
	});
});

describe('email handler', () => {
	it('enqueues a message instead of uploading it inline', async () => {
		await expect(worker.email(makeMessage({}), makeEnv(), makeContext())).resolves.toBeUndefined();

		expect(queue.sends).toHaveLength(1);
		expect(captured).toBeUndefined();
	});

	it('queues the payload with the v8 content type so raw bytes survive', async () => {
		await worker.email(makeMessage({}), makeEnv(), makeContext());

		expect(onlySend().contentType).toBe('v8');
		expect(onlySend().body).toBeInstanceOf(Uint8Array);
	});

	it('assembles a message delivered in multiple chunks byte-for-byte', async () => {
		const tail = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff]);
		const { raw, rawSize } = bodyStream(['Received: from sender.example\r\n', 'Subject: multi-chunk\r\n', '\r\n', tail]);
		const message = makeMessage({ raw, rawSize });

		await worker.email(message, makeEnv(), makeContext());

		expect(Array.from(decompressQueued(onlySend()))).toEqual([
			...Array.from(encoder.encode('Received: from sender.example\r\nSubject: multi-chunk\r\n\r\n')),
			...Array.from(tail),
		]);
	});

	it('handles an empty raw message', async () => {
		const { raw, rawSize } = bodyStream([]);
		const message = makeMessage({ raw, rawSize });

		await worker.email(message, makeEnv(), makeContext());

		expect(decompressQueued(onlySend()).byteLength).toBe(0);
	});

	it('reads exactly the declared rawSize from the stream', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: body.byteLength });

		await worker.email(message, makeEnv(), makeContext());

		expect(decompressQueued(onlySend())).toEqual(body);
	});

	it('rejects a rawSize larger than the stream contents instead of zero-padding', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: 8 });

		await expect(worker.email(message, makeEnv(), makeContext())).rejects.toThrow('Raw message size mismatch: read 5 bytes but expected 8');
		expect(queue.sends).toHaveLength(0);
	});

	it('rejects a rawSize smaller than the stream contents instead of truncating', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: 3 });

		await expect(worker.email(message, makeEnv(), makeContext())).rejects.toThrow('Raw message size mismatch: read 5 bytes but expected 3');
		expect(queue.sends).toHaveLength(0);
	});

	it('compresses with the native gzip encoder and embeds filename and mtime', async () => {
		await worker.email(makeMessage({}), makeEnv(), makeContext());

		const header = parseGzipHeader(onlySend().body);
		expect(header.id1).toBe(0x1f);
		expect(header.id2).toBe(0x8b);
		expect(header.method).toBe(8);
		expect(header.flags & 0x08).toBe(0x08);
		expect(header.mtime).toBe(NOW_SECONDS);
		expect(header.xfl).toBe(0);
		expect([0, 3, 255]).toContain(header.os);
		expect(header.filename).toBe(`${NOW}.eml`);
		expect(decompressQueued(onlySend())).toEqual(DEFAULT_BODY);
	});

	it('uses the timestamp as the object key basename', async () => {
		await worker.email(makeMessage({}), makeEnv(), makeContext());

		expect(onlySend().key).toBe(`example.com/recipient@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('derives the top folder from the recipient domain', async () => {
		await worker.email(makeMessage({ to: 'anything@Example.COM' }), makeEnv(), makeContext());

		expect(onlySend().key).toMatch(/^example\.com\//);
	});

	it('derives the bottom folder from the sender domain, not the local part', async () => {
		await worker.email(makeMessage({ from: 'Bounce+abc=def@Mail.Example.COM' }), makeEnv(), makeContext());

		expect(onlySend().key).toMatch(/\/mail\.example\.com\/\d+\.eml\.gz$/);
	});

	it('lowercases the domains and key segments but keeps encoded locals readable', async () => {
		await worker.email(makeMessage({ to: 'User+Tag@ExAmPlE.CoM', from: 'Sender@SENDER.Example' }), makeEnv(), makeContext());

		expect(onlySend().key).toBe(`example.com/user%2Btag@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('percent-encodes plus and equals so the signature matches the request path', async () => {
		await worker.email(makeMessage({ to: 'a+b=c@example.com' }), makeEnv(), makeContext());

		expect(onlySend().key).toContain('/a%2Bb%3Dc@example.com/');
		expect(onlySend().key).not.toContain('+');
	});

	it('encodes each reserved character that would desync the canonical path', async () => {
		await worker.email(makeMessage({ to: 'a%2Bb?c#d!e(f)g*h@example.com' }), makeEnv(), makeContext());

		expect(onlySend().key).toContain('/a%252bb%3Fc%23d%21e%28f%29g%2Ah@example.com/');
	});

	it('encodes a backslash so it cannot become a path separator', async () => {
		await worker.email(makeMessage({ to: 'a\\b@example.com' }), makeEnv(), makeContext());

		expect(onlySend().key).toContain('/a%5Cb@example.com/');
	});

	it('encodes multi-byte whitespace as valid UTF-8 escapes', async () => {
		await worker.email(makeMessage({ to: 'a\u00a0b@example.com' }), makeEnv(), makeContext());

		expect(onlySend().key).toContain('/a%C2%A0b@example.com/');
	});

	it('does not include the sender local part in the object key', async () => {
		await worker.email(makeMessage({ from: 'local+part=value@Sender.Example' }), makeEnv(), makeContext());

		expect(onlySend().key).not.toContain('local+part');
		expect(onlySend().key).not.toContain('local%2Bpart');
		expect(onlySend().key).toContain('/sender.example/');
	});

	it('logs the queued key on success', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});

		await worker.email(makeMessage({}), makeEnv(), makeContext());

		expect(info).toHaveBeenCalledWith(`Queued example.com/recipient@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('uploads inline when the compressed payload cannot fit a queue message', async () => {
		const body = oversizedBody();
		const message = makeMessage({ raw: streamOf([body]), rawSize: body.byteLength });

		await worker.email(message, makeEnv(), makeContext());

		expect(queue.sends).toHaveLength(0);
		expect(captured).toBeDefined();
		expect(captured!.method).toBe('PUT');
		expect(captured!.body.byteLength).toBeGreaterThan(MAX_QUEUED_PAYLOAD_BYTES);
		expect(new Uint8Array(gunzipSync(captured!.body))).toEqual(body);
	});

	it('logs the archived key when uploading inline', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});
		const body = oversizedBody();

		await worker.email(makeMessage({ raw: streamOf([body]), rawSize: body.byteLength }), makeEnv(), makeContext());

		expect(info).toHaveBeenCalledWith(`Archived example.com/recipient@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('throws when the inline upload of an oversized message fails', async () => {
		fetchImpl = async () => new Response(null, { status: 403 });

		const body = oversizedBody();
		await expect(worker.email(makeMessage({ raw: streamOf([body]), rawSize: body.byteLength }), makeEnv(), makeContext())).rejects.toThrow(
			/Bad status code/,
		);
	});

	it('propagates a queue send failure so the sender learns the archive missed', async () => {
		queue.failWith = new Error('queue unavailable');

		await expect(worker.email(makeMessage({}), makeEnv(), makeContext())).rejects.toThrow('queue unavailable');
	});

	it('rejects a recipient address without a domain', async () => {
		await expect(worker.email(makeMessage({ to: 'nodomain' }), makeEnv(), makeContext())).rejects.toThrow(
			'Invalid recipient address: "nodomain"',
		);
		expect(queue.sends).toHaveLength(0);
	});

	it('rejects a sender address without a domain', async () => {
		await expect(worker.email(makeMessage({ from: 'nodomain' }), makeEnv(), makeContext())).rejects.toThrow(
			'Invalid sender address: "nodomain"',
		);
		expect(queue.sends).toHaveLength(0);
	});

	it('rejects an address with a trailing @', async () => {
		await expect(worker.email(makeMessage({ to: 'user@' }), makeEnv(), makeContext())).rejects.toThrow(
			'Invalid recipient address: "user@"',
		);
	});

	it('uses the last @ so quoted local parts resolve to the real domain', async () => {
		await worker.email(makeMessage({ to: 'a@b@example.com', from: 'c@d@example.com' }), makeEnv(), makeContext());

		expect(onlySend().key).toBe(`example.com/a@b@example.com/example.com/${NOW}.eml.gz`);
	});
});

describe('queue consumer', () => {
	it('uploads a queued message and acknowledges it', async () => {
		const message = makeQueueMessage(archiveMessage());

		await worker.queue(makeBatch([message]), makeEnv(), makeContext());

		expect(captured).toBeDefined();
		expect(captured!.method).toBe('PUT');
		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
	});

	it('uploads to the key from the queue message', async () => {
		const message = makeQueueMessage(archiveMessage());

		await worker.queue(makeBatch([message]), makeEnv(), makeContext());

		expect(objectPath(captured!)).toBe('/example.com/recipient@example.com/sender.example/1700000000000.eml.gz');
	});

	it('sends a signed S3 PUT to the bucket endpoint', async () => {
		await worker.queue(makeBatch([makeQueueMessage(archiveMessage())]), makeEnv(), makeContext());

		expect(captured!.url.startsWith(`https://${BASE_ENV.S3_BUCKET}.${BASE_ENV.S3_ENDPOINT}/`)).toBe(true);
		expect(captured!.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
		const authorization = captured!.headers.get('authorization') ?? '';
		expect(authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/VA-SSD\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
		);
		expect(authorization).toContain('host');
		expect(authorization).toContain('x-amz-content-sha256');
		expect(authorization).toContain('x-amz-date');
		expect(captured!.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
	});

	it('uploads the queued bytes unchanged', async () => {
		const payload = new Uint8Array(gzipSync(encoder.encode('Subject: body test\r\n\r\npayload')));
		await worker.queue(makeBatch([makeQueueMessage(archiveMessage({ body: payload }))]), makeEnv(), makeContext());

		expect(captured!.body).toEqual(payload);
		expect(new Uint8Array(gunzipSync(captured!.body))).toEqual(encoder.encode('Subject: body test\r\n\r\npayload'));
	});

	it('builds the endpoint from the configured bucket and endpoint', async () => {
		const env = makeEnv({
			S3_ACCESS_KEY: 'KEY',
			S3_ACCESS_SECRET: 'SECRET',
			S3_REGION: 'us-east-1',
			S3_BUCKET: 'other-bucket',
			S3_ENDPOINT: 's3.amazonaws.com',
		});

		await worker.queue(makeBatch([makeQueueMessage(archiveMessage())]), env, makeContext());

		expect(captured!.url.startsWith('https://other-bucket.s3.amazonaws.com/')).toBe(true);
		expect(captured!.headers.get('authorization')).toContain('Credential=KEY/');
		expect(captured!.headers.get('authorization')).toContain('/us-east-1/s3/aws4_request');
	});

	it('logs the archived key on success', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});

		await worker.queue(makeBatch([makeQueueMessage(archiveMessage())]), makeEnv(), makeContext());

		expect(info).toHaveBeenCalledWith('Archived example.com/recipient@example.com/sender.example/1700000000000.eml.gz');
	});

	it('retries without acknowledging when the upload fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchImpl = async () => new Response(null, { status: 403 });
		const message = makeQueueMessage(archiveMessage());

		await worker.queue(makeBatch([message]), makeEnv(), makeContext());

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
		expect(error).toHaveBeenCalledWith(
			'Retrying example.com/recipient@example.com/sender.example/1700000000000.eml.gz (attempt 1): ' +
				`UploadError: Bad status code from https://${BASE_ENV.S3_BUCKET}.${BASE_ENV.S3_ENDPOINT}/: 403`,
		);
	});

	it('backs off exponentially with the attempt count and caps at an hour', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchImpl = async () => new Response(null, { status: 500 });
		const message = makeQueueMessage(archiveMessage(), 20);

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 3_600 });
	});

	it('tolerates a reader that yields undefined chunks', async () => {
		const body = encoder.encode('payload');
		const raw = {
			getReader: () => {
				const chunks: (Uint8Array | undefined)[] = [undefined, body];
				return {
					read: async () => (chunks.length > 0 ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
					releaseLock: () => {},
				};
			},
		} as unknown as ReadableStream<Uint8Array>;
		const message = makeMessage({ raw, rawSize: body.byteLength });

		await worker.email(message, makeEnv(), makeContext());

		expect(decompressQueued(onlySend())).toEqual(body);
	});

	it('logs the wrapped error for a non-Error failure in the retry log', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchImpl = async () => {
			throw 'boom';
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(message.retry).toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			`Retrying example.com/recipient@example.com/sender.example/1700000000000.eml.gz (attempt 1): ` +
				`UploadError: Upload to https://${BASE_ENV.S3_BUCKET}.${BASE_ENV.S3_ENDPOINT}/ failed`,
		);
	});

	it('retries 5xx responses and acknowledges once one succeeds', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts < 3) return new Response(null, { status: 503 });
			return new Response(null, { status: 200 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(3);
		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
	});

	it('retries 429 responses', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) return new Response(null, { status: 429 });
			return new Response(null, { status: 200 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(2);
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it('retries transient network errors', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts < 3) throw new TypeError('network down');
			return new Response(null, { status: 200 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(3);
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it('retries a timed-out attempt', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
			return new Response(null, { status: 200 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(2);
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it('retries an aborted attempt', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			return new Response(null, { status: 200 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(2);
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it('does not retry a non-retryable upload error inside the attempt loop', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			throw Object.assign(new Error('bad key'), { name: 'InvalidAccessKeyId' });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(1);
		expect(message.retry).toHaveBeenCalled();
	});

	it('uses a 10s per-attempt timeout inside a 30s budget', async () => {
		const timeouts: number[] = [];
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			timeouts.push(ms);
			return realTimeout(ms);
		});

		await worker.queue(makeBatch([makeQueueMessage(archiveMessage())]), makeEnv(), makeContext());

		expect(timeouts).toEqual([10_000]);
	});

	it('clamps a later attempt to the remaining budget', async () => {
		const timeouts: number[] = [];
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			timeouts.push(ms);
			return realTimeout(ms);
		});
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) {
				vi.setSystemTime(new Date(NOW + 25_000));
				return new Response(null, { status: 503 });
			}
			return new Response(null, { status: 200 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(2);
		expect(timeouts[0]).toBe(10_000);
		expect(timeouts[1]).toBeGreaterThan(0);
		expect(timeouts[1]).toBeLessThan(10_000);
	});

	it('stops retrying once the budget is exhausted', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			vi.setSystemTime(new Date(NOW + 30_000 * attempts));
			return new Response(null, { status: 503 });
		};
		const message = makeQueueMessage(archiveMessage());

		await withImmediateRetries(() => worker.queue(makeBatch([message]), makeEnv(), makeContext()));

		expect(attempts).toBe(1);
		expect(message.retry).toHaveBeenCalled();
	});

	it('forwards the abort signal to the upload request', async () => {
		let signal: AbortSignal | undefined;
		let controller: AbortController | undefined;
		vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
			controller = new AbortController();
			return controller.signal;
		});
		fetchImpl = async (request) => {
			signal = request.signal;
			return new Response(null, { status: 200 });
		};

		await worker.queue(makeBatch([makeQueueMessage(archiveMessage())]), makeEnv(), makeContext());

		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal!.aborted).toBe(false);
		controller!.abort(new Error('test abort'));
		expect(signal!.aborted).toBe(true);
	});

	it('retries a message whose credentials are missing', async () => {
		const env = makeEnv({ S3_ACCESS_KEY: undefined } as unknown as Partial<Env>);
		const message = makeQueueMessage(archiveMessage());

		await worker.queue(makeBatch([message]), env, makeContext());

		expect(captured).toBeUndefined();
		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalled();
	});

	it('handles a batch where one message fails and another succeeds', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const failing = makeQueueMessage(archiveMessage({ key: 'a.example/x@a.example/y.example/1.eml.gz' }));
		const succeeding = makeQueueMessage(archiveMessage({ key: 'b.example/x@b.example/y.example/2.eml.gz' }));
		fetchImpl = async (request) => {
			if (new URL(request.url).pathname.startsWith('/a.example/')) return new Response(null, { status: 403 });
			return new Response(null, { status: 200 });
		};

		await worker.queue(makeBatch([failing, succeeding]), makeEnv(), makeContext());

		expect(failing.ack).not.toHaveBeenCalled();
		expect(failing.retry).toHaveBeenCalled();
		expect(succeeding.ack).toHaveBeenCalledTimes(1);
		expect(succeeding.retry).not.toHaveBeenCalled();
	});
});
