import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index.js';

const encoder = new TextEncoder();

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
		let captured: Request | undefined;
		vi.stubGlobal('fetch', async (request: Request) => {
			captured = request;
			return new Response(null, { status: 200 });
		});
		const body = encoder.encode('Subject: runtime\r\n\r\nhello from workerd');
		const raw = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(body);
				controller.close();
			},
		});

		const message = {
			raw,
			rawSize: body.byteLength,
			to: 'User@Example.com',
			from: 'Sender@Mail.Example.com',
			headers: new Headers(),
			setReject: () => {},
			forward: async () => ({ messageId: '' }),
			reply: async () => ({ messageId: '' }),
		} as unknown as ForwardableEmailMessage;

		await worker.email(
			message,
			{
				S3_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
				S3_ACCESS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				S3_REGION: 'VA-SSD',
				S3_BUCKET: 'archive-bucket',
				S3_ENDPOINT: 'p2v3.va.idrivee2-43.com',
			},
			{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
		);

		expect(captured).toBeDefined();
		expect(captured!.method).toBe('PUT');
		expect(captured!.url).toMatch(
			/^https:\/\/archive-bucket\.p2v3\.va\.idrivee2-43\.com\/example\.com\/user@example\.com\/mail\.example\.com\/\d+\.eml\.gz$/,
		);
		const authorization = captured!.headers.get('authorization') ?? '';
		expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
		expect(captured!.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
		const uploaded = new Uint8Array(await captured!.arrayBuffer());
		expect(uploaded.byteLength).toBeGreaterThan(0);
		expect(uploaded[0]).toBe(0x1f);
		expect(uploaded[1]).toBe(0x8b);
	});
});
