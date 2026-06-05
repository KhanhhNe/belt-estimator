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
		belt_estimator?: import("@cloudflare/workers-types").D1Database;
		PASSWORD_HASH_SECRET?: string;
		[key: string]: unknown;
	};
}
