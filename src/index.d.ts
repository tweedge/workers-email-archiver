export interface Env {
	readonly S3_ACCESS_KEY: string;
	readonly S3_ACCESS_SECRET: string;
	readonly S3_REGION: string;
	readonly S3_BUCKET: string;
	readonly S3_ENDPOINT: string;
}

declare const worker: {
	fetch(request: Request): Promise<Response>;
	email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void>;
};

export default worker;
