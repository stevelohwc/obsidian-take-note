// Ready-made LLM providers, so people can pick one, paste a key and go.
import { type ChatMessage, type StreamProgress, chatStream, listModels } from "./llm.ts";
import { CLAUDE_DEFAULT_MODEL, claudeChat, claudeModels } from "./claude.ts";

export type ProviderId = "ollama" | "lmstudio" | "openai" | "anthropic" | "openrouter" | "custom";

export interface Provider {
	id: ProviderId;
	name: string;
	baseUrl: string;
	/** The user may change the URL (local servers, custom endpoints). */
	editableUrl: boolean;
	needsKey: boolean;
	keyUrl?: string;
	defaultModel: string;
	hint: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
	ollama: {
		id: "ollama",
		name: "Ollama (local)",
		baseUrl: "http://localhost:11434/v1",
		editableUrl: true,
		needsKey: false,
		defaultModel: "",
		hint: "Runs on your computer, nothing leaves it. Install Ollama and pull a model, e.g. \"ollama pull qwen2.5:14b\".",
	},
	lmstudio: {
		id: "lmstudio",
		name: "LM Studio (local)",
		baseUrl: "http://localhost:1234/v1",
		editableUrl: true,
		needsKey: false,
		defaultModel: "",
		hint: "Runs on your computer. Start LM Studio's local server and load a model.",
	},
	openai: {
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		editableUrl: false,
		needsKey: true,
		keyUrl: "https://platform.openai.com/api-keys",
		defaultModel: "",
		hint: "Paste an OpenAI API key, then pick a model.",
	},
	anthropic: {
		id: "anthropic",
		name: "Claude (Anthropic)",
		baseUrl: "https://api.anthropic.com",
		editableUrl: false,
		needsKey: true,
		keyUrl: "https://console.anthropic.com/settings/keys",
		defaultModel: CLAUDE_DEFAULT_MODEL,
		hint: "Paste an Anthropic API key. Claude Opus 5.5 is set by default.",
	},
	openrouter: {
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		editableUrl: false,
		needsKey: true,
		keyUrl: "https://openrouter.ai/keys",
		defaultModel: "",
		hint: "One key for hundreds of models from many providers. Paste an OpenRouter key, then pick a model.",
	},
	custom: {
		id: "custom",
		name: "Other (OpenAI-compatible)",
		baseUrl: "",
		editableUrl: true,
		needsKey: false,
		defaultModel: "",
		hint: "Any OpenAI-compatible endpoint: vLLM, LiteLLM, a company LLM router…",
	},
};

/** Work out the provider for settings saved before providers existed. */
export function inferProvider(baseUrl: string): ProviderId {
	let host = "";
	let port = "";
	try {
		const u = new URL(baseUrl);
		host = u.hostname;
		port = u.port;
	} catch {
		return "custom";
	}
	if (host === "api.openai.com") return "openai";
	if (host === "api.anthropic.com") return "anthropic";
	if (host === "openrouter.ai") return "openrouter";
	if (/^(localhost|127\.0\.0\.1)$/.test(host) && port === "11434") return "ollama";
	if (/^(localhost|127\.0\.0\.1)$/.test(host) && port === "1234") return "lmstudio";
	return "custom";
}

export interface ProviderConfig {
	provider: ProviderId;
	baseUrl: string;
	apiKey: string;
	model: string;
}

function baseUrlFor(cfg: Omit<ProviderConfig, "model">): string {
	const p = PROVIDERS[cfg.provider];
	return p.editableUrl ? cfg.baseUrl : p.baseUrl;
}

const OPENROUTER_HEADERS = { "HTTP-Referer": "https://github.com/stevelohwc/obsidian-take-note", "X-Title": "Take Note" };

/** OpenAI lists embedding, audio and image models too; keep the ones that can write notes. */
function chatModelsOnly(ids: string[]): string[] {
	return ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct)/.test(id));
}

export async function providerModels(cfg: Omit<ProviderConfig, "model">): Promise<string[]> {
	const baseUrl = baseUrlFor(cfg);
	if (cfg.provider === "anthropic") return claudeModels(cfg.apiKey, baseUrl);
	const ids = await listModels({ baseUrl, apiKey: cfg.apiKey, headers: cfg.provider === "openrouter" ? OPENROUTER_HEADERS : undefined });
	return (cfg.provider === "openai" ? chatModelsOnly(ids) : ids).sort();
}

export function providerChat(
	cfg: ProviderConfig,
	messages: ChatMessage[],
	opts: { signal?: AbortSignal; onProgress?: (p: StreamProgress) => void } = {},
): Promise<string> {
	const baseUrl = baseUrlFor(cfg);
	if (cfg.provider === "anthropic") return claudeChat({ apiKey: cfg.apiKey, model: cfg.model, baseUrl }, messages, opts);
	return chatStream(
		{ baseUrl, apiKey: cfg.apiKey, model: cfg.model, headers: cfg.provider === "openrouter" ? OPENROUTER_HEADERS : undefined },
		messages,
		opts,
	);
}
