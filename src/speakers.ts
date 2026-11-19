// Pure speaker logic: merging over-split clusters, matching voices to saved people,
// and attaching speaker names to Whisper's transcript segments. No Obsidian / fs imports.

export interface DiarSegment {
	start: number; // seconds
	end: number;
	speaker: number;
}

export interface SpeakerPrint {
	embedding: number[] | null;
	seconds: number;
}

export interface WhisperSegment {
	from: number; // ms
	to: number; // ms
	text: string;
}

export type VoiceProfiles = Record<string, number[][]>; // name -> saved fingerprints

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function unit(v: number[]): number[] {
	const n = Math.sqrt(v.reduce((t, x) => t + x * x, 0)) || 1;
	return v.map((x) => x / n);
}

/**
 * The separator sometimes splits one person into two "speakers".
 * Merge any clusters whose voice fingerprints are this similar (union-find, so chains merge too).
 */
export function mergeSimilarSpeakers(
	segments: DiarSegment[],
	speakers: Record<string, SpeakerPrint>,
	threshold: number,
): { segments: DiarSegment[]; speakers: Record<string, SpeakerPrint> } {
	const ids = Object.keys(speakers).map(Number);
	const parent = new Map(ids.map((i) => [i, i]));
	const find = (i: number): number => (parent.get(i) === i ? i : find(parent.get(i)!));
	for (let x = 0; x < ids.length; x++) {
		for (let y = x + 1; y < ids.length; y++) {
			const a = speakers[ids[x]].embedding;
			const b = speakers[ids[y]].embedding;
			if (a && b && cosine(a, b) >= threshold) {
				const ra = find(ids[x]);
				const rb = find(ids[y]);
				if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
			}
		}
	}
	const merged: Record<string, SpeakerPrint> = {};
	for (const id of ids) {
		const root = find(id);
		const s = speakers[id];
		const m = (merged[root] ??= { embedding: null, seconds: 0 });
		if (s.embedding) {
			// Duration-weighted average of fingerprints.
			const w = Math.max(0.1, s.seconds);
			m.embedding = m.embedding ? m.embedding.map((v, i) => v + s.embedding![i] * w) : s.embedding.map((v) => v * w);
		}
		m.seconds += s.seconds;
	}
	for (const m of Object.values(merged)) if (m.embedding) m.embedding = unit(m.embedding);
	return {
		segments: segments.map((s) => ({ ...s, speaker: find(s.speaker) })),
		speakers: merged,
	};
}

/**
 * Fold "speakers" with very little audio into the closest main speaker.
 *
 * A few seconds of speech gives an unreliable voiceprint, so clustering often splits one person
 * into many tiny speakers (a 2-person call can come back as 12). Clusters under 8 s join the most
 * similar main speaker unless they sound like nobody (similarity < 0.2). Clusters with more audio
 * but under 3% of the talk time join only if they clearly sound alike (≥ 0.45), so a real person
 * who said little in a long meeting keeps their own label.
 */
export function absorbMinorSpeakers(
	segments: DiarSegment[],
	speakers: Record<string, SpeakerPrint>,
): { segments: DiarSegment[]; speakers: Record<string, SpeakerPrint> } {
	const ids = Object.keys(speakers).map(Number);
	const total = ids.reduce((t, id) => t + speakers[id].seconds, 0);
	const minor = (id: number) => speakers[id].seconds < Math.max(8, 0.03 * total);
	const majors = ids.filter((id) => !minor(id) && speakers[id].embedding);
	if (!majors.length) return { segments, speakers };

	const into = new Map<number, number>();
	for (const id of ids) {
		const e = speakers[id].embedding;
		if (!minor(id) || !e) continue;
		let best = -1;
		let score = -Infinity;
		for (const m of majors) {
			const c = cosine(e, speakers[m].embedding!);
			if (c > score) [best, score] = [m, c];
		}
		const floor = speakers[id].seconds < 8 ? 0.2 : 0.45;
		if (score >= floor) into.set(id, best);
	}
	if (!into.size) return { segments, speakers };

	const out: Record<string, SpeakerPrint> = {};
	for (const id of ids) {
		if (into.has(id)) continue;
		out[id] = { ...speakers[id] };
	}
	// Keep the main speaker's fingerprint (it is the reliable one); add the talk time.
	for (const [from, to] of into) out[to].seconds = Math.round((out[to].seconds + speakers[from].seconds) * 10) / 10;
	return {
		segments: segments.map((s) => (into.has(s.speaker) ? { ...s, speaker: into.get(s.speaker)! } : s)),
		speakers: out,
	};
}

/** Best saved person for each speaker, if the voice is similar enough. */
export function matchVoices(
	speakers: Record<string, SpeakerPrint>,
	profiles: VoiceProfiles,
	threshold: number,
): Map<number, { name: string; score: number }> {
	const out = new Map<number, { name: string; score: number }>();
	for (const [id, s] of Object.entries(speakers)) {
		if (!s.embedding) continue;
		let best: { name: string; score: number } | null = null;
		for (const [name, prints] of Object.entries(profiles)) {
			const score = Math.max(...prints.map((p) => cosine(s.embedding!, p)), -1);
			if (score >= threshold && (!best || score > best.score)) best = { name, score };
		}
		if (best) out.set(Number(id), best);
	}
	return out;
}

/** Speaker id with the largest time overlap with [from, to] (seconds); nearest segment if none overlaps. */
export function speakerAt(from: number, to: number, segments: DiarSegment[]): number | null {
	if (!segments.length) return null;
	let best: number | null = null;
	let bestOverlap = 0;
	for (const s of segments) {
		const o = Math.min(to, s.end) - Math.max(from, s.start);
		if (o > bestOverlap) {
			bestOverlap = o;
			best = s.speaker;
		}
	}
	if (best !== null) return best;
	const mid = (from + to) / 2;
	let nearest = segments[0];
	for (const s of segments) {
		const d = Math.min(Math.abs(mid - s.start), Math.abs(mid - s.end));
		const dn = Math.min(Math.abs(mid - nearest.start), Math.abs(mid - nearest.end));
		if (d < dn) nearest = s;
	}
	return nearest.speaker;
}

export function clock(ms: number): string {
	const s = Math.floor(ms / 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Turn Whisper segments + speaker segments into transcript lines, one per speaker turn:
 *   [00:01:02] Alice: text text text
 * Unknown voices become "Speaker 1", "Speaker 2"… in order of first appearance.
 * Returns the lines and the label used for each speaker id.
 */
export function labelTranscript(
	whisper: WhisperSegment[],
	segments: DiarSegment[],
	names: Map<number, { name: string }>,
	timestamps: boolean,
): { lines: string[]; labels: Map<number, string> } {
	const labels = new Map<number, string>();
	let unknown = 0;
	const labelFor = (id: number | null): string => {
		if (id === null) return "Unknown";
		if (!labels.has(id)) labels.set(id, names.get(id)?.name ?? `Speaker ${++unknown}`);
		return labels.get(id)!;
	};
	const lines: string[] = [];
	let cur: { label: string; from: number; text: string[] } | null = null;
	const flush = () => {
		if (cur && cur.text.length) lines.push(`${timestamps ? `[${clock(cur.from)}] ` : ""}${cur.label}: ${cur.text.join(" ")}`);
	};
	for (const w of whisper) {
		const text = w.text.trim();
		if (!text) continue;
		const label = labelFor(speakerAt(w.from / 1000, w.to / 1000, segments));
		if (!cur || cur.label !== label || cur.text.join(" ").length > 1200) {
			flush();
			cur = { label, from: w.from, text: [] };
		}
		cur.text.push(text);
	}
	flush();
	return { lines, labels };
}

/** Speaker labels used in a transcript ("[00:00:01] Alice: …" or "Alice: …"), in order of appearance. */
export function transcriptSpeakers(transcript: string): { label: string; samples: string[] }[] {
	const found = new Map<string, string[]>();
	for (const line of transcript.split("\n")) {
		const m = line.match(/^(?:>\s?)?(?:\[[\d:]+\]\s+)?([^:[\]\n]{1,40}?):\s+(.+)$/);
		if (!m) continue;
		const [, label, text] = m;
		if (!found.has(label)) found.set(label, []);
		const samples = found.get(label)!;
		if (samples.length < 2) samples.push(text.length > 140 ? text.slice(0, 137) + "…" : text);
	}
	return [...found].map(([label, samples]) => ({ label, samples }));
}

/** Rename one speaker label everywhere in transcript lines (callout-prefixed or not). */
export function renameSpeaker(block: string, from: string, to: string): string {
	const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return block.replace(new RegExp(`^((?:>\\s?)?(?:\\[[\\d:]+\\]\\s+)?)${esc}:(?=\\s)`, "gm"), `$1${to}:`);
}
