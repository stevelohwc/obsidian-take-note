// Minimal streaming client for OpenAI-compatible /chat/completions.
// Uses Node's http(s) instead of fetch so there are no CORS issues inside Obsidian,
// and streams so the router's 60-second idle timeout never closes the connection.
import * as http from "http";
import * as https from "https";

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

function request(
	url: URL,
	method: string,
	apiKey: string,
	body: string | null,
	signal?: AbortSignal,
	extraHeaders: Record<string, string> = {},
): Promise<http.IncomingMessage> {
	const lib = url.protocol === "http:" ? http : https;
	return new Promise((resolve, reject) => {
		const req = lib.request(
			url,
			{
				method,
				headers: {
					...extraHeaders,
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					"Content-Type": "application/json",
					Accept: body ? "text/event-stream" : "application/json",
					...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
				},
				timeout: 120_000, // socket idle timeout
			},
			resolve,
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

async function readAll(res: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of res) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
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
	if ((res.statusCode ?? 0) >= 400) throw new Error(errorMessage(res.statusCode, body));
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
	if ((res.statusCode ?? 0) >= 400) throw new Error(errorMessage(res.statusCode, await readAll(res)));

	// Some servers ignore stream:true and reply with plain JSON.
	if (!String(res.headers["content-type"] ?? "").includes("event-stream")) {
		const j = JSON.parse(await readAll(res)) as ChatResponse;
		return j.choices?.[0]?.message?.content ?? "";
	}

	let content = "";
	let reasoning = 0;
	let buffer = "";
	let finish: string | null = null;
	for await (const chunk of res) {
		buffer += (chunk as Buffer).toString("utf8");
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
