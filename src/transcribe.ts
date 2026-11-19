// Local speech-to-text with whisper.cpp (whisper-cli) + ffmpeg, and optional speaker
// separation with sherpa-onnx. Runs entirely on this Mac.
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cleanTranscript, isHallucination } from "./render.ts";
import {
	type DiarSegment,
	type SpeakerPrint,
	type VoiceProfiles,
	type WhisperSegment,
	clock,
	labelTranscript,
	matchVoices,
	mergeSimilarSpeakers,
	absorbMinorSpeakers,
} from "./speakers.ts";
import { helperHome } from "./voices.ts";

export interface WhisperConfig {
	ffmpegPath: string;
	whisperPath: string;
	modelPath: string;
	vadModelPath: string; // optional; enables --vad when the file exists
	language: string; // "auto", "en", "ms", "zh", ...
	prompt: string; // vocabulary hint: names, products, jargon
	timestamps: boolean;
}

export interface SpeakerConfig {
	nodePath: string; // resolved node binary
	helperSource: string; // source of helper/speakers.cjs, run with `node -e` (nothing is written to disk)
	numSpeakers: number; // 0 = auto
	clusterThreshold: number;
	mergeThreshold: number;
	matchThreshold: number;
	profiles: VoiceProfiles;
}

export interface TranscriptResult {
	text: string;
	durationSec: number;
	language: string | null;
	/** Present when speakers were separated: fingerprints keyed by transcript label. */
	speakers?: Record<string, SpeakerPrint>;
	recognised?: string[]; // labels matched to saved voices
	speakerError?: string; // separation failed; transcript is still usable
}

export function expandHome(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Returns a list of human-readable problems with the local setup (empty = OK). */
export function checkWhisperSetup(cfg: WhisperConfig): string[] {
	const problems: string[] = [];
	if (!fs.existsSync(expandHome(cfg.ffmpegPath))) problems.push(`ffmpeg not found at ${cfg.ffmpegPath} (brew install ffmpeg)`);
	if (!fs.existsSync(expandHome(cfg.whisperPath))) problems.push(`whisper-cli not found at ${cfg.whisperPath} (brew install whisper-cpp)`);
	if (!fs.existsSync(expandHome(cfg.modelPath))) problems.push(`Whisper model not found at ${cfg.modelPath}`);
	return problems;
}

export function run(
	cmd: string,
	args: string[],
	onStderr?: (line: string) => void,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr?.on("data", (d: Buffer) => {
			const s = d.toString();
			stderr += s;
			if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
			if (onStderr) for (const l of s.split(/\r?\n|\r/)) if (l) onStderr(l);
		});
		const abort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", reject);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) reject(new Error("Cancelled"));
			else if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${path.basename(cmd)} exited with code ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
		});
	});
}

/** Convert any audio/video file to 16 kHz mono WAV. Returns the duration in seconds. */
export async function toWav(cfg: Pick<WhisperConfig, "ffmpegPath">, input: string, wav: string, signal?: AbortSignal): Promise<number> {
	let durationSec = 0;
	await run(
		expandHome(cfg.ffmpegPath),
		["-y", "-hide_banner", "-i", input, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
		(line) => {
			const m = line.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
			if (m) durationSec = +m[1] * 3600 + +m[2] * 60 + +m[3];
		},
		signal,
	);
	return durationSec || Math.max(0, (fs.statSync(wav).size - 44) / 32000);
}

function helperEnv(): NodeJS.ProcessEnv {
	const lib = path.join(helperHome(), "node_modules", `sherpa-onnx-${process.platform}-${process.arch}`);
	return { ...process.env, TAKE_NOTE_HOME: helperHome(), DYLD_LIBRARY_PATH: [lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":") };
}

/** Voice fingerprint of a WAV file (used for voice samples). */
export async function embedWav(sp: Pick<SpeakerConfig, "nodePath" | "helperSource">, wav: string): Promise<number[]> {
	const { stdout } = await run(sp.nodePath, ["-e", sp.helperSource, "embed", wav], undefined, undefined, helperEnv());
	return (JSON.parse(stdout) as { embedding: number[] }).embedding;
}

/**
 * Transcribe any audio/video file ffmpeg can read, optionally labelling who spoke.
 * onProgress receives a 0-100 percentage and a stage label.
 */
export async function transcribeFile(
	inputPath: string,
	cfg: WhisperConfig,
	onProgress: (pct: number, stage: string) => void,
	signal?: AbortSignal,
	speakers?: SpeakerConfig,
): Promise<TranscriptResult> {
	const problems = checkWhisperSetup(cfg);
	if (problems.length) throw new Error(problems.join("; "));

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-note-"));
	const wav = path.join(dir, "audio.wav");
	const outBase = path.join(dir, "out");
	try {
		onProgress(0, "Converting audio");
		const durationSec = await toWav(cfg, inputPath, wav, signal);

		// Speaker separation runs in parallel with Whisper (different CPU-bound processes).
		const diarization = speakers
			? run(speakers.nodePath, ["-e", speakers.helperSource, "diarize", wav, String(speakers.numSpeakers), String(speakers.clusterThreshold)], undefined, signal, helperEnv())
					.then(({ stdout }) => JSON.parse(stdout) as { segments: DiarSegment[]; speakers: Record<string, SpeakerPrint> })
					.catch((e: Error) => e)
			: null;

		const args = [
			"-m", expandHome(cfg.modelPath),
			"-f", wav,
			"-l", cfg.language || "auto",
			"-t", String(Math.min(8, Math.max(2, os.cpus().length - 2))),
			"-pp",
			"-oj",
			"-of", outBase,
			"-mc", "64", // limit carried context: avoids whisper's repetition loops on long audio
		];
		if (cfg.prompt.trim()) args.push("--prompt", cfg.prompt.trim().slice(0, 600));
		if (cfg.vadModelPath && fs.existsSync(expandHome(cfg.vadModelPath))) {
			args.push("--vad", "-vm", expandHome(cfg.vadModelPath));
		}

		let language: string | null = null;
		onProgress(1, "Transcribing");
		await run(
			expandHome(cfg.whisperPath),
			args,
			(line) => {
				const p = line.match(/progress =\s*(\d+)%/);
				if (p) onProgress(Math.min(99, +p[1]), "Transcribing");
				const l = line.match(/auto-detected language: (\w+)/);
				if (l) language = l[1];
			},
			signal,
		);

		const json = JSON.parse(fs.readFileSync(outBase + ".json", "utf8")) as {
			transcription?: { offsets?: { from: number; to: number }; text: string }[];
			result?: { language?: string };
		};
		const whisper: WhisperSegment[] = (json.transcription ?? []).map((s) => ({
			from: s.offsets?.from ?? 0,
			to: s.offsets?.to ?? 0,
			text: s.text,
		})).filter((s) => !isHallucination(s.text));
		language = language ?? json.result?.language ?? null;

		const result: TranscriptResult = { text: "", durationSec, language };

		const diar = diarization ? await (onProgress(99, "Separating speakers"), diarization) : null;
		if (diar && !(diar instanceof Error) && speakers && diar.segments.length) {
			let merged = mergeSimilarSpeakers(diar.segments, diar.speakers, speakers.mergeThreshold);
			// With a fixed speaker count the clustering already did what was asked.
			if (!speakers.numSpeakers) merged = absorbMinorSpeakers(merged.segments, merged.speakers);
			const names = matchVoices(merged.speakers, speakers.profiles, speakers.matchThreshold);
			const { lines, labels } = labelTranscript(whisper, merged.segments, names, cfg.timestamps);
			result.text = cleanTranscript(lines).join("\n");
			result.speakers = {};
			result.recognised = [];
			for (const [id, label] of labels) {
				// Two voice groups can match the same saved person: keep one entry, with the
				// fingerprint of whichever group spoke longer and the talk time of both.
				const print = merged.speakers[id];
				const prev = result.speakers[label];
				if (!prev) result.speakers[label] = { ...print };
				else result.speakers[label] = { embedding: (print.seconds > prev.seconds ? print : prev).embedding, seconds: Math.round((prev.seconds + print.seconds) * 10) / 10 };
				if (names.has(id) && !result.recognised.includes(label)) result.recognised.push(label);
			}
		} else {
			if (diar instanceof Error) result.speakerError = diar.message;
			result.text = cleanTranscript(
				whisper.map((s) => (cfg.timestamps ? `[${clock(s.from)}] ${s.text.trim()}` : s.text.trim())),
			).join("\n");
		}
		onProgress(100, "Done");
		return result;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
