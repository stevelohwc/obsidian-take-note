// Local storage for voice fingerprints and per-meeting speaker data.
// Lives in ~/.meeting-copilot (this Mac only — never in the vault, so never in iCloud).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SpeakerPrint, VoiceProfiles } from "./speakers.ts";

const MAX_PRINTS_PER_PERSON = 6;

export function helperHome(): string {
	return process.env.MC_HOME || path.join(os.homedir(), ".meeting-copilot");
}

const voicesFile = () => path.join(helperHome(), "voices.json");
const sessionFile = (id: string) => path.join(helperHome(), "sessions", `${id.replace(/[^a-z0-9-]/gi, "")}.json`);

export function loadVoices(): VoiceProfiles {
	try {
		const j = JSON.parse(fs.readFileSync(voicesFile(), "utf8"));
		return j.voices ?? {};
	} catch {
		return {};
	}
}

function saveVoices(v: VoiceProfiles) {
	fs.mkdirSync(helperHome(), { recursive: true });
	fs.writeFileSync(voicesFile(), JSON.stringify({ version: 1, voices: v }));
}

export function addVoice(name: string, embedding: number[]) {
	const v = loadVoices();
	const list = (v[name] ??= []);
	list.push(embedding);
	v[name] = list.slice(-MAX_PRINTS_PER_PERSON);
	saveVoices(v);
}

export function forgetVoice(name: string) {
	const v = loadVoices();
	delete v[name];
	saveVoices(v);
}

/** Speaker fingerprints for one transcribed recording, keyed by the label shown in the transcript. */
export interface Session {
	speakers: Record<string, SpeakerPrint>;
}

export function newSessionId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function saveSession(id: string, s: Session) {
	fs.mkdirSync(path.dirname(sessionFile(id)), { recursive: true });
	fs.writeFileSync(sessionFile(id), JSON.stringify(s));
}

export function loadSession(id: string): Session | null {
	try {
		return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
	} catch {
		return null;
	}
}

/**
 * The speaker helper ships inside main.js (so a plain GitHub-release install works) and is
 * written to ~/.meeting-copilot/speakers.cjs, next to the sherpa-onnx install it needs.
 */
export function ensureHelperScript(source: string): string {
	const file = path.join(helperHome(), "speakers.cjs");
	try {
		if (fs.readFileSync(file, "utf8") === source) return file;
	} catch {
		/* missing */
	}
	fs.mkdirSync(helperHome(), { recursive: true });
	fs.writeFileSync(file, source);
	return file;
}

/** Find a usable `node` binary (Obsidian's own PATH usually lacks Homebrew / nvm). */
export function findNode(configured: string): string | null {
	const candidates = [configured, "/opt/homebrew/bin/node", "/usr/local/bin/node"].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
	try {
		const versions = fs
			.readdirSync(nvm)
			.filter((v) => /^v\d+/.test(v))
			.sort((a, b) => {
				const pa = a.slice(1).split(".").map(Number);
				const pb = b.slice(1).split(".").map(Number);
				return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
			});
		for (const v of versions) {
			const p = path.join(nvm, v, "bin", "node");
			if (fs.existsSync(p)) return p;
		}
	} catch {
		/* no nvm */
	}
	return null;
}

export function speakerSetupProblems(nodePath: string | null): string[] {
	const h = helperHome();
	const problems: string[] = [];
	if (!nodePath) problems.push("Node.js not found (install it, or set its path in settings)");
	if (!fs.existsSync(path.join(h, "node_modules", "sherpa-onnx-node"))) problems.push(`sherpa-onnx not installed in ${h}`);
	if (!fs.existsSync(path.join(h, "models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"))) problems.push("speaker segmentation model missing");
	if (!fs.existsSync(path.join(h, "models", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"))) problems.push("voice fingerprint model missing");
	return problems;
}
