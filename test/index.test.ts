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

function makeContext(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
		props: {},
	} as unknown as ExecutionContext;
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
	it('exposes a default export with fetch and email handlers', () => {
		expect(typeof worker.fetch).toBe('function');
		expect(typeof worker.email).toBe('function');
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
	it('archives a single-chunk message and returns void', async () => {
		const message = makeMessage({});

		await expect(worker.email(message, ENV, makeContext())).resolves.toBeUndefined();
		expect(captured).toBeDefined();
	});

	it('assembles a message delivered in multiple chunks byte-for-byte', async () => {
		const tail = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff]);
		const { raw, rawSize } = bodyStream(['Received: from sender.example\r\n', 'Subject: multi-chunk\r\n', '\r\n', tail]);
		const message = makeMessage({ raw, rawSize });

		await worker.email(message, ENV, makeContext());

		expect(captured).toBeDefined();
		expect(Array.from(decompressBody(captured!))).toEqual([
			...Array.from(encoder.encode('Received: from sender.example\r\nSubject: multi-chunk\r\n\r\n')),
			...Array.from(tail),
		]);
	});

	it('handles an empty raw message', async () => {
		const { raw, rawSize } = bodyStream([]);
		const message = makeMessage({ raw, rawSize });

		await worker.email(message, ENV, makeContext());

		expect(captured).toBeDefined();
		expect(decompressBody(captured!).byteLength).toBe(0);
	});

	it('reads exactly the declared rawSize from the stream', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: body.byteLength });

		await worker.email(message, ENV, makeContext());

		expect(decompressBody(captured!)).toEqual(body);
	});

	it('rejects a rawSize larger than the stream contents instead of zero-padding', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: 8 });

		await expect(worker.email(message, ENV, makeContext())).rejects.toThrow('Raw message size mismatch: read 5 bytes but expected 8');
		expect(captured).toBeUndefined();
	});

	it('rejects a rawSize smaller than the stream contents instead of truncating', async () => {
		const body = encoder.encode('12345');
		const message = makeMessage({ raw: streamOf([body]), rawSize: 3 });

		await expect(worker.email(message, ENV, makeContext())).rejects.toThrow('Raw message size mismatch: read 5 bytes but expected 3');
		expect(captured).toBeUndefined();
	});

	it('compresses with gzip level 9 and embeds filename and mtime', async () => {
		const message = makeMessage({});

		await worker.email(message, ENV, makeContext());

		const header = parseGzipHeader(captured!.body);
		expect(header.id1).toBe(0x1f);
		expect(header.id2).toBe(0x8b);
		expect(header.method).toBe(8);
		expect(header.flags & 0x08).toBe(0x08);
		expect(header.mtime).toBe(NOW_SECONDS);
		expect(header.xfl).toBe(2);
		expect([0, 3, 255]).toContain(header.os);
		expect(header.filename).toBe(`${NOW}.eml`);
		expect(decompressBody(captured!)).toEqual(DEFAULT_BODY);
	});

	it('uses the timestamp as the object key basename', async () => {
		await worker.email(makeMessage({}), ENV, makeContext());

		expect(captured!.url).toBe(
			`https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/example.com/recipient@example.com/sender.example/${NOW}.eml.gz`,
		);
	});

	it('derives the top folder from the recipient domain', async () => {
		await worker.email(makeMessage({ to: 'anything@Example.COM' }), ENV, makeContext());

		expect(objectPath(captured!)).toMatch(/^\/example\.com\//);
	});

	it('derives the bottom folder from the sender domain, not the local part', async () => {
		await worker.email(makeMessage({ from: 'Bounce+abc=def@Mail.Example.COM' }), ENV, makeContext());

		expect(objectPath(captured!)).toMatch(/\/mail\.example\.com\/\d+\.eml\.gz$/);
	});

	it('lowercases the domains and key segments but keeps encoded locals readable', async () => {
		await worker.email(makeMessage({ to: 'User+Tag@ExAmPlE.CoM', from: 'Sender@SENDER.Example' }), ENV, makeContext());

		expect(objectPath(captured!)).toBe(`/example.com/user%2Btag@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('percent-encodes plus and equals so the signature matches the request path', async () => {
		await worker.email(makeMessage({ to: 'a+b=c@example.com' }), ENV, makeContext());

		expect(objectPath(captured!)).toContain('/a%2Bb%3Dc@example.com/');
		expect(objectPath(captured!)).not.toContain('+');
		expect(captured!.headers.get('authorization')).toContain(`/${ENV.S3_REGION}/s3/aws4_request`);
	});

	it('encodes each reserved character that would desync the canonical path', async () => {
		await worker.email(makeMessage({ to: 'a%2Bb?c#d!e(f)g*h@example.com' }), ENV, makeContext());

		expect(objectPath(captured!)).toContain('/a%252bb%3Fc%23d%21e%28f%29g%2Ah@example.com/');
	});

	it('does not include the sender local part in the object key', async () => {
		await worker.email(makeMessage({ from: 'local+part=value@Sender.Example' }), ENV, makeContext());

		expect(objectPath(captured!)).not.toContain('local+part');
		expect(objectPath(captured!)).not.toContain('local%2Bpart');
		expect(objectPath(captured!)).toContain('/sender.example/');
	});

	it('sends a signed S3 PUT to the bucket endpoint', async () => {
		await worker.email(makeMessage({}), ENV, makeContext());

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
		const message = makeMessage({ raw: streamOf([body]), rawSize: body.byteLength });

		await worker.email(message, ENV, makeContext());

		expect(gunzipSync(captured!.body)).toEqual(Buffer.from(body));
	});

	it('logs the archived filename on success', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});

		await worker.email(makeMessage({}), ENV, makeContext());

		expect(info).toHaveBeenCalledWith(`Archived example.com/recipient@example.com/sender.example/${NOW}.eml.gz`);
	});

	it('does not log when the upload fails', async () => {
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});
		fetchImpl = async () => new Response('denied', { status: 403 });

		await expect(worker.email(makeMessage({}), ENV, makeContext())).rejects.toThrow();
		expect(info).not.toHaveBeenCalled();
	});

	it('throws a descriptive error for a non-2xx upload response', async () => {
		fetchImpl = async () => new Response(null, { status: 403 });

		await expect(worker.email(makeMessage({}), ENV, makeContext())).rejects.toThrow(
			`Bad status code from https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/: 403`,
		);
	});

	it('does not retry client errors', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			return new Response(null, { status: 403 });
		};

		await expect(worker.email(makeMessage({}), ENV, makeContext())).rejects.toThrow(/Bad status code/);
		expect(attempts).toBe(1);
	});

	it('throws for a 500 response once retries are exhausted', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			return new Response(null, { status: 500 });
		};

		await expect(withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()))).rejects.toThrow(/Bad status code/);
		expect(attempts).toBe(4);
	});

	it('retries 5xx responses and succeeds on a later attempt', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts < 3) return new Response(null, { status: 503 });
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()));

		expect(attempts).toBe(3);
	});

	it('retries 429 responses', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) return new Response(null, { status: 429 });
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()));

		expect(attempts).toBe(2);
	});

	it('retries transient network errors and succeeds later', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts < 3) throw new TypeError('network down');
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()));

		expect(attempts).toBe(3);
	});

	it('throws after retries are exhausted on persistent network errors', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			throw new TypeError('network down');
		};

		await expect(withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()))).rejects.toThrow(/network down/);
		expect(attempts).toBe(4);
	});

	it('retries when a non-Error value is thrown, then fails with a generic message', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			throw 'boom';
		};

		await expect(withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()))).rejects.toThrow(
			`Upload to https://${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/ failed`,
		);
		expect(attempts).toBe(4);
	});

	it('ignores empty stream chunks without changing byte accounting', async () => {
		const body = encoder.encode('payload');
		const message = makeMessage({
			raw: streamOf([new Uint8Array(0), body, new Uint8Array(0)]),
			rawSize: body.byteLength,
		});

		await worker.email(message, ENV, makeContext());

		expect(decompressBody(captured!)).toEqual(body);
	});

	it('applies an 8s per-attempt timeout inside a 20s overall budget', async () => {
		const timeouts: number[] = [];
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			timeouts.push(ms);
			return realTimeout(ms);
		});

		await worker.email(makeMessage({}), ENV, makeContext());

		expect(timeouts).toEqual([8_000]);
	});

	it('stops retrying once the overall upload budget is exhausted', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			// Simulate each attempt consuming the entire budget.
			vi.setSystemTime(new Date(NOW + 20_000 * attempts));
			return new Response(null, { status: 503 });
		};

		await expect(withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()))).rejects.toThrow(/Bad status code/);
		expect(attempts).toBe(1);
	});

	it('passes an abort signal so a hung upload cannot block forever', async () => {
		let signal: AbortSignal | undefined;
		fetchImpl = async (request) => {
			signal = request.signal;
			return new Response(null, { status: 200 });
		};

		await worker.email(makeMessage({}), ENV, makeContext());

		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal!.aborted).toBe(false);
	});

	it('retries a timed-out attempt', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
			return new Response(null, { status: 200 });
		};

		await withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()));

		expect(attempts).toBe(2);
	});

	it('does not retry a non-retryable error', async () => {
		let attempts = 0;
		fetchImpl = async () => {
			attempts += 1;
			throw Object.assign(new Error('bad key'), { name: 'InvalidAccessKeyId' });
		};

		await expect(withImmediateRetries(() => worker.email(makeMessage({}), ENV, makeContext()))).rejects.toThrow(/bad key/);
		expect(attempts).toBe(1);
	});

	it('fails before uploading when credentials are missing', async () => {
		const env = { ...ENV, S3_ACCESS_KEY: undefined } as unknown as Env;

		await expect(worker.email(makeMessage({}), env, makeContext())).rejects.toThrow(TypeError);
		expect(captured).toBeUndefined();
	});

	it('rejects a recipient address without a domain', async () => {
		await expect(worker.email(makeMessage({ to: 'nodomain' }), ENV, makeContext())).rejects.toThrow(
			'Invalid recipient address: "nodomain"',
		);
		expect(captured).toBeUndefined();
	});

	it('rejects a sender address without a domain', async () => {
		await expect(worker.email(makeMessage({ from: 'nodomain' }), ENV, makeContext())).rejects.toThrow('Invalid sender address: "nodomain"');
		expect(captured).toBeUndefined();
	});

	it('rejects an address with a trailing @', async () => {
		await expect(worker.email(makeMessage({ to: 'user@' }), ENV, makeContext())).rejects.toThrow('Invalid recipient address: "user@"');
	});

	it('uses the last @ so quoted local parts resolve to the real domain', async () => {
		await worker.email(makeMessage({ to: 'a@b@example.com', from: 'c@d@example.com' }), ENV, makeContext());

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

		await worker.email(makeMessage({}), env, makeContext());

		expect(captured!.url.startsWith('https://other-bucket.s3.amazonaws.com/')).toBe(true);
		expect(captured!.headers.get('authorization')).toContain('Credential=KEY/');
		expect(captured!.headers.get('authorization')).toContain('/us-east-1/s3/aws4_request');
	});
});
