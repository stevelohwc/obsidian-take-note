// Command-line version of the pipeline, for testing prompts without Obsidian.
//
//   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5:14b node scripts/run.ts <audio-or-text-file>
//
// Settings come from environment variables or a local .env file (never committed):
//   LLM_BASE_URL   OpenAI-compatible endpoint (default http://localhost:11434/v1, i.e. Ollama)
//   LLM_MODEL      model name (required)
//   LLM_API_KEY    API key, if your server needs one
//   MY_NAME        your name, so "I will…" becomes your action item
//   MC_DATA        path to a vault's .obsidian/plugins/meeting-copilot/data.json to reuse its settings
//   MC_SPEAKERS=1  separate speakers (needs scripts/setup-macos.sh)
//   TRANSCRIPT_ONLY=1  print the transcript and stop
import fs from "node:fs";
import path from "node:path";
import { chatStream } from "../src/llm.ts";
import { extractMeeting } from "../src/extract.ts";
import { renderMeeting } from "../src/render.ts";
import { transcribeFile } from "../src/transcribe.ts";
import { findNode, loadVoices } from "../src/voices.ts";

const dotenv = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const env = (k: string) => process.env[k] ?? dotenv.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
const saved = env("MC_DATA") && fs.existsSync(env("MC_DATA")!) ? JSON.parse(fs.readFileSync(env("MC_DATA")!, "utf8")) : {};

const baseUrl = env("LLM_BASE_URL") ?? saved.baseUrl ?? "http://localhost:11434/v1";
const model = env("LLM_MODEL") ?? saved.model ?? "";
const apiKey = env("LLM_API_KEY") ?? env("LLM_ROUTER_KEY") ?? "";
const myName = env("MY_NAME") ?? saved.myName ?? "me";
const [input] = process.argv.slice(2);
if (!input || !model) {
	console.error("usage: LLM_MODEL=<model> [LLM_BASE_URL=…] [LLM_API_KEY=…] node scripts/run.ts <audio-or-text-file>");
	process.exit(1);
}

let notes = "";
let transcript = "";
if (/\.(md|txt)$/i.test(input)) {
	notes = fs.readFileSync(input, "utf8");
} else {
	const r = await transcribeFile(
		path.resolve(input),
		{
			ffmpegPath: "/opt/homebrew/bin/ffmpeg",
			whisperPath: "/opt/homebrew/bin/whisper-cli",
			modelPath: "~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin",
			vadModelPath: "",
			language: "auto",
			prompt: saved.whisperPrompt ?? "",
			timestamps: true,
		},
		(p, s) => process.stderr.write(`\r${s} ${p}%   `),
		undefined,
		env("MC_SPEAKERS")
			? {
					nodePath: findNode("")!,
					helperScript: path.resolve("helper/speakers.cjs"),
					numSpeakers: 0,
					clusterThreshold: 0.7,
					mergeThreshold: 0.75,
					matchThreshold: 0.6,
					profiles: loadVoices(),
				}
			: undefined,
	);
	if (r.speakers) console.error(`\nSpeakers: ${Object.keys(r.speakers).join(", ")} (recognised: ${r.recognised?.join(", ") || "none"})`);
	if (r.speakerError) console.error(`\nSpeaker error: ${r.speakerError}`);
	if (env("TRANSCRIPT_ONLY")) {
		console.log(r.text);
		process.exit(0);
	}
	transcript = r.text;
	console.error(`\nTranscribed ${Math.round(r.durationSec)}s of audio.`);
}

const t0 = Date.now();
const result = await extractMeeting(
	(messages, label) =>
		chatStream({ baseUrl, apiKey, model }, messages, {
			onProgress: (p) => process.stderr.write(`\r${label}: thinking ${p.reasoningChars} / writing ${p.contentChars} chars   `),
		}),
	{
		notes,
		transcript,
		date: new Date().toISOString().slice(0, 10),
		myName,
		outputLanguage: saved.outputLanguage ?? "English",
		knownPeople: [],
		extraInstructions: saved.extraInstructions ?? "",
	},
	saved.maxInputTokens ?? 50000,
);
console.error(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log(`# ${result.title}\n`);
console.log(renderMeeting(result, { linkPeople: true, tasksEmoji: true, generatedAt: new Date().toISOString(), model }));
