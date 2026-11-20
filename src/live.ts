// Live transcript while recording. The recorder's audio is decoded as it arrives (ffmpeg reading
// from a pipe), and every ~12 seconds the newest piece goes through whisper-cli. The result is a
// draft without speaker names; the full transcription after the recording stops replaces it.
import { type ChildProcess, childProcess, fs, os, path } from "./node.ts";
import { RATE, chunkWindow, contextTail, findCut, rms, splitSentences, wavFile } from "./live-audio.ts";
import { isHallucination } from "./render.ts";
import { type WhisperConfig, expandHome, run } from "./transcribe.ts";

export interface LiveLine {
	seconds: number; // from the start of the recording
	text: string;
}

const SILENCE = 60; // RMS below this is treated as silence and not sent to Whisper
const LOCK_LANGUAGE = 0.8; // language detection confidence needed to stop re-detecting

export class LiveTranscriber {
	readonly lines: LiveLine[] = [];
	error: string | null = null;

	private ffmpeg: ChildProcess | null = null;
	private pcm: Buffer[] = [];
	private pcmBytes = 0;
	private pendingStartSec = 0;
	private busy = false;
	private stopped = false;
	/** Set when recording paused or stopped: transcribe whatever is waiting, however short. */
	private flushing = false;
	private finished: (() => void) | null = null;
	private readonly ctrl = new AbortController();
	private readonly dir: string;
	private language: string | null;
	private readonly cfg: WhisperConfig;
	private readonly onUpdate: () => void;

	constructor(cfg: WhisperConfig, onUpdate: () => void) {
		this.cfg = cfg;
		this.onUpdate = onUpdate;
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-note-live-"));
		this.language = cfg.language && cfg.language !== "auto" ? cfg.language : null;
	}

	get listening(): boolean {
		return !this.stopped && !this.error;
	}

	start(): void {
		const ff = childProcess.spawn(expandHome(this.cfg.ffmpegPath), ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "pipe:1"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.ffmpeg = ff;
		ff.stdout?.on("data", (d: Buffer) => {
			this.pcm.push(d);
			this.pcmBytes += d.length;
			this.next();
		});
		ff.on("error", (e) => this.fail("ffmpeg: " + e.message));
		ff.on("close", () => {
			if (this.finished) {
				this.flushing = true;
				this.next();
			}
		});
		ff.stdin?.on("error", () => {
			/* ffmpeg exited; reported through "error" or ignored after stop */
		});
	}

	/** Recorded audio, exactly as written to the recording file. */
	push(chunk: Buffer): void {
		if (this.stopped || !this.ffmpeg?.stdin?.writable) return;
		this.ffmpeg.stdin.write(chunk);
	}

	/** Recording paused: show what was said so far instead of waiting for a full chunk. */
	flush(): void {
		this.flushing = true;
		this.next();
	}

	/**
	 * Recording stopped: transcribe the last few seconds, then stop. Resolves when done
	 * (at most a few seconds; `stop()` cuts it short).
	 */
	finish(): Promise<void> {
		if (this.stopped || !this.ffmpeg) {
			this.stop();
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.finished = () => {
				this.stop();
				resolve();
			};
			this.ffmpeg?.stdin?.end(); // ffmpeg decodes what is left, then closes
			window.setTimeout(() => this.finished?.(), 15000);
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.ctrl.abort();
		this.ffmpeg?.stdin?.end();
		this.ffmpeg?.kill();
		this.ffmpeg = null;
		this.pcm = [];
		fs.rmSync(this.dir, { recursive: true, force: true });
		const done = this.finished;
		this.finished = null;
		done?.();
	}

	private fail(message: string): void {
		if (this.stopped) return;
		this.error = message;
		this.stop();
		this.onUpdate();
	}

	/** Send the next chunk to Whisper when enough audio is waiting and Whisper is free. */
	private next(): void {
		if (this.busy || this.stopped) return;
		const pendingSec = this.pcmBytes / 2 / RATE;
		let win = chunkWindow(pendingSec);
		if (!win && this.flushing && pendingSec >= 1) win = { minSec: pendingSec, maxSec: pendingSec };
		if (!win) {
			this.flushing = false;
			if (this.finished && !this.ffmpeg?.stdout?.readable) this.finished();
			return;
		}

		const all = Buffer.concat(this.pcm);
		// Copy into an aligned buffer: a Buffer's offset into its memory pool may be odd.
		const samples = new Int16Array(all.buffer.slice(all.byteOffset, all.byteOffset + (all.length & ~1)));
		const cut = findCut(samples, win.minSec, win.maxSec);
		const chunk = samples.slice(0, cut);
		const rest = all.subarray(cut * 2);
		this.pcm = rest.length ? [Buffer.from(rest)] : [];
		this.pcmBytes = rest.length;
		const startSec = this.pendingStartSec;
		this.pendingStartSec += cut / RATE;

		if (rms(chunk) < SILENCE) {
			this.next();
			return;
		}
		this.busy = true;
		this.transcribe(chunk, startSec)
			.catch((e: Error) => {
				if (!this.stopped) this.fail(e.message);
			})
			.finally(() => {
				this.busy = false;
				this.next();
			});
	}

	private async transcribe(chunk: Int16Array, startSec: number): Promise<void> {
		const wav = path.join(this.dir, "chunk.wav");
		const out = path.join(this.dir, "chunk");
		fs.writeFileSync(wav, wavFile(chunk));
		const args = [
			"-m", expandHome(this.cfg.modelPath),
			"-f", wav,
			"-l", this.language ?? "auto",
			"-t", String(Math.min(8, Math.max(2, os.cpus().length - 2))),
			"-oj",
			"-of", out,
		];
		const prompt = [this.cfg.prompt.trim(), contextTail(this.lines.slice(-4).map((l) => l.text))].filter(Boolean).join(". ");
		if (prompt) args.push("--prompt", prompt.slice(-600));
		if (this.cfg.vadModelPath && fs.existsSync(expandHome(this.cfg.vadModelPath))) {
			args.push("--vad", "-vm", expandHome(this.cfg.vadModelPath));
		}
		let detected: { lang: string; p: number } | null = null;
		await run(
			expandHome(this.cfg.whisperPath),
			args,
			(line) => {
				const m = line.match(/auto-detected language: (\w+) \(p = ([\d.]+)\)/);
				if (m) detected = { lang: m[1], p: Number(m[2]) };
			},
			this.ctrl.signal,
		);
		if (this.stopped) return;

		const json = JSON.parse(fs.readFileSync(out + ".json", "utf8")) as {
			transcription?: { offsets?: { from: number; to: number }; text: string }[];
		};
		// Keep a confidently detected language so short pieces don't flip between languages.
		// A 12-second piece can be misjudged, so an unsure guess is not kept.
		const guess = detected as { lang: string; p: number } | null;
		if (!this.language && guess && guess.p >= LOCK_LANGUAGE) this.language = guess.lang;
		let added = 0;
		for (const s of json.transcription ?? []) {
			const text = s.text.trim();
			if (!text || isHallucination(text)) continue;
			const from = startSec + (s.offsets?.from ?? 0) / 1000;
			const to = startSec + (s.offsets?.to ?? 0) / 1000;
			for (const line of splitSentences(text, from, to)) this.lines.push(line);
			added++;
		}
		if (added) this.onUpdate();
	}
}
