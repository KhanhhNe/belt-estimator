declare module "cloudflare:node" {
	export function httpServerHandler(options: { port: number }): {
		fetch: (request: Request, env: unknown) => Promise<Response> | Response;
	};
}

declare module "cloudflare:workers" {
	export const env: {
		ASSETS?: {
			fetch: (request: Request) => Promise<Response> | Response;
		};
		TURSO_DATABASE_URL?: string;
		TURSO_AUTH_TOKEN?: string;
		PASSWORD_HASH_SECRET?: string;
		[key: string]: unknown;
	};
}
