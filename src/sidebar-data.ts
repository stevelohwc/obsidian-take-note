// Pure helpers behind the sidebar view: reading the transcript block and ticking tasks.
import { AI_END, AI_START, getBlock } from "./render.ts";

export interface TranscriptLine {
	seconds: number | null;
	clock: string | null;
	speaker: string | null;
	text: string;
}

export interface ParsedTranscript {
	audioLink: string | null; // e.g. "![[2026-11-19 1530 recording.webm]]"
	meta: string;
	lines: TranscriptLine[];
}

const HEADER = /^\[!quote\][-+]?\s*Transcript(?:\s*\((.*)\))?\s*$/i;
const LINE = /^(?:\[(\d{1,2}):(\d{2}):(\d{2})\]\s*)?(.*)$/;
// "Alice: …", "Speaker 2: …", "Dana Lee: …" — a short name before the first colon.
const SPEAKER = /^([^:[\]()]{1,32}?):\s+(.*)$/;

/** Parse the plugin's transcript block (the text between the transcript markers). */
export function parseTranscript(block: string): ParsedTranscript {
	let audioLink: string | null = null;
	let meta = "";
	const lines: TranscriptLine[] = [];
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("<!--") || /^#{1,6}\s/.test(line)) continue;
		if (!line.startsWith(">")) {
			if (!audioLink && /^!\[/.test(line)) audioLink = line;
			continue;
		}
		const body = line.replace(/^>\s?/, "").trim();
		if (!body) continue;
		const header = body.match(HEADER);
		if (header) {
			meta = header[1] ?? "";
			continue;
		}
		const m = body.match(LINE);
		if (!m) continue;
		const hasTime = m[1] !== undefined;
		const seconds = hasTime ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
		let speaker: string | null = null;
		let text = m[4];
		const sp = text.match(SPEAKER);
		if (sp && sp[1].trim().split(/\s+/).length <= 4) {
			speaker = sp[1].trim();
			text = sp[2];
		}
		if (text === "(no speech detected)") continue;
		lines.push({ seconds, clock: hasTime ? `${m[1]}:${m[2]}:${m[3]}` : null, speaker, text });
	}
	return { audioLink, meta, lines };
}

/** The vault link inside an embed like "![[file.webm]]" or "![x](file.webm)". */
export function embedTarget(embed: string): string | null {
	const wiki = embed.match(/^!\[\[([^\]|#]+)/);
	if (wiki) return wiki[1].trim();
	const md = embed.match(/^!\[[^\]]*\]\(<?([^)>]+)>?\)/);
	return md ? decodeURI(md[1].trim()) : null;
}

const TASK = /^(\s*[-*+] \[)([ xX])(\])/;

/**
 * Set the checkbox of the n-th task (0-based, in document order) inside the AI block.
 * Returns the content unchanged if there is no such task.
 */
export function setTaskInAiBlock(content: string, n: number, done: boolean): string {
	const block = getBlock(content, AI_START, AI_END);
	if (block === null) return content;
	const start = content.indexOf(AI_START) + AI_START.length;
	let seen = -1;
	const lines = block.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!TASK.test(lines[i])) continue;
		if (++seen !== n) continue;
		lines[i] = lines[i].replace(TASK, `$1${done ? "x" : " "}$3`);
		return content.slice(0, start) + lines.join("\n") + content.slice(start + block.length);
	}
	return content;
}
