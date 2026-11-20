// Pure logic: prompt building, JSON parsing, chunking and merging.
// No Obsidian imports, so it can be unit-tested with plain Node.

export interface ActionItem {
	task: string;
	owner: string | null;
	due: string | null; // YYYY-MM-DD
	priority: "high" | "medium" | "low" | null;
}

export interface Question {
	question: string;
	ask: string | null; // who should answer
}

export interface Ticket {
	title: string;
	type: "bug" | "feature" | "task" | "improvement";
	priority: "high" | "medium" | "low" | null;
	owner: string | null;
	description: string;
	acceptance_criteria: string[];
}

export interface AiAssignment {
	task: string;
	prompt: string;
}

export interface PersonNotes {
	name: string;
	summary: string; // one line: their part in this meeting
	updates: string[]; // what they reported
	commitments: string[]; // what they will do
	asks: string[]; // questions they raised / things they need
}

export interface MeetingNotes {
	title: string;
	attendees: string[];
	summary: string[];
	decisions: string[];
	action_items: ActionItem[];
	questions: Question[];
	tickets: Ticket[];
	ai_assignments: AiAssignment[];
	risks: string[];
	notes: string[];
	follow_ups: string[];
	by_person: PersonNotes[];
}

export interface ExtractInput {
	notes: string; // the user's own rough notes / pasted text
	transcript: string; // whisper transcript, may be empty
	date: string; // YYYY-MM-DD of the meeting
	myName: string;
	outputLanguage: string; // "English" or "same as the meeting"
	knownPeople: string[];
	extraInstructions: string;
	kind?: "meeting" | "chat"; // chat: WhatsApp/Telegram messages instead of a meeting transcript
}

export type ChatFn = (
	messages: { role: "system" | "user"; content: string }[],
	label: string,
) => Promise<string>;

const SCHEMA = `{
  "title": string,                 // 2-6 words, topic of the meeting, no date
  "attendees": string[],           // people who spoke or were mentioned as present
  "summary": string[],             // 3-7 bullets, the gist a busy manager needs
  "decisions": string[],           // things agreed or decided
  "action_items": [{ "task": string, "owner": string|null, "due": "YYYY-MM-DD"|null, "priority": "high"|"medium"|"low"|null }],
  "questions": [{ "question": string, "ask": string|null }],   // open / unresolved questions; "ask" = who should answer
  "tickets": [{ "title": string, "type": "bug"|"feature"|"task"|"improvement", "priority": "high"|"medium"|"low"|null, "owner": string|null, "description": string, "acceptance_criteria": string[] }],
  "ai_assignments": [{ "task": string, "prompt": string }],
  "risks": string[],               // risks, blockers, dependencies
  "notes": string[],               // facts worth remembering: numbers, names, systems, links, configs
  "follow_ups": string[],          // topics to revisit at the next meeting
  "by_person": [{ "name": string, "summary": string, "updates": string[], "commitments": string[], "asks": string[] }]
}`;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function systemPrompt(input: ExtractInput): string {
	const d = new Date(input.date + "T12:00:00");
	const weekday = isNaN(d.getTime()) ? "" : ` (${WEEKDAYS[d.getDay()]})`;
	const people = input.knownPeople.length
		? `\nKnown people (use these exact spellings when the transcript or notes clearly refer to them): ${input.knownPeople.slice(0, 200).join(", ")}.`
		: "";
	const chat = input.kind === "chat";
	const lang =
		input.outputLanguage.toLowerCase().startsWith("same")
			? `Write in the main language of the ${chat ? "chat" : "meeting"}.`
			: `Write in ${input.outputLanguage}. Keep Chinese or other non-English phrases verbatim when they carry specific meaning (names, idioms, product terms).`;
	const intro = chat
		? "You are a meticulous secretary. You turn a chat conversation (WhatsApp or Telegram messages) and the user's own notes into structured, actionable records. In the schema, \"meeting\" means this chat."
		: "You are a meticulous meeting secretary. You turn rough meeting notes and speech-to-text transcripts into structured, actionable records.";
	const dates = chat
		? `The chat's last message is on ${input.date}${weekday}. Lines like "--- 2026-11-20 (Friday) ---" give the date of the messages below them: resolve relative dates ("Friday", "next week", "tomorrow") to YYYY-MM-DD from the date of the message they appear in.`
		: `The meeting date is ${input.date}${weekday}. Resolve relative dates ("Friday", "next week", "tomorrow") to YYYY-MM-DD.`;
	const labels = chat
		? `- The transcript is the chat: one message per line, "[10:15] Name: message" (several lines of one message are joined with " / "). Sender names come from the chat export and are exact. "I"/"me" inside a message means its sender; ${input.myName}'s own messages are labelled ${input.myName}. Markers like [photo], [voice message] or [file: x] stand for media you cannot see.
- Chats ramble: skip greetings, small talk and reactions. Commitments count when someone agrees ("ok will do", "sure, by Friday").`
		: `- Transcript lines may start with a speaker label ("[00:01:02] Alice: ..."). Labels come from voice recognition: trust them for who said what, but if the content clearly contradicts a label, trust the content. "Speaker 1", "Speaker 2"… are unrecognised voices: if the conversation makes clear who they are (they are addressed by name and answer), use the real name in your output; otherwise keep the label.`;
	return `${intro}

Rules:
- Use only what the input supports. Never invent owners, dates, numbers or decisions. Use null when unknown.
- ${dates}
- The notes are written by ${input.myName}. "I", "me", "my" in the notes refer to ${input.myName}. Do NOT make ${input.myName} the owner of anything unless the input says "I"/"me" or names ${input.myName}; impersonal notes ("need to prove X") have owner null.
- attendees: only people (names or initials). Never companies, banks, clients, teams or systems. Do not add ${input.myName} unless they are mentioned.
- Input may mix languages and use shorthand: "->" usually means "leads to / next step"; short uppercase tokens may be people's initials. Speech-to-text has errors; fix obvious mis-hearings using context.
- action_items: concrete commitments and next steps, each starting with a verb, no trailing period. When several people share one task, make ONE item with owner "Name1, Name2".
- priority: null unless the input signals urgency or importance ("urgent", "asap", "blocker", "critical", "today", client escalation). Do not guess.
- decisions: only real choices or agreements ("we will use X", "agreed to drop Y"). Do not repeat action items or status updates here.
- notes: durable facts only (systems, numbers, constraints, who owns what). No meta about the meeting itself or about how you interpreted the input.
- tickets: engineering or ops work worth tracking in Jira/Linear (bugs, features, improvements). Give 1-4 testable acceptance criteria each. Small personal to-dos stay as action items only.
- ai_assignments: tasks from this meeting that an AI assistant could do or draft for ${input.myName} (write a doc, draft a message, write test cases, a script, a query, research, a comparison). "prompt" must be a complete, self-contained instruction including all needed context from the meeting, ready to paste into an AI chat.
- questions: things left unanswered or needing clarification.
${labels}
- by_person: one entry per person who ${chat ? "wrote" : "spoke"} or was given work (including ${input.myName} if they ${chat ? "wrote" : "spoke"}). summary = one line on their part in this ${chat ? "chat" : "meeting"}; updates = what they reported; commitments = what they will do; asks = questions or needs they raised. Skip people who were only mentioned in passing.
- Keep every item short and specific. Prefer more distinct items over vague merged ones. Empty arrays are fine.
- ${lang}${people}
${input.extraInstructions ? "\nAdditional instructions from the user:\n" + input.extraInstructions + "\n" : ""}
Respond with ONLY one JSON object, no prose, matching this schema:
${SCHEMA}`;
}

function userPrompt(notes: string, transcript: string, part?: { index: number; total: number }, chat = false): string {
	const parts: string[] = [];
	if (part) parts.push(`This is part ${part.index} of ${part.total} of ${chat ? "one chat conversation" : "the transcript of one meeting"}. Extract what is in this part.`);
	if (notes.trim()) parts.push(`<my_notes>\n${notes.trim()}\n</my_notes>`);
	if (transcript.trim()) parts.push(`<transcript>\n${transcript.trim()}\n</transcript>`);
	if (!notes.trim() && !transcript.trim()) parts.push("(empty)");
	return parts.join("\n\n");
}

/** Rough token estimate: CJK characters are ~1 token each, other text ~4 chars per token. */
export function estimateTokens(text: string): number {
	const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) || []).length;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Split text on line boundaries into chunks of at most `maxTokens` (estimated). */
export function chunkText(text: string, maxTokens: number): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let cur: string[] = [];
	let curTokens = 0;
	for (const line of lines) {
		const t = estimateTokens(line) + 1;
		if (curTokens + t > maxTokens && cur.length) {
			chunks.push(cur.join("\n"));
			cur = [];
			curTokens = 0;
		}
		// A single enormous line: hard-split it.
		if (t > maxTokens) {
			const size = Math.max(200, Math.floor(line.length * (maxTokens / t)));
			for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
			continue;
		}
		cur.push(line);
		curTokens += t;
	}
	if (cur.length) chunks.push(cur.join("\n"));
	return chunks;
}

const DAY_HEADER = /^--- \d{4}-\d{2}-\d{2}\b.*---$/;

/**
 * Chats mark each day once ("--- 2026-11-20 (Friday) ---"). Parts of a long chat are read
 * separately, so a part that starts mid-day gets that day's line again, or "tomorrow" in it
 * can't be dated.
 */
export function carryDayHeaders(chunks: string[]): string[] {
	let day: string | null = null;
	return chunks.map((chunk) => {
		const lines = chunk.split("\n");
		const out = day && !DAY_HEADER.test(lines.find((l) => l.trim()) ?? "") ? `${day}\n${chunk}` : chunk;
		for (const l of lines) if (DAY_HEADER.test(l)) day = l;
		return out;
	});
}

/** Pull the JSON object out of a model reply (handles <think> blocks, code fences, trailing commas). */
export function parseJsonReply(reply: string): unknown {
	let text = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	// An unclosed <think> (truncated reasoning) -> drop up to the first "{" after it.
	if (/^<think>/i.test(text)) text = text.replace(/^<think>[\s\S]*?(?=\{)/i, "");
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("The model did not return JSON.");
	const body = text.slice(start, end + 1);
	try {
		return JSON.parse(body);
	} catch {
		const repaired = body
			.replace(/,\s*([}\]])/g, "$1") // trailing commas
			.replace(/[“”]/g, '"'); // smart quotes
		return JSON.parse(repaired);
	}
}

const str = (v: unknown): string => {
	if (typeof v === "string") return v.trim();
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return v == null ? "" : JSON.stringify(v);
};
const strOrNull = (v: unknown): string | null => {
	const s = str(v);
	return s && !/^(null|none|n\/a|unknown|unassigned|tbd|-)$/i.test(s) ? s : null;
};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : v ? [v] : []);
// Models sometimes return {"text": "..."} instead of a plain string: take the first value.
const strList = (v: unknown): string[] =>
	asArray(v)
		.map((x) => (typeof x === "object" && x ? str(Object.values(x as Record<string, unknown>)[0]) : str(x)))
		.filter(Boolean);
const objList = (v: unknown): Record<string, unknown>[] =>
	(Array.isArray(v) ? (v as unknown[]) : [])
		.map((x) => (typeof x === "string" ? { task: x, question: x, title: x } : x))
		.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
const prio = <T extends string>(v: unknown, allowed: T[], fallback: T | null): T | null => {
	const s = str(v).toLowerCase();
	if ((allowed as string[]).includes(s)) return s as T;
	if (/urgent|critical|highest|p0|p1/.test(s)) return allowed.includes("high" as T) ? ("high" as T) : fallback;
	if (/p2/.test(s)) return allowed.includes("medium" as T) ? ("medium" as T) : fallback;
	if (/p3|p4/.test(s)) return allowed.includes("low" as T) ? ("low" as T) : fallback;
	return fallback;
};
const date = (v: unknown): string | null => {
	const s = str(v);
	const m = s.match(/\d{4}-\d{2}-\d{2}/);
	return m ? m[0] : null;
};

/** Coerce whatever the model returned into a well-formed MeetingNotes. */
export function normalize(raw: unknown): MeetingNotes {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const summary = Array.isArray(o.summary) ? strList(o.summary) : str(o.summary) ? [str(o.summary)] : [];
	return {
		title: str(o.title).replace(/[\r\n]+/g, " ").slice(0, 80),
		attendees: [...new Set(strList(o.attendees))],
		summary,
		decisions: strList(o.decisions),
		action_items: objList(o.action_items)
			.map((a) => ({
				task: str(a.task ?? a.action ?? a.item),
				owner: strOrNull(a.owner ?? a.assignee),
				due: date(a.due ?? a.due_date ?? a.deadline),
				priority: prio(a.priority, ["high", "medium", "low"], null),
			}))
			.filter((a) => a.task),
		questions: objList(o.questions)
			.map((q) => ({ question: str(q.question ?? q.text), ask: strOrNull(q.ask ?? q.owner ?? q.who) }))
			.filter((q) => q.question),
		tickets: objList(o.tickets)
			.map((t) => {
				const type = str(t.type).toLowerCase();
				return {
					title: str(t.title ?? t.summary),
					type: (["bug", "feature", "task", "improvement"].includes(type) ? type : "task") as Ticket["type"],
					priority: prio(t.priority, ["high", "medium", "low"], null),
					owner: strOrNull(t.owner ?? t.assignee),
					description: str(t.description),
					acceptance_criteria: strList(t.acceptance_criteria ?? t.acceptance),
				};
			})
			.filter((t) => t.title),
		ai_assignments: objList(o.ai_assignments)
			.map((a) => ({ task: str(a.task ?? a.title), prompt: str(a.prompt) }))
			.filter((a) => a.task),
		risks: strList(o.risks),
		notes: strList(o.notes),
		follow_ups: strList(o.follow_ups),
		by_person: objList(o.by_person)
			.map((p) => ({
				name: str(p.name),
				summary: str(p.summary),
				updates: strList(p.updates),
				commitments: strList(p.commitments),
				asks: strList(p.asks),
			}))
			.filter((p) => p.name),
	};
}

// ---------- priority enforcement ----------
// The model tends to invent priorities. A priority is kept only when a line of the
// source text both contains an urgency (or low-priority) phrase and mentions the item.

const HIGH_WORDS =
	/\b(urgent(ly)?|asap|a\.s\.a\.p|blocker|blocking|blocked|critical|immediately|top priority|high priority|p0|p1|today|tonight|eod|end of day|escalat\w*|segera|cepat)\b|紧急|马上|立刻|尽快|今天/i;
const LOW_WORDS = /\b(low priority|nice to have|not urgent|no rush|someday|backlog|p3|p4|tak urgent)\b|不急/i;
const MEDIUM_WORDS = /\b(medium priority|normal priority|p2)\b/i;

const STOPWORDS = new Set(
	"the and for with that this from have need needs will should into about after before them they their there then than what when where which while also more less make sure add get got use used using issue issues problem item items task tasks update check team meeting someone".split(" "),
);

function keywords(text: string): Set<string> {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
	return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

function sourceLines(source: string): string[] {
	// Split after sentence ends without a lookbehind (iOS before 16.4 can't run those).
	return source.replace(/([.!?。！？])\s+/g, "$1\n").split("\n").filter((l) => l.trim());
}

/** Returns the priority justified by the source for an item described by `text`, or null. */
export function justifiedPriority(text: string, source: string): "high" | "medium" | "low" | null {
	const itemWords = keywords(text);
	const mentions = (line: string) => [...keywords(line)].some((w) => itemWords.has(w));
	for (const [re, level] of [
		[HIGH_WORDS, "high"],
		[LOW_WORDS, "low"],
		[MEDIUM_WORDS, "medium"],
	] as const) {
		if (sourceLines(source).some((l) => re.test(l) && mentions(l))) return level;
	}
	return null;
}

/** Drop any priority the source text doesn't back up with an urgency word about that item. */
export function enforcePriorities(m: MeetingNotes, source: string): MeetingNotes {
	const keep = <P extends "high" | "medium" | "low" | null>(p: P, text: string) => {
		if (!p) return null;
		return justifiedPriority(text, source);
	};
	return {
		...m,
		action_items: m.action_items.map((a) => ({ ...a, priority: keep(a.priority, a.task) })),
		tickets: m.tickets.map((t) => ({ ...t, priority: keep(t.priority, t.title) })),
	};
}

async function askJson(chat: ChatFn, system: string, user: string, label: string): Promise<MeetingNotes> {
	const messages = [
		{ role: "system" as const, content: system },
		{ role: "user" as const, content: user },
	];
	const reply = await chat(messages, label);
	try {
		return normalize(parseJsonReply(reply));
	} catch {
		// One retry with a firmer reminder.
		const retry = await chat(
			[...messages, { role: "user", content: "Your previous reply was not valid JSON. Reply again with ONLY the JSON object." }],
			label + " (retry)",
		);
		return normalize(parseJsonReply(retry));
	}
}

/**
 * Run extraction. Short meetings take one call; long transcripts are split into parts,
 * extracted separately, then merged by one more call.
 */
export async function extractMeeting(
	chat: ChatFn,
	input: ExtractInput,
	maxInputTokens: number,
): Promise<MeetingNotes> {
	const result = await extractRaw(chat, input, maxInputTokens);
	return enforcePriorities(result, `${input.notes}\n${input.transcript}`);
}

async function extractRaw(chat: ChatFn, input: ExtractInput, maxInputTokens: number): Promise<MeetingNotes> {
	const system = systemPrompt(input);
	const isChat = input.kind === "chat";
	const budget = Math.max(2000, maxInputTokens - estimateTokens(system) - estimateTokens(input.notes) - 500);
	const chunks = input.transcript.trim() ? chunkText(input.transcript, budget) : [""];
	const transcriptChunks = isChat ? carryDayHeaders(chunks) : chunks;

	if (transcriptChunks.length === 1) {
		return askJson(chat, system, userPrompt(input.notes, transcriptChunks[0]), isChat ? "Analysing chat" : "Analysing meeting");
	}

	const partials: MeetingNotes[] = [];
	for (let i = 0; i < transcriptChunks.length; i++) {
		partials.push(
			await askJson(
				chat,
				system,
				userPrompt(input.notes, transcriptChunks[i], { index: i + 1, total: transcriptChunks.length }, isChat),
				`Analysing part ${i + 1}/${transcriptChunks.length}`,
			),
		);
	}
	const mergeUser =
		`Below are ${partials.length} partial extractions from consecutive parts of ONE ${isChat ? "chat conversation" : "meeting"}. ` +
		`Merge them into one JSON object with the same schema: remove duplicates, keep every distinct item, ` +
		`write one overall title and summary.\n\n` +
		partials.map((p, i) => `<part n="${i + 1}">\n${JSON.stringify(p)}\n</part>`).join("\n");
	try {
		return await askJson(chat, system, mergeUser, "Merging parts");
	} catch {
		return mergeLocally(partials);
	}
}

/** Fallback merge without the LLM: concatenate and de-duplicate. */
export function mergeLocally(parts: MeetingNotes[]): MeetingNotes {
	const uniq = <T>(items: T[], key: (t: T) => string) => {
		const seen = new Set<string>();
		return items.filter((t) => {
			const k = key(t).toLowerCase().replace(/\W+/g, " ").trim();
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	};
	const all = <K extends keyof MeetingNotes>(k: K) => parts.flatMap((p) => p[k] as unknown as unknown[]);
	return {
		title: parts.find((p) => p.title)?.title ?? "",
		attendees: uniq(all("attendees") as string[], (s) => s),
		summary: all("summary") as string[],
		decisions: uniq(all("decisions") as string[], (s) => s),
		action_items: uniq(all("action_items") as ActionItem[], (a) => a.task),
		questions: uniq(all("questions") as Question[], (q) => q.question),
		tickets: uniq(all("tickets") as Ticket[], (t) => t.title),
		ai_assignments: uniq(all("ai_assignments") as AiAssignment[], (a) => a.task),
		risks: uniq(all("risks") as string[], (s) => s),
		notes: uniq(all("notes") as string[], (s) => s),
		follow_ups: uniq(all("follow_ups") as string[], (s) => s),
		by_person: Object.values(
			(all("by_person") as PersonNotes[]).reduce<Record<string, PersonNotes>>((acc, p) => {
				const k = p.name.toLowerCase();
				const cur = (acc[k] ??= { name: p.name, summary: p.summary, updates: [], commitments: [], asks: [] });
				cur.updates.push(...p.updates);
				cur.commitments.push(...p.commitments);
				cur.asks.push(...p.asks);
				return acc;
			}, {}),
		),
	};
}
