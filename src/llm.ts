// Minimal streaming client for OpenAI-compatible /chat/completions.
// On desktop it uses Node's http(s) instead of fetch so there are no CORS issues inside Obsidian,
// and streams so the router's 60-second idle timeout never closes the connection. On phones
// (no Node) it sends one plain request through Obsidian's requestUrl instead.
import { hasNode, http, https } from "./node.ts";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LlmConfig {
	baseUrl: string; // e.g. http://localhost:11434/v1
	apiKey: string;
	model: string;
	headers?: Record<string, string>; // extra headers, e.g. OpenRouter attribution
}

export interface StreamProgress {
	contentChars: number;
	reasoningChars: number;
}

function endpoint(baseUrl: string, path: string): URL {
	return new URL(baseUrl.replace(/\/+$/, "") + path);
}

/** An HTTP response, however it was fetched: read it whole, or piece by piece as it streams. */
interface Reply {
	status: number;
	contentType: string;
	chunks: () => AsyncIterable<string>;
}

/** A plain (non-streaming) request that ignores CORS: Obsidian's requestUrl, set by the plugin. */
export type PlainRequest = (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{
	status: number;
	headers: Record<string, string>;
	text: string;
}>;
let plainRequest: PlainRequest | null = null;
export function setPlainRequest(fn: PlainRequest | null) {
	plainRequest = fn;
}

function nodeRequest(url: URL, method: string, headers: Record<string, string>, body: string | null, signal?: AbortSignal): Promise<Reply> {
	const lib = url.protocol === "http:" ? http : https;
	return new Promise((resolve, reject) => {
		const req = lib.request(
			url,
			{
				method,
				headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) },
				timeout: 120_000, // socket idle timeout
			},
			(res) =>
				resolve({
					status: res.statusCode ?? 0,
					contentType: String(res.headers["content-type"] ?? ""),
					chunks: async function* () {
						// One decoder for the whole reply: a character split across two network
						// chunks (Chinese, emoji…) is held back until its last byte arrives.
						const dec = new TextDecoder("utf-8");
						for await (const c of res) yield dec.decode(c as Buffer, { stream: true });
						const rest = dec.decode();
						if (rest) yield rest;
					},
				}),
		);
		req.on("timeout", () => req.destroy(new Error("The LLM server stopped responding (120 s with no data).")));
		req.on("error", reject);
		if (signal) {
			if (signal.aborted) req.destroy(new Error("Cancelled"));
			signal.addEventListener("abort", () => req.destroy(new Error("Cancelled")), { once: true });
		}
		if (body) req.write(body);
		req.end();
	});
}

/** Rejects once `signal` is aborted. */
function cancelled(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(new Error("Cancelled"));
		else signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
	});
}

/** Phones: one plain request through Obsidian (no CORS limits). The whole reply arrives at the end. */
async function plainReply(url: URL, method: string, headers: Record<string, string>, body: string | null, signal?: AbortSignal): Promise<Reply> {
	if (!plainRequest) throw new Error("No way to reach the AI on this device.");
	if (signal?.aborted) throw new Error("Cancelled");
	const plainBody = body ? JSON.stringify({ ...(JSON.parse(body) as object), stream: false }) : undefined;
	const sent = plainRequest({ url: url.toString(), method, headers: { ...headers, Accept: "application/json" }, body: plainBody });
	// requestUrl can't be stopped, but Cancel shouldn't wait for it: stop waiting right away.
	const res = signal ? await Promise.race([sent, cancelled(signal)]) : await sent;
	const type = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "application/json";
	return {
		status: res.status,
		contentType: type,
		chunks: async function* () {
			yield res.text;
		},
	};
}

function request(
	url: URL,
	method: string,
	apiKey: string,
	body: string | null,
	signal?: AbortSignal,
	extraHeaders: Record<string, string> = {},
): Promise<Reply> {
	const headers = {
		...extraHeaders,
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		"Content-Type": "application/json",
		Accept: body ? "text/event-stream" : "application/json",
	};
	return (hasNode ? nodeRequest : plainReply)(url, method, headers, body, signal);
}

/** The parts of OpenAI-compatible responses we read. */
interface ApiError {
	error?: { message?: string } | string;
	message?: string;
}
interface ModelList {
	data?: { id: string }[];
}
interface ChatResponse extends ApiError {
	choices?: {
		message?: { content?: string };
		delta?: { content?: string; reasoning_content?: string; reasoning?: string };
		finish_reason?: string | null;
	}[];
}

function apiErrorText(j: ApiError): string | undefined {
	if (typeof j.error === "string") return j.error;
	return j.error?.message ?? j.message;
}

async function readAll(res: Reply): Promise<string> {
	let text = "";
	for await (const c of res.chunks()) text += c;
	return text;
}

function errorMessage(status: number | undefined, body: string): string {
	let msg = body.slice(0, 500);
	try {
		msg = apiErrorText(JSON.parse(body) as ApiError) ?? msg;
	} catch {
		/* not JSON */
	}
	if (status === 401) return `LLM key rejected (401): ${msg}. Check the API key in Take Note settings.`;
	return `LLM request failed (${status}): ${msg}`;
}

export async function listModels(cfg: Omit<LlmConfig, "model">): Promise<string[]> {
	const res = await request(endpoint(cfg.baseUrl, "/models"), "GET", cfg.apiKey, null, undefined, cfg.headers);
	const body = await readAll(res);
	if (res.status >= 400) throw new Error(errorMessage(res.status, body));
	const j = JSON.parse(body) as ModelList;
	return (j.data ?? []).map((m) => m.id);
}

export async function chatStream(
	cfg: LlmConfig,
	messages: ChatMessage[],
	opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal; onProgress?: (p: StreamProgress) => void } = {},
): Promise<string> {
	// OpenAI's own API rejects max_tokens and custom temperatures on its reasoning models.
	const openai = endpoint(cfg.baseUrl, "").hostname === "api.openai.com";
	const body = JSON.stringify({
		model: cfg.model,
		messages,
		stream: true,
		...(openai
			? { max_completion_tokens: opts.maxTokens ?? 16000 }
			: { temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 16000 }),
	});
	const res = await request(endpoint(cfg.baseUrl, "/chat/completions"), "POST", cfg.apiKey, body, opts.signal, cfg.headers);
	if (res.status >= 400) throw new Error(errorMessage(res.status, await readAll(res)));

	// Some servers ignore stream:true and reply with plain JSON.
	if (!res.contentType.includes("event-stream")) {
		const j = JSON.parse(await readAll(res)) as ChatResponse;
		return j.choices?.[0]?.message?.content ?? "";
	}

	let content = "";
	let reasoning = 0;
	let buffer = "";
	let finish: string | null = null;
	for await (const chunk of res.chunks()) {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "[DONE]") continue;
			try {
				const j = JSON.parse(data) as ChatResponse;
				if (j.error) throw new Error(apiErrorText(j) ?? "LLM stream error");
				const choice = j.choices?.[0];
				const delta = choice?.delta ?? {};
				if (typeof delta.content === "string") content += delta.content;
				const r = delta.reasoning_content ?? delta.reasoning;
				if (typeof r === "string") reasoning += r.length;
				if (choice?.finish_reason) finish = choice.finish_reason;
			} catch (e) {
				if (e instanceof SyntaxError) continue; // partial / keep-alive line
				throw e;
			}
			opts.onProgress?.({ contentChars: content.length, reasoningChars: reasoning });
		}
	}
	if (!content.trim() && finish === "length") {
		throw new Error("The model ran out of output tokens before answering (it spent them all thinking). Try again or use a different model.");
	}
	return content;
}
