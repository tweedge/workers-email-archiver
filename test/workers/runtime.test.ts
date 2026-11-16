import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';

const encoder = new TextEncoder();

const ENV_BASE = {
	S3_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
	S3_ACCESS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	S3_REGION: 'VA-SSD',
	S3_BUCKET: 'archive-bucket',
	S3_ENDPOINT: 'p2v3.va.idrivee2-43.com',
};

function makeMessage(body: Uint8Array): ForwardableEmailMessage {
	const raw = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
	return {
		raw,
		rawSize: body.byteLength,
		to: 'User@Example.com',
		from: 'Sender@Mail.Example.com',
		headers: new Headers(),
		setReject: () => {},
		forward: async () => ({ messageId: '' }),
		reply: async () => ({ messageId: '' }),
	} as unknown as ForwardableEmailMessage;
}

/** Collects waitUntil promises so the test can await the background upload. */
function makeContext(promises: Promise<unknown>[]): ExecutionContext {
	return {
		waitUntil: (promise: Promise<unknown>) => {
			promises.push(promise);
		},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
}

async function archive(body: Uint8Array, onRequest: (request: Request) => Promise<Response>): Promise<Request> {
	let captured: Request | undefined;
	vi.stubGlobal('fetch', async (request: Request) => {
		captured = request;
		return onRequest(request);
	});

	const promises: Promise<unknown>[] = [];
	await worker.email(makeMessage(body), ENV_BASE as never, makeContext(promises));
	await Promise.all(promises);

	expect(captured).toBeDefined();
	return captured!;
}

async function inflate(request: Request): Promise<Uint8Array> {
	const uploaded = new Uint8Array(await request.arrayBuffer());
	return new Uint8Array(
		await new Response(new Response(uploaded as unknown as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('workers runtime', () => {
	it('can redirect a fetch request', async () => {
		const response = await worker.fetch(new Request('https://archive.example/'));
		expect(response.status).toBe(307);
		expect(response.headers.get('location')).toBe('https://github.com/tweedge/workers-email-archiver');
	});

	it('archives an email through a signed PUT to a mocked S3 endpoint', async () => {
		const body = encoder.encode('Subject: runtime\r\n\r\nhello from workerd');

		const request = await archive(body, async () => new Response(null, { status: 200 }));

		expect(request.method).toBe('PUT');
		expect(request.url).toMatch(
			/^https:\/\/archive-bucket\.p2v3\.va\.idrivee2-43\.com\/example\.com\/user@example\.com\/mail\.example\.com\/\d+\.eml\.gz$/,
		);
		const authorization = request.headers.get('authorization') ?? '';
		expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
		expect(request.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');

		const uploaded = new Uint8Array(await request.clone().arrayBuffer());
		expect(uploaded.byteLength).toBeGreaterThan(0);
		expect(uploaded[0]).toBe(0x1f);
		expect(uploaded[1]).toBe(0x8b);
		expect(uploaded[2]).toBe(8);
		expect((uploaded[3] ?? 0) & 0x08).toBe(0x08);
		expect(new DataView(uploaded.buffer, uploaded.byteOffset, uploaded.byteLength).getUint32(4, true)).toBeGreaterThan(0);

		expect(await inflate(request)).toEqual(body);
	});

	it('round-trips an empty message', async () => {
		const request = await archive(new Uint8Array(0), async () => new Response(null, { status: 200 }));

		expect((await inflate(request)).byteLength).toBe(0);
	});

	it('round-trips the largest payload we expect to archive', async () => {
		const body = new Uint8Array(4_000_000);
		for (let i = 0; i < body.length; i += 64) body[i] = i & 0xff;

		const request = await archive(body, async () => new Response(null, { status: 200 }));

		const restored = await inflate(request);
		expect(restored.byteLength).toBe(body.byteLength);
		expect(restored[0]).toBe(0);
		expect(restored[64]).toBe(64);
	});

	it('does not reject the email when the upload fails', async () => {
		const body = encoder.encode('Subject: failing\r\n\r\nbody');
		let attempts = 0;
		let captured: Request | undefined;
		vi.stubGlobal('fetch', async (request: Request) => {
			captured = request;
			attempts += 1;
			return new Response(null, { status: 403 });
		});
		const promises: Promise<unknown>[] = [];

		const result = worker.email(makeMessage(body), ENV_BASE as never, makeContext(promises));

		await expect(result).resolves.toBeUndefined();
		await Promise.all(promises);

		expect(captured).toBeDefined();
		expect(attempts).toBe(1);
	});
});
