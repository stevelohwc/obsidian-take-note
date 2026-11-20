// Chat histories (WhatsApp exports, Telegram exports, copied chat text) turned into
// speaker-labelled lines the AI step reads like a transcript. No Obsidian or Node imports.

export type ChatSource = "WhatsApp" | "Telegram" | "Chat";

export interface ChatMessage {
	date: string | null; // YYYY-MM-DD
	time: string | null; // HH:mm, 24-hour
	sender: string;
	text: string;
}

export interface ParsedChat {
	source: ChatSource;
	name: string | null; // the chat's name, when the export has one
	messages: ChatMessage[]; // empty when no chat format was recognised
}

type Triple = [number, number, number];
type Order = "dmy" | "mdy" | "ymd";
/** A message before its numeric date is resolved (day/month order is decided per chat). */
interface Raw {
	date: Triple | string | null;
	time: string | null;
	sender: string;
	text: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const AMPM = String.raw`([AaPp]\.?\s?[Mm]\.?)`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Drop direction marks WhatsApp sprinkles in, and turn odd spaces into plain ones. */
function cleanLine(s: string): string {
	return s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/[\u202f\u00a0]/g, " ");
}

function cleanSender(s: string): string {
	return s.replace(/[:[\]\n]/g, "").replace(/\s+/g, " ").trim() || "Unknown";
}

/** Day/month order for a chat's numeric dates: a first number above 12 means day-first, a second above 12 month-first. */
export function dateOrder(dates: Triple[]): Order {
	if (dates.some(([a]) => a > 31)) return "ymd";
	if (dates.some(([a]) => a > 12)) return "dmy";
	if (dates.some(([, b]) => b > 12)) return "mdy";
	return "dmy";
}

function toIsoDate([a, b, c]: Triple, order: Order): string | null {
	const [y0, m, d] = order === "ymd" ? [a, b, c] : order === "mdy" ? [c, a, b] : [c, b, a];
	const y = y0 < 100 ? 2000 + y0 : y0;
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	return `${y}-${pad(m)}-${pad(d)}`;
}

function toTime(h: number, min: number, ampm?: string): string {
	if (ampm) {
		const pm = /^p/i.test(ampm);
		if (h === 12) h = pm ? 12 : 0;
		else if (pm) h += 12;
	}
	return `${pad(h)}:${pad(min)}`;
}

/** A date and/or time in free form: "20.11.2026 10:15", "20 Nov 2026 at 10:15 PM", "Nov 20, 2026, 10:15". */
function looseDateTime(s: string): { date: Triple | string | null; time: string | null } {
	const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
	let date: Triple | string | null = null;
	let rest = s;
	const num = s.match(/(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/);
	const dmy = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
	const mdy = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
	if (num) date = [+num[1], +num[2], +num[3]];
	else if (dmy && month(dmy[2])) date = `${dmy[3]}-${pad(month(dmy[2]))}-${pad(+dmy[1])}`;
	else if (mdy && month(mdy[1])) date = `${mdy[3]}-${pad(month(mdy[1]))}-${pad(+mdy[2])}`;
	const found = num ?? (date ? (dmy ?? mdy) : null);
	if (found) rest = s.replace(found[0], " "); // so "20.11" isn't read as a time
	const t = rest.match(new RegExp(String.raw`(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*${AMPM}?`));
	return { date, time: t ? toTime(+t[1], +t[2], t[3]) : null };
}

/** Resolve numeric dates with one day/month order for the whole chat. */
function finish(raw: Raw[]): ChatMessage[] {
	const order = dateOrder(raw.map((r) => r.date).filter((d): d is Triple => Array.isArray(d)));
	return raw
		.map((r) => ({
			date: Array.isArray(r.date) ? toIsoDate(r.date, order) : r.date,
			time: r.time,
			sender: cleanSender(r.sender),
			text: r.text.trim(),
		}))
		.filter((m) => m.text);
}

// ---------- WhatsApp ----------

// iPhone: "[20/11/2026, 10:15:32] Alice: hi"   Android: "20/11/2026, 10:15 - Alice: hi"
const WA_HEAD = new RegExp(
	String.raw`^\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*${AMPM}?(?:\]\s*|\s+[-–]\s+)(.*)$`,
);

function attachment(file: string): string {
	const f = file.trim();
	if (/STICKER|\.webp$/i.test(f)) return "[sticker]";
	if (/GIF/i.test(f)) return "[GIF]";
	if (/PHOTO|\.(jpe?g|png|heic)$/i.test(f)) return "[photo]";
	if (/VIDEO|\.(mp4|mov|3gp)$/i.test(f)) return "[video]";
	if (/AUDIO|PTT|\.(opus|m4a|ogg|aac|mp3)$/i.test(f)) return "[voice message]";
	return `[file: ${f}]`;
}

const WA_OMITTED: [RegExp, string][] = [
	[/^<Media omitted>$/i, "[media]"],
	[/^(image|photo) omitted$/i, "[photo]"],
	[/^video omitted$/i, "[video]"],
	[/^audio omitted$/i, "[voice message]"],
	[/^sticker omitted$/i, "[sticker]"],
	[/^GIF omitted$/i, "[GIF]"],
	[/^document omitted$/i, "[document]"],
	[/^Contact card omitted$/i, "[contact]"],
];

/** Media placeholders become short markers; deleted messages and encryption notices go. */
function whatsAppText(text: string): string {
	let t = text.replace(/\s*<This message was edited>\s*$/i, "").trim();
	if (/^(This message was deleted|You deleted this message|Waiting for this message|Messages and calls are end-to-end encrypted)/i.test(t)) return "";
	t = t.replace(/<attached: (?:\d+-)?([^>]+)>/gi, (_, f: string) => attachment(f));
	t = t.replace(/^(\S.*\.\w{2,5}) \(file attached\)$/im, (_, f: string) => attachment(f));
	for (const [re, marker] of WA_OMITTED) if (re.test(t)) return marker;
	return t;
}

function parseWhatsApp(lines: string[]): Raw[] {
	const out: Raw[] = [];
	let last: Raw | null = null;
	for (const line of lines) {
		const m = line.match(WA_HEAD);
		if (!m) {
			if (last) last.text += "\n" + line;
			continue;
		}
		const said = m[7].match(/^([^:]{1,80}?):\s?([\s\S]*)$/);
		if (!said) {
			last = null; // a system line ("Alice added Bob"): skip it and anything wrapped under it
			continue;
		}
		last = { date: [+m[1], +m[2], +m[3]], time: toTime(+m[4], +m[5], m[6]), sender: said[1], text: said[2] };
		out.push(last);
	}
	for (const r of out) r.text = whatsAppText(r.text);
	return out;
}

// ---------- Telegram: copied messages ----------

// "Alice, [20.11.2026 10:15]" or "Alice, [20 Nov 2026 at 10:15]:" with the message on the lines below.
const TG_COPY_HEAD = /^(.{1,80}?),\s+\[([^\]]{3,40})\]:?\s*$/;

function parseTelegramCopy(lines: string[]): Raw[] {
	const out: Raw[] = [];
	let last: Raw | null = null;
	for (const line of lines) {
		const m = line.match(TG_COPY_HEAD);
		const when = m ? looseDateTime(m[2]) : null;
		if (m && when && (when.date || when.time)) {
			last = { ...when, sender: m[1], text: "" };
			out.push(last);
		} else if (last) {
			last.text += "\n" + line;
		}
	}
	return out;
}

// ---------- Any "[time] Name: message" lines ----------

const GENERIC = new RegExp(
	String.raw`^(?:\[([^\]]{3,40})\]\s*(?:[-–]\s*)?|((?:\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*${AMPM}?)\s+(?:[-–]\s+)?)?([^:[\]\n]{1,40}?):\s+(.*)$`,
);

function parseGeneric(lines: string[]): Raw[] {
	const out: Raw[] = [];
	let last: Raw | null = null;
	for (const line of lines) {
		const m = line.match(GENERIC);
		if (m) {
			const when = looseDateTime(m[1] ?? m[2] ?? "");
			last = { ...when, sender: m[4], text: m[5] };
			out.push(last);
		} else if (last) {
			last.text += "\n" + line;
		}
	}
	return out;
}

// ---------- Telegram Desktop export: result.json ----------

function obj(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function telegramJsonText(v: unknown): string {
	if (typeof v === "string") return v;
	if (!Array.isArray(v)) return "";
	return v
		.map((part) => {
			const p = obj(part);
			if (!p) return str(part);
			const text = str(p.text);
			const href = str(p.href);
			return href && href !== text ? `${text} (${href})` : text;
		})
		.join("");
}

const TG_MEDIA: Record<string, string> = {
	voice_message: "[voice message]",
	video_message: "[video message]",
	video_file: "[video]",
	animation: "[GIF]",
	audio_file: "[audio]",
	sticker: "[sticker]",
};

function parseTelegramJson(data: unknown): { name: string | null; raw: Raw[] } {
	let chat = obj(data);
	const list = obj(chat?.chats)?.list;
	if (Array.isArray(list)) {
		if (list.length !== 1)
			throw new Error(
				`This is a full Telegram account export with ${list.length} chats. Export one chat instead: open the chat → ⋮ → Export chat history, format JSON.`,
			);
		chat = obj(list[0]);
	}
	const messages = chat?.messages;
	if (!Array.isArray(messages)) throw new Error("This JSON file isn't a Telegram chat export (no messages list).");
	const raw: Raw[] = [];
	let lastSender = "Unknown";
	for (const item of messages) {
		const m = obj(item);
		if (!m || str(m.type) !== "message") continue; // service messages: joins, pins, calls
		const sender = str(m.from) || lastSender;
		lastSender = sender;
		const parts: string[] = [];
		const fwd = str(m.forwarded_from);
		if (m.photo) parts.push("[photo]");
		const media = TG_MEDIA[str(m.media_type)];
		if (media) parts.push(media === "[sticker]" && str(m.sticker_emoji) ? `[sticker ${str(m.sticker_emoji)}]` : media);
		else if (m.file) parts.push(`[file: ${str(m.file_name) || str(m.file).split("/").pop()}]`);
		const poll = obj(m.poll);
		if (poll) parts.push(`[poll: ${str(poll.question)}]`);
		if (m.location_information) parts.push("[location]");
		if (m.contact_information) parts.push("[contact]");
		const text = telegramJsonText(m.text);
		if (text.trim()) parts.push(text);
		if (!parts.length) continue;
		const date = str(m.date);
		raw.push({
			date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
			time: /T\d{2}:\d{2}/.test(date) ? date.slice(11, 16) : null,
			sender,
			text: (fwd ? `[forwarded from ${fwd}] ` : "") + parts.join(" "),
		});
	}
	return { name: str(chat?.name) || null, raw };
}

// ---------- Telegram Desktop export: messages.html ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlToText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
			if (e[0] === "#") {
				const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : all;
			}
			return ENTITIES[e.toLowerCase()] ?? all;
		})
		.trim();
}

const TG_HTML_MEDIA: [string, string][] = [
	["photo_wrap", "[photo]"],
	["media_voice_message", "[voice message]"],
	["media_video", "[video]"],
	["video_file_wrap", "[video]"],
	["sticker", "[sticker]"],
	["animated_wrap", "[GIF]"],
	["media_audio_file", "[audio]"],
	["media_location", "[location]"],
	["media_contact", "[contact]"],
	["media_poll", "[poll]"],
	["media_file", "[file]"],
];

function parseTelegramHtml(html: string): { name: string | null; raw: Raw[] } {
	const title = html.match(/<div class="page_header">[\s\S]*?<div class="text bold">\s*([\s\S]*?)\s*<\/div>/);
	const raw: Raw[] = [];
	let lastSender = "Unknown";
	for (const chunk of html.split(/<div class="message /).slice(1)) {
		if (/^service/.test(chunk)) continue;
		const when = chunk.match(/class="pull_right date details" title="(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})/);
		const fromAt = chunk.search(/<div class="from_name">/);
		const fwdAt = chunk.indexOf('class="forwarded body"');
		const fromHtml = chunk.match(/<div class="from_name">([\s\S]*?)<\/div>/)?.[1] ?? "";
		const from = htmlToText(fromHtml.replace(/<span[\s\S]*?<\/span>/g, ""));
		// A "joined" message continues the previous sender, so its first from_name (if any) is a forward's.
		const ownName = fromAt !== -1 && (fwdAt === -1 || fromAt < fwdAt);
		const sender = ownName && from ? from : lastSender;
		lastSender = sender;
		let forwarded = "";
		if (fwdAt !== -1) {
			const fwdName = chunk.slice(fwdAt).match(/<div class="from_name">([\s\S]*?)<\/div>/)?.[1] ?? "";
			const name = htmlToText(fwdName.replace(/<span[\s\S]*?<\/span>/g, ""));
			forwarded = name ? `[forwarded from ${name}] ` : "[forwarded] ";
		}
		const parts: string[] = [];
		const mediaAt = chunk.indexOf('class="media_wrap');
		const textAt = chunk.indexOf('<div class="text">');
		if (mediaAt !== -1) {
			// Only the media markup, never the message text (which may well say "photo").
			const media = chunk.slice(mediaAt, textAt > mediaAt ? textAt : mediaAt + 2000);
			parts.push(TG_HTML_MEDIA.find(([cls]) => media.includes(cls))?.[1] ?? "[media]");
		}
		const text = chunk.match(/<div class="text">([\s\S]*?)<\/div>/)?.[1];
		if (text) parts.push(htmlToText(text));
		if (!parts.join("").trim()) continue;
		raw.push({
			date: when ? [+when[1], +when[2], +when[3]] : null,
			time: when ? toTime(+when[4], +when[5]) : null,
			sender,
			text: forwarded + parts.join(" "),
		});
	}
	return { name: title ? htmlToText(title[1]) || null : null, raw };
}

// ---------- entry points ----------

/** Share of non-empty lines a parser must explain as message headers before we trust it. */
function enough(headers: number, lines: string[], share: number): boolean {
	const nonEmpty = lines.filter((l) => l.trim()).length;
	return headers > 0 && headers >= nonEmpty * share;
}

/**
 * Recognise a chat: Telegram export (result.json or messages.html), WhatsApp export or
 * copied messages, Telegram copied messages, or any "[time] Name: message" lines.
 * Unrecognised text comes back with no messages; the caller imports it as is.
 */
export function parseChat(input: string): ParsedChat {
	const text = input.replace(/^\ufeff/, "");
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		let data: unknown;
		try {
			data = JSON.parse(trimmed);
		} catch {
			data = undefined;
		}
		if (data !== undefined) {
			const { name, raw } = parseTelegramJson(data);
			return { source: "Telegram", name, messages: finish(raw) };
		}
	}
	if (/<div class="message /.test(text)) {
		const { name, raw } = parseTelegramHtml(text);
		return { source: "Telegram", name, messages: finish(raw) };
	}
	const lines = text.split(/\r?\n/).map(cleanLine);
	const wa = lines.filter((l) => WA_HEAD.test(l)).length;
	if (enough(wa, lines, 0.1)) return { source: "WhatsApp", name: null, messages: finish(parseWhatsApp(lines)) };
	const tg = lines.filter((l) => TG_COPY_HEAD.test(l)).length;
	if (enough(tg, lines, 0.15)) return { source: "Telegram", name: null, messages: finish(parseTelegramCopy(lines)) };
	const generic = lines.filter((l) => GENERIC.test(l)).length;
	if (generic >= 2 && enough(generic, lines, 0.3)) return { source: "Chat", name: null, messages: finish(parseGeneric(lines)) };
	return { source: "Chat", name: null, messages: [] };
}

/** The chat partner's name from a WhatsApp export's file name ("WhatsApp Chat with Alice.txt"). */
export function chatNameFromFile(fileName: string): string | null {
	const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(txt|zip|json|html?)$/i, "");
	const m = base.match(/^WhatsApp Chat (?:with |- )\s*(.+)$/i);
	return m ? m[1].trim() || null : null;
}

/** Keep messages on or between the given days (YYYY-MM-DD, either may be empty). Undated messages stay. */
export function filterByDate(messages: ChatMessage[], from?: string, to?: string): ChatMessage[] {
	return messages.filter((m) => !m.date || ((!from || m.date >= from) && (!to || m.date <= to)));
}

export function chatStats(messages: ChatMessage[]): { senders: string[]; first: string | null; last: string | null } {
	const counts = new Map<string, number>();
	for (const m of messages) counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
	const dates = messages.map((m) => m.date).filter((d): d is string => !!d).sort();
	return {
		senders: [...counts].sort((a, b) => b[1] - a[1]).map(([s]) => s),
		first: dates[0] ?? null,
		last: dates[dates.length - 1] ?? null,
	};
}

/**
 * One line per message, "[10:15] Alice: text", with a "--- 2026-11-20 (Friday) ---" line
 * whenever the day changes. `rename` maps senders to other names (e.g. your chat name to yours).
 */
export function formatChat(messages: ChatMessage[], rename: Record<string, string> = {}): string {
	const out: string[] = [];
	let day: string | null = null;
	for (const m of messages) {
		if (m.date && m.date !== day) {
			day = m.date;
			out.push(`--- ${m.date} (${WEEKDAYS[new Date(m.date + "T12:00:00Z").getUTCDay()]}) ---`);
		}
		const text = m.text
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.join(" / ");
		out.push(`${m.time ? `[${m.time}] ` : ""}${rename[m.sender] ?? m.sender}: ${text}`);
	}
	return out.join("\n");
}
