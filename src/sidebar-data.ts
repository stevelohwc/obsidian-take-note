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

const HEADER = /^\[!quote\][-+]?\s*(?:Transcript|Chat)(?:\s*\((.*)\))?\s*$/i;
// "[00:01:02]" is a position in the recording; a chat's "[10:15]" is a time of day (nothing to seek to).
const LINE = /^(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*)?(.*)$/;
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
		const hasTime = m[3] !== undefined;
		const seconds = hasTime ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
		const clock = hasTime ? `${m[1]}:${m[2]}:${m[3]}` : m[1] !== undefined ? `${m[1]}:${m[2]}` : null;
		let speaker: string | null = null;
		let text = m[4];
		const sp = text.match(SPEAKER);
		if (sp && sp[1].trim().split(/\s+/).length <= 4) {
			speaker = sp[1].trim();
			text = sp[2];
		}
		if (text === "(no speech detected)") continue;
		lines.push({ seconds, clock, speaker, text });
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

const MY_NOTES = /^## My notes[ \t]*$/m;

/** Where the "## My notes" section's text starts and ends (end = next heading or plugin block). */
function myNotesRange(content: string): { headingStart: number; start: number; end: number } | null {
	const m = MY_NOTES.exec(content);
	if (!m) return null;
	const headingStart = m.index;
	let start = headingStart + m[0].length;
	if (content[start] === "\r") start++;
	if (content[start] === "\n") start++;
	const rest = content.slice(start);
	const stop = rest.search(/^(#{1,2} |<!-- take-note:)/m);
	return { headingStart, start, end: stop === -1 ? content.length : start + stop };
}

/** The user's own notes under "## My notes", or null if the note has no such section. */
export function getMyNotes(content: string): string | null {
	const r = myNotesRange(content);
	return r ? content.slice(r.start, r.end).replace(/\s+$/, "") : null;
}

/** Replace the "## My notes" section's text, adding the section (before the transcript) if missing. */
export function setMyNotes(content: string, text: string): string {
	const body = text.replace(/\s+$/, "");
	const r = myNotesRange(content);
	if (r) {
		const after = content.slice(r.end);
		const gap = after.length ? "\n\n" : "\n";
		return content.slice(0, r.start) + body + gap + after;
	}
	const section = `## My notes\n${body}\n`;
	const tx = content.indexOf("<!-- take-note:transcript:start -->");
	if (tx !== -1) return content.slice(0, tx) + section + "\n" + content.slice(tx);
	return content.replace(/\s*$/, "") + "\n\n" + section;
}
