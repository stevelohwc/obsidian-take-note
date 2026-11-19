// Claude (Anthropic) through the official SDK, streaming.
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, StreamProgress } from "./llm.ts";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

function client(apiKey: string, baseUrl?: string): Anthropic {
	return new Anthropic({
		apiKey,
		...(baseUrl ? { baseURL: baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "") } : {}),
		// Obsidian runs in Electron's renderer, which the SDK treats as a browser. The key is the
		// user's own and stays on their machine (keychain), so direct calls are what we want.
		dangerouslyAllowBrowser: true,
		maxRetries: 2,
	});
}

/** Current-generation models: effort is supported and server-side refusal fallbacks exist. */
const MODERN = /^claude-(opus|sonnet|haiku|fable|mythos)-([5-9]|\d{2})/;
const HAS_FALLBACKS = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5|opus-5-5|sonnet-5-5)$/;

export async function claudeModels(apiKey: string, baseUrl?: string): Promise<string[]> {
	const ids: string[] = [];
	for await (const m of client(apiKey, baseUrl).models.list({ limit: 100 })) ids.push(m.id);
	return ids;
}

export async function claudeChat(
	cfg: { apiKey: string; model: string; baseUrl?: string },
	messages: ChatMessage[],
	opts: { signal?: AbortSignal; onProgress?: (p: StreamProgress) => void } = {},
): Promise<string> {
	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");
	const turns = messages
		.filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
		.map((m) => ({ role: m.role, content: m.content }));

	const stream = client(cfg.apiKey, cfg.baseUrl).beta.messages.stream(
		{
			model: cfg.model,
			max_tokens: 64000,
			...(system ? { system } : {}),
			messages: turns,
			// Meeting extraction is routine work: medium keeps it quick without losing quality.
			...(MODERN.test(cfg.model) ? { output_config: { effort: "medium" as const } } : {}),
			// If a safety classifier declines, let the API retry on a suitable model.
			...(HAS_FALLBACKS.test(cfg.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
		},
		{ signal: opts.signal },
	);

	let contentChars = 0;
	let reasoningChars = 0;
	for await (const event of stream) {
		if (event.type !== "content_block_delta") continue;
		if (event.delta.type === "text_delta") contentChars += event.delta.text.length;
		else if (event.delta.type === "thinking_delta") reasoningChars += event.delta.thinking.length;
		else continue;
		opts.onProgress?.({ contentChars, reasoningChars });
	}

	const final = await stream.finalMessage();
	const text = final.content
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("")
		.trim();
	if (final.stop_reason === "refusal") {
		throw new Error(`Claude declined this request${final.stop_details?.explanation ? ": " + final.stop_details.explanation : "."}`);
	}
	if (!text && final.stop_reason === "max_tokens") {
		throw new Error("Claude ran out of output tokens before answering. Try a shorter meeting or lower \"Max input tokens\".");
	}
	return text;
}
