import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import worker from '../src/index';
import type { Env } from '../src/index';

const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const PROJECT_URL = 'https://github.com/tweedge/workers-email-archiver';

interface CapturedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: Uint8Array;
}

const ENV: Env = {
	S3_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
	S3_ACCESS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	S3_REGION: 'VA-SSD',
	S3_BUCKET: 'archive-bucket',
	S3_ENDPOINT: 'p2v3.va.idrivee2-43.com',
};

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

/** Captures the promises handed to waitUntil so tests can settle them. */
interface Background {
	readonly promises: Promise<unknown>[];
}

function makeContext(background: Background = { promises: [] }): ExecutionContext {
	return {
		waitUntil: (promise: Promise<unknown>) => {
			background.promises.push(promise);
		},
		passThroughOnException: vi.fn(),
		props: {},
	} as unknown as ExecutionContext;
}

/** Runs the handler, then waits for all background work it scheduled. */
async function runEmail(message: ForwardableEmailMessage, env: Env = ENV): Promise<{ background: Background; errors: unknown[] }> {
	const background: Background = { promises: [] };
	await worker.email(message, env, makeContext(background));

	const errors: unknown[] = [];
	await Promise.all(
		background.promises.map((promise) =>
			promise.catch((error: unknown) => {
				errors.push(error);
			}),
		),
	);
	return { background, errors };
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

describe('worker module', () => {
	it('exposes a default export with fetch and email handlers only', () => {
		expect(typeof worker.fetch).toBe('function');
		expect(typeof worker.email).toBe('function');
		expect('queue' in worker).toBe(false);
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
	});
});

describe('email handler', () => {
	it('returns without waiting for the upload and schedules it in waitUntil', async () => {
		const background: Background = { promises: [] };

		await worker.email(makeMessage({}), ENV, makeContext(background));

		// The handler resolved without touching the network: the upload promise
		// is only scheduled, which is what lets the SMTP session close early.
		expect(background.promises).toHaveLength(1);
		expect(captured).toBeUndefined();

		await background.promises[0];
		expect(captured).toBeDefined();
	});

	it('never rejects after the message has been accepted', async () => {
		fetchImpl = async () => new Response('denied', { status: 403 });

		const { background, errors } = await runEmail(makeMessage({}));

		expect(background.promises).toHaveLength(1);
		expect(errors).toHaveLength(0);
	});

	it('assembles a message delivered in multiple chunks byte-for-byte', async () => {
		const tail = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff]);
		const { raw, rawSize } = bodyStream(['Received: from sender.example\r\n', 'Subject: multi-chunk\r\n', '\r\n', tail]);

		await runEmail(makeMessage({ raw, rawSize }));

		expect(Array.from(decompressBody(captured!))).toEqual([
			...Array.from(encoder.encode('Received: from sender.example\r\nSubject: multi-chunk\r\n\r\n')),
			...Array.from(tail),
		]);
	});

	it('handles an empty raw message', async () => {
		const { raw, rawSize } = bodyStream([]);

		await runEmail(makeMessage({ raw, rawSize }));

		expect(decompressBody(captured!).byteLength).toBe(0);
	});

	it('reads exactly the declared rawSize from the stream', async () => {
		const body = encoder.encode('12345');

		await runEmail(makeMessage({ raw: streamOf([body]), rawSize: body.byteLength }));

		expect(decompressBody(captured!)).toEqual(body);
	});

	it('rejects a rawSize larger than the stream contents instead of zero-padding', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: 8 });

		await expect(runEmail(message)).rejects.toThrow('Raw message size mismatch: read 5 bytes but expected 8');
		expect(captured).toBeUndefined();
	});

	it('rejects a rawSize smaller than the stream contents instead of truncating', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: 3 });

		await expect(runEmail(message)).rejects.toThrow('Raw message size mismatch: read 5 bytes but expected 3');
		expect(captured).toBeUndefined();
	});

	it('compresses with the native gzip encoder and embeds filename and mtime', async () => {
		await runEmail(makeMessage({}));

		const header = parseGzipHeader(captured!.body);
		expect(header.id1).toBe(0x1f);
		expect(header.id2).toBe(0x8b);
		expect(header.method).toBe(8);
		expect(header.flags & 0x08).toBe(0x08);
		expect(header.mtime).toBe(NOW_SECONDS);
		expect(header.xfl).toBe(0);
		expect([0, 3, 255]).toContain(header.os);
		expect(header.filename).toBe(`${NOW}.eml`);
		expect(decompressBody(captured!)).toEqual(DEFAULT_BODY);
	});

	it('uses the timestamp as the object key basename', async () => {
		await runEmail(makeMessage({}));

		expect(captured!.url).toBe(
			`https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/example.com/recipient@example.com/sender.example/${NOW}.eml.gz`,
		);
	});

	it('derives the top folder from the recipient domain', async () => {
		await runEmail(makeMessage({ to: 'anything@Example.COM' }));

		expect(objectPath(captured!)).toMatch(/^\/example\.com\//);
	});

	it('derives the bottom folder from the sender domain, not the local part', async () => {
		await runEmail(makeMessage({ from: 'Bounce+abc=def@Mail.Example.COM' }));

		expect(objectPath(captured!)).toMatch(/\/mail\.example\.com\/\d+\.eml\.gz$/);
	});

	it('lowercases the domains and key segments but keeps encoded locals readable', async () => {
		await runEmail(makeMessage({ to: 'User+Tag@ExAmPlE.CoM', from: 'Sender@SENDER.Example' }));

		expect(objectPath(captured!)).toBe(`/example.com/user%2Btag@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('percent-encodes plus and equals so the signature matches the request path', async () => {
		await runEmail(makeMessage({ to: 'a+b=c@example.com' }));

		expect(objectPath(captured!)).toContain('/a%2Bb%3Dc@example.com/');
		expect(objectPath(captured!)).not.toContain('+');
		expect(captured!.headers.get('authorization')).toContain(`/${ENV.S3_REGION}/s3/aws4_request`);
	});

	it('encodes each reserved character that would desync the canonical path', async () => {
		await runEmail(makeMessage({ to: 'a%2Bb?c#d!e(f)g*h@example.com' }));

		expect(objectPath(captured!)).toContain('/a%252bb%3Fc%23d%21e%28f%29g%2Ah@example.com/');
	});

	it('encodes a backslash so it cannot become a path separator', async () => {
		await runEmail(makeMessage({ to: 'a\\b@example.com' }));

		expect(objectPath(captured!)).toContain('/a%5Cb@example.com/');
	});

	it('encodes multi-byte whitespace as valid UTF-8 escapes', async () => {
		await runEmail(makeMessage({ to: 'a\u00a0b@example.com' }));

		expect(objectPath(captured!)).toContain('/a%C2%A0b@example.com/');
	});

	it('does not include the sender local part in the object key', async () => {
		await runEmail(makeMessage({ from: 'local+part=value@Sender.Example' }));

		expect(objectPath(captured!)).not.toContain('local+part');
		expect(objectPath(captured!)).not.toContain('local%2Bpart');
		expect(objectPath(captured!)).toContain('/sender.example/');
	});

	it('sends a signed S3 PUT to the bucket endpoint', async () => {
		await runEmail(makeMessage({}));

		expect(captured!.method).toBe('PUT');
		expect(captured!.url.startsWith(`https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/`)).toBe(true);
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

	it('uploads the compressed bytes as the request body', async () => {
		const body = encoder.encode('Subject: body test\r\n\r\npayload');

		await runEmail(makeMessage({ raw: streamOf([body]), rawSize: body.byteLength }));

		expect(gunzipSync(captured!.body)).toEqual(Buffer.from(body));
	});

	it('logs the archived filename on success', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});

		await runEmail(makeMessage({}));

		expect(info).toHaveBeenCalledWith(`Archived example.com/recipient@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('logs a failure instead of throwing when the upload never succeeds', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});
		fetchImpl = async () => new Response(null, { status: 500 });

		const { errors } = await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(errors).toHaveLength(0);
		expect(info).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			`Upload failed for example.com/recipient@example.com/sender.example/${NOW}.eml.gz: ` +
				`UploadError: Bad status code from https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/: 500`,
		);
	});

	it('retries 5xx responses and succeeds on a later attempt', async () => {
		let attempts = 0;
		fetchImpl = async (request) => {
			attempts += 1;
			if (attempts < 3) return new Response(null, { status: 503 });
			captured = { url: request.url, method: request.method, headers: new Headers(request.headers), body: new Uint8Array() };
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(3);
	});

	it('retries 429 responses', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) return new Response(null, { status: 429 });
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(2);
	});

	it('retries transient network errors and succeeds later', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts < 3) throw new TypeError('network down');
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(3);
	});

	it('retries a timed-out attempt', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(2);
	});

	it('retries an aborted attempt', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(2);
	});

	it('does not retry a non-retryable client error', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			return new Response(null, { status: 403 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(1);
	});

	it('does not retry a non-retryable transport error', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			throw Object.assign(new Error('bad key'), { name: 'InvalidAccessKeyId' });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(1);
	});

	it('retries when a non-Error value is thrown, then reports a generic message', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchImpl = async () => {
			throw 'boom';
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(error).toHaveBeenCalledWith(
			`Upload failed for example.com/recipient@example.com/sender.example/${NOW}.eml.gz: ` +
				`UploadError: Upload to https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/ failed`,
		);
	});

	it('ignores empty stream chunks without changing byte accounting', async () => {
		const body = encoder.encode('payload');
		const message = makeMessage({
			raw: streamOf([new Uint8Array(0), body, new Uint8Array(0)]),
			rawSize: body.byteLength,
		});

		await runEmail(message);

		expect(decompressBody(captured!)).toEqual(body);
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

		await runEmail(makeMessage({ raw, rawSize: body.byteLength }));

		expect(decompressBody(captured!)).toEqual(body);
	});

	it('applies an 8s per-attempt timeout inside a 25s overall budget', async () => {
		const timeouts: number[] = [];
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			timeouts.push(ms);
			return realTimeout(ms);
		});

		await runEmail(makeMessage({}));

		expect(timeouts).toEqual([8_000]);
	});

	it('clamps a later attempt to the remaining overall budget', async () => {
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
				// First attempt consumes ~20s of the 25s budget.
				vi.setSystemTime(new Date(NOW + 20_000));
				return new Response(null, { status: 503 });
			}
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(2);
		expect(timeouts[0]).toBe(8_000);
		expect(timeouts[1]).toBeGreaterThan(0);
		expect(timeouts[1]).toBeLessThan(8_000);
	});

	it('stops retrying once the overall upload budget is exhausted', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			// Simulate each attempt consuming the entire budget.
			vi.setSystemTime(new Date(NOW + 25_000 * attempts));
			return new Response(null, { status: 503 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(1);
	});

	it('makes at most six attempts', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			return new Response(null, { status: 503 });
		};

		await withImmediateRetries(() => runEmail(makeMessage({})));

		expect(attempts).toBe(6);
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

		await runEmail(makeMessage({}));

		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal!.aborted).toBe(false);
		// A default signal from aws4fetch would not react to this controller;
		// propagation proves init.signal reached the signed request.
		controller!.abort(new Error('test abort'));
		expect(signal!.aborted).toBe(true);
	});

	it('rejects before accepting the message when credentials are missing', async () => {
		const env = { ...ENV, S3_ACCESS_KEY: undefined } as unknown as Env;

		await expect(runEmail(makeMessage({}), env)).rejects.toThrow('accessKeyId is a required option');
		expect(captured).toBeUndefined();
	});

	it('rejects a recipient address without a domain', async () => {
		await expect(runEmail(makeMessage({ to: 'nodomain' }))).rejects.toThrow('Invalid recipient address: "nodomain"');
		expect(captured).toBeUndefined();
	});

	it('rejects a sender address without a domain', async () => {
		await expect(runEmail(makeMessage({ from: 'nodomain' }))).rejects.toThrow('Invalid sender address: "nodomain"');
		expect(captured).toBeUndefined();
	});

	it('rejects an address with a trailing @', async () => {
		await expect(runEmail(makeMessage({ to: 'user@' }))).rejects.toThrow('Invalid recipient address: "user@"');
	});

	it('uses the last @ so quoted local parts resolve to the real domain', async () => {
		await runEmail(makeMessage({ to: 'a@b@example.com', from: 'c@d@example.com' }));

		expect(objectPath(captured!)).toBe(`/example.com/a@b@example.com/example.com/${NOW}.eml.gz`);
	});

	it('builds the endpoint from the configured bucket and endpoint', async () => {
		const env: Env = {
			S3_ACCESS_KEY: 'KEY',
			S3_ACCESS_SECRET: 'SECRET',
			S3_REGION: 'us-east-1',
			S3_BUCKET: 'other-bucket',
			S3_ENDPOINT: 's3.amazonaws.com',
		};

		await runEmail(makeMessage({}), env);

		expect(captured!.url.startsWith('https://other-bucket.s3.amazonaws.com/')).toBe(true);
		expect(captured!.headers.get('authorization')).toContain('Credential=KEY/');
		expect(captured!.headers.get('authorization')).toContain('/us-east-1/s3/aws4_request');
	});
});
