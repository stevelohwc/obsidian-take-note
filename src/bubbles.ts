// The actions the floating button can show as bubbles on hover. Which ones, and in what
// order, is a setting; what each does lives in main.ts.

export const BUBBLES = {
	note: { short: "Current note", icon: "file-text", name: "Go to the current note", desc: "The note being recorded, else the open meeting note, else the last one you edited." },
	record: { short: "Record", icon: "mic", name: "Record / stop", desc: "Records into the open meeting note, else a new one. Stops while recording." },
	recordNew: { short: "Record new", icon: "mic-vocal", name: "Record in a new note", desc: "Always starts a new meeting note, even when one is open. Stops while recording." },
	transcript: { short: "Transcript", icon: "scroll-text", name: "Show the transcript", desc: "Opens the current note with the sidebar on its Transcript tab." },
	import: { short: "Import", icon: "import", name: "Import…", desc: "A small menu: import a chat or a recording." },
	importChat: { short: "Import chat", icon: "messages-square", name: "Import a chat", desc: "WhatsApp or Telegram export, or pasted messages." },
	importRecording: { short: "Import recording", icon: "upload", name: "Import a recording", desc: "An audio or video file, transcribed into a new note." },
	summarize: { short: "Summarize", icon: "sparkles", name: "Summarize with AI", desc: "Runs the AI on the open note. Shown only when a note is open." },
	pause: { short: "Pause", icon: "pause", name: "Pause / resume", desc: "Shown only while recording." },
	speakers: { short: "Speakers", icon: "users", name: "Name the speakers", desc: "Shown only when a note is open." },
	sidebar: { short: "Sidebar", icon: "panel-right", name: "Open the sidebar", desc: "The Take Note panel: summary, transcript and your notes." },
	newNote: { short: "New note", icon: "file-plus", name: "New meeting note", desc: "An empty meeting note, without recording." },
	cancel: { short: "Cancel", icon: "x", name: "Cancel the running job", desc: "Shown only while transcription or the AI is running." },
} as const;

export type BubbleId = keyof typeof BUBBLES;

export type Side = "left" | "top" | "right" | "bottom";
export const SIDES: Side[] = ["left", "top", "right", "bottom"];
/** Bubbles per side of the button, each list nearest the button first. */
export type BubbleLayout = Record<Side, BubbleId[]>;

export const PER_SIDE = 5;
export const DEFAULT_LAYOUT: BubbleLayout = { left: ["note", "record", "transcript", "import"], top: [], right: [], bottom: [] };

export function isBubbleId(id: unknown): id is BubbleId {
	return typeof id === "string" && Object.keys(BUBBLES).includes(id);
}

export function copyLayout(l: BubbleLayout): BubbleLayout {
	return { left: [...l.left], top: [...l.top], right: [...l.right], bottom: [...l.bottom] };
}

/**
 * A clean layout from saved settings: known bubbles only, each once, at most PER_SIDE a side.
 * `legacy` is the old single list (a row of 5 left of the button, then 5 above it).
 */
export function normalizeLayout(raw: unknown, legacy?: unknown): BubbleLayout {
	const out: BubbleLayout = { left: [], top: [], right: [], bottom: [] };
	const seen = new Set<BubbleId>();
	const take = (side: Side, ids: unknown) => {
		if (!Array.isArray(ids)) return;
		for (const id of ids) {
			if (!isBubbleId(id) || seen.has(id) || out[side].length >= PER_SIDE) continue;
			seen.add(id);
			out[side].push(id);
		}
	};
	if (raw && typeof raw === "object") {
		const r = raw as Partial<Record<Side, unknown>>;
		SIDES.forEach((side) => take(side, r[side]));
		return out;
	}
	if (Array.isArray(legacy)) {
		take("left", legacy.slice(0, PER_SIDE));
		take("top", legacy.slice(PER_SIDE));
		return out;
	}
	return copyLayout(DEFAULT_LAYOUT);
}

/** Which side a bubble is on, if any. */
export function sideOf(l: BubbleLayout, id: BubbleId): Side | null {
	return SIDES.find((side) => l[side].includes(id)) ?? null;
}

/**
 * Put `id` on `side` at `index` (0 = next to the button), taking it off wherever it was.
 * Returns null when that side is already full.
 */
export function placeBubble(l: BubbleLayout, id: BubbleId, side: Side, index: number): BubbleLayout | null {
	const next = copyLayout(l);
	const from = sideOf(next, id);
	if (from !== side && next[side].length >= PER_SIDE) return null;
	if (from) {
		const at = next[from].indexOf(id);
		next[from].splice(at, 1);
		if (from === side && at < index) index--;
	}
	next[side].splice(Math.max(0, Math.min(index, next[side].length)), 0, id);
	return next;
}

export function removeBubble(l: BubbleLayout, id: BubbleId): BubbleLayout {
	const next = copyLayout(l);
	SIDES.forEach((side) => (next[side] = next[side].filter((x) => x !== id)));
	return next;
}

/** The first side with room, for adding by click: left, then top, right, bottom. */
export function sideWithRoom(l: BubbleLayout): Side | null {
	return SIDES.find((side) => l[side].length < PER_SIDE) ?? null;
}

/**
 * Near a window edge a side may not fit: mirror left/right (or top/bottom) when that leaves
 * less off screen. `space` is the room on each side of the button, `need(n)` what n bubbles take.
 */
export function flipSides(counts: Record<Side, number>, space: Record<Side, number>, need: (n: number) => number): { x: boolean; y: boolean } {
	const over = (n: number, room: number) => Math.max(0, need(n) - room);
	const flip = (a: Side, b: Side) =>
		over(counts[a], space[b]) + over(counts[b], space[a]) < over(counts[a], space[a]) + over(counts[b], space[b]);
	return { x: flip("left", "right"), y: flip("top", "bottom") };
}
