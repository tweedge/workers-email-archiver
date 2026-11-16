import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import type { ArchiveMessage } from '../../src/index';

const encoder = new TextEncoder();

const ENV_BASE = {
	S3_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
	S3_ACCESS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	S3_REGION: 'VA-SSD',
	S3_BUCKET: 'archive-bucket',
	S3_ENDPOINT: 'p2v3.va.idrivee2-43.com',
};

function makeEnv(sends: ArchiveMessage[]): Record<string, unknown> {
	return {
		...ENV_BASE,
		ARCHIVE_QUEUE: {
			send: async (message: ArchiveMessage) => {
				sends.push(message);
			},
		},
	};
}

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

	it('compresses an email with the real gzip encoder and queues it', async () => {
		const sends: ArchiveMessage[] = [];
		const body = encoder.encode('Subject: runtime\r\n\r\nhello from workerd');

		await worker.email(
			makeMessage(body),
			makeEnv(sends) as never,
			{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
		);

		expect(sends).toHaveLength(1);
		const queued = sends[0]!;
		expect(queued.key).toMatch(/^example\.com\/user@example\.com\/mail\.example\.com\/\d+\.eml\.gz$/);
		expect(queued.body[0]).toBe(0x1f);
		expect(queued.body[1]).toBe(0x8b);
		expect(queued.body[2]).toBe(8);
		expect((queued.body[3] ?? 0) & 0x08).toBe(0x08);

		const restored = new Uint8Array(
			await new Response(new Response(queued.body as unknown as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
		);
		expect(restored).toEqual(body);
	});

	it('round-trips an empty message', async () => {
		const sends: ArchiveMessage[] = [];

		await worker.email(
			makeMessage(new Uint8Array(0)),
			makeEnv(sends) as never,
			{
				waitUntil() {},
				passThroughOnException() {},
			} as unknown as ExecutionContext,
		);

		const queued = sends[0]!;
		const restored = new Uint8Array(
			await new Response(new Response(queued.body as unknown as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
		);
		expect(restored.byteLength).toBe(0);
	});

	it('round-trips the largest payload we expect to queue', async () => {
		const sends: ArchiveMessage[] = [];
		const body = new Uint8Array(4_000_000);
		for (let i = 0; i < body.length; i += 64) body[i] = i & 0xff;

		await worker.email(
			makeMessage(body),
			makeEnv(sends) as never,
			{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
		);

		const queued = sends[0]!;
		const restored = new Uint8Array(
			await new Response(new Response(queued.body as unknown as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
		);
		expect(restored.byteLength).toBe(body.byteLength);
		expect(restored[0]).toBe(0);
		expect(restored[64]).toBe(64);
	});

	it('consumes a queued message and uploads it to a mocked S3 endpoint', async () => {
		let captured: Request | undefined;
		vi.stubGlobal('fetch', async (request: Request) => {
			captured = request;
			return new Response(null, { status: 200 });
		});
		const payload = new Uint8Array(
			await new Response(
				new Response(encoder.encode('Subject: queued\r\n\r\nhello') as unknown as BodyInit).body!.pipeThrough(
					new CompressionStream('gzip'),
				),
			).arrayBuffer(),
		);
		const acked: string[] = [];

		await worker.queue(
			{
				queue: 'email-archiver-spool',
				messages: [
					{
						id: 'm1',
						timestamp: new Date(),
						body: { key: 'example.com/user@example.com/mail.example.com/1700000000000.eml.gz', body: payload },
						attempts: 1,
						ack: () => acked.push('m1'),
						retry: () => {},
					},
				],
				ackAll: () => {},
				retryAll: () => {},
			} as unknown as MessageBatch<ArchiveMessage>,
			ENV_BASE as never,
			{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
		);

		expect(captured).toBeDefined();
		expect(captured!.method).toBe('PUT');
		expect(captured!.url).toBe(
			'https://archive-bucket.p2v3.va.idrivee2-43.com/example.com/user@example.com/mail.example.com/1700000000000.eml.gz',
		);
		expect((captured!.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256 Credential=')).toBe(true);
		expect(acked).toEqual(['m1']);
		const uploaded = new Uint8Array(await captured!.arrayBuffer());
		expect(uploaded).toEqual(payload);
	});
});
