// Pure helpers for the live transcript: where to cut the audio, and how to write a WAV.

export const RATE = 16000; // samples per second (16 kHz mono, 16-bit)

/** Root-mean-square level of 16-bit samples (0 – 32768). */
export function rms(samples: Int16Array, from = 0, to = samples.length): number {
	if (to <= from) return 0;
	let sum = 0;
	for (let i = from; i < to; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / (to - from));
}

/**
 * The sample index to cut at: the quietest 200 ms between `minSec` and `maxSec`, so a chunk
 * ends in a pause rather than in the middle of a word.
 */
export function findCut(samples: Int16Array, minSec: number, maxSec: number): number {
	const win = RATE / 5; // 200 ms
	const step = RATE / 20; // 50 ms
	const lo = Math.max(0, Math.floor(minSec * RATE));
	const hi = Math.min(samples.length, Math.floor(maxSec * RATE));
	if (hi - lo < win) return hi;
	let best = hi;
	let bestLevel = Infinity;
	for (let start = lo; start + win <= hi; start += step) {
		const level = rms(samples, start, start + win);
		if (level < bestLevel) {
			bestLevel = level;
			best = start + win / 2;
		}
	}
	return best;
}

/** How much pending audio to send now, in seconds, or null to wait for more. */
export function chunkWindow(pendingSec: number, targetSec = 12, maxSec = 28): { minSec: number; maxSec: number } | null {
	if (pendingSec < targetSec) return null;
	const hi = Math.min(pendingSec, maxSec);
	return { minSec: Math.max(6, hi - 6), maxSec: hi };
}

/** A complete WAV file (16 kHz mono 16-bit) holding `samples`. */
export function wavFile(samples: Int16Array): Uint8Array {
	const data = samples.length * 2;
	const out = new Uint8Array(44 + data);
	const v = new DataView(out.buffer);
	const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
	ascii(0, "RIFF");
	v.setUint32(4, 36 + data, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, RATE, true);
	v.setUint32(28, RATE * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	ascii(36, "data");
	v.setUint32(40, data, true);
	new Int16Array(out.buffer, 44, samples.length).set(samples);
	return out;
}

/** The last few words of the transcript so far, given to Whisper as context for the next chunk. */
export function contextTail(texts: string[], maxChars = 160): string {
	const all = texts.join(" ").replace(/\s+/g, " ").trim();
	if (all.length <= maxChars) return all;
	const cut = all.slice(-maxChars);
	const space = cut.indexOf(" ");
	return space === -1 ? cut : cut.slice(space + 1);
}

/**
 * Split a Whisper segment into sentences, each timed by where it falls in the segment, so a
 * long passage reads as separate lines.
 */
export function splitSentences(text: string, fromSec: number, toSec: number): { seconds: number; text: string }[] {
	const clean = text.replace(/\s+/g, " ").trim();
	const parts = clean.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) ?? [clean];
	const out: { seconds: number; text: string }[] = [];
	let at = 0;
	for (const part of parts) {
		const t = part.trim();
		if (t) out.push({ seconds: fromSec + (Math.max(0, toSec - fromSec) * at) / Math.max(1, clean.length), text: t });
		at += part.length;
	}
	return out;
}
