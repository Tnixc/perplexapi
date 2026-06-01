export const config = {
	runtime: "edge",
};

type OpenAIErrorType =
	| "invalid_request_error"
	| "authentication_error"
	| "not_found_error"
	| "server_error";

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export default async function handler(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const targetPath = normalizePath(url.pathname);

	if (targetPath === "/health" && request.method === "GET") {
		return Response.json({ status: "ok" });
	}

	if (!targetPath.startsWith("/v1/")) {
		return openAIError(
			`Unknown endpoint ${request.method} ${targetPath}`,
			"not_found_error",
			404,
		);
	}

	const authError = authorize(request);
	if (authError) {
		return authError;
	}

	const callerUrl = env("CALLER_URL");
	if (!callerUrl) {
		return openAIError("Missing required environment variable CALLER_URL.", "server_error", 500);
	}

	const upstreamUrl = new URL(targetPath + url.search, normalizeBaseUrl(callerUrl));
	const upstreamResponse = await fetch(upstreamUrl, {
		method: request.method,
		headers: proxyHeaders(request),
		body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
		redirect: "manual",
	});

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: responseHeaders(upstreamResponse.headers),
	});
}

function authorize(request: Request): Response | null {
	const key = env("KEY");
	if (!key) {
		return openAIError("Missing required environment variable KEY.", "server_error", 500);
	}

	const authorization = request.headers.get("authorization");
	const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	const apiKey = bearerToken ?? request.headers.get("x-api-key");

	if (apiKey !== key) {
		return openAIError("Incorrect API key provided.", "authentication_error", 401);
	}

	return null;
}

function normalizePath(pathname: string): string {
	if (pathname.startsWith("/api/")) {
		return pathname.slice("/api".length) || "/";
	}

	return pathname;
}

function normalizeBaseUrl(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function proxyHeaders(request: Request): Headers {
	const headers = new Headers();

	for (const [name, value] of request.headers.entries()) {
		if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
			headers.set(name, value);
		}
	}

	headers.set("x-forwarded-host", new URL(request.url).host);
	headers.set("x-forwarded-proto", "https");

	return headers;
}

function responseHeaders(upstreamHeaders: Headers): Headers {
	const headers = new Headers();

	for (const [name, value] of upstreamHeaders.entries()) {
		if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
			headers.set(name, value);
		}
	}

	return headers;
}

function openAIError(
	message: string,
	type: OpenAIErrorType = "invalid_request_error",
	status = 400,
): Response {
	return Response.json(
		{
			error: {
				message,
				type,
				param: null,
				code: null,
			},
		},
		{
			status,
			headers:
				status === 401
					? { "WWW-Authenticate": 'Bearer realm="perplexapi"' }
					: undefined,
		},
	);
}

function env(name: string): string | undefined {
	const runtime = globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	};

	return runtime.process?.env?.[name];
}
