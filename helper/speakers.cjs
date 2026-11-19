#!/usr/bin/env node
// Speaker separation + voice fingerprints for Take Note, using sherpa-onnx.
// Runs as a separate Node process (Obsidian can't host heavy native work on its UI thread).
//
//   node speakers.cjs diarize <16k-mono.wav> [numSpeakers] [clusterThreshold]
//     -> {"segments":[{start,end,speaker}], "speakers":{"0":{"embedding":[...],"seconds":n}}}
//   node speakers.cjs embed <16k-mono.wav>
//     -> {"embedding":[...], "seconds":n}
//
// TAKE_NOTE_HOME (default ~/.take-note) must contain node_modules/sherpa-onnx-node and models/.
"use strict";
const path = require("path");
const os = require("os");

const home = process.env.TAKE_NOTE_HOME || path.join(os.homedir(), ".take-note");
const sherpa = require(path.join(home, "node_modules", "sherpa-onnx-node"));
const SEG_MODEL = path.join(home, "models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx");
const EMB_MODEL = path.join(home, "models", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx");
const THREADS = Math.min(8, Math.max(2, os.cpus().length - 2));

function log(msg) {
	process.stderr.write(msg + "\n");
}

function readSamples(file) {
	const wave = sherpa.readWave(file);
	if (wave.sampleRate !== 16000) throw new Error(`expected 16 kHz audio, got ${wave.sampleRate}`);
	return wave.samples;
}

function normalize(v) {
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n) || 1;
	return Array.from(v, (x) => Math.round((x / n) * 1e5) / 1e5);
}

let extractor = null;
function embedSamples(samples) {
	if (!extractor) extractor = new sherpa.SpeakerEmbeddingExtractor({ model: EMB_MODEL, numThreads: THREADS, debug: 0 });
	const stream = extractor.createStream();
	stream.acceptWaveform({ sampleRate: 16000, samples });
	stream.inputFinished();
	if (!extractor.isReady(stream)) throw new Error("audio too short for a voice fingerprint");
	return normalize(extractor.compute(stream));
}

function diarize(file, numSpeakers, threshold) {
	const samples = readSamples(file);
	log("stage: separating speakers");
	const sd = new sherpa.OfflineSpeakerDiarization({
		segmentation: { pyannote: { model: SEG_MODEL }, numThreads: THREADS, debug: 0 },
		embedding: { model: EMB_MODEL, numThreads: THREADS, debug: 0 },
		clustering: { numClusters: numSpeakers > 0 ? numSpeakers : -1, threshold },
		minDurationOn: 0.3,
		minDurationOff: 0.5,
	});
	const segments = sd.process(samples).map((s) => ({
		start: Math.round(s.start * 100) / 100,
		end: Math.round(s.end * 100) / 100,
		speaker: s.speaker,
	}));

	// One fingerprint per speaker from up to 30 s of their clearest (longest) turns.
	log("stage: fingerprinting voices");
	const bySpeaker = new Map();
	for (const s of segments) {
		if (!bySpeaker.has(s.speaker)) bySpeaker.set(s.speaker, []);
		bySpeaker.get(s.speaker).push(s);
	}
	const speakers = {};
	for (const [id, segs] of bySpeaker) {
		const total = segs.reduce((t, s) => t + (s.end - s.start), 0);
		const chosen = [...segs].filter((s) => s.end - s.start >= 0.8).sort((a, b) => b.end - b.start - (a.end - a.start));
		const parts = [];
		let len = 0;
		for (const s of chosen.length ? chosen : segs) {
			const a = Math.floor(s.start * 16000);
			const b = Math.min(samples.length, Math.floor(s.end * 16000));
			parts.push(samples.subarray(a, b));
			len += b - a;
			if (len >= 30 * 16000) break;
		}
		const joined = new Float32Array(len);
		let off = 0;
		for (const p of parts) {
			joined.set(p, off);
			off += p.length;
		}
		let embedding = null;
		try {
			embedding = embedSamples(joined);
		} catch {
			/* too little audio for this speaker */
		}
		speakers[id] = { embedding, seconds: Math.round(total * 10) / 10 };
	}
	return { segments, speakers };
}

function main() {
	// Run either as a file (node speakers.cjs diarize …) or inline (node -e "<source>" diarize …).
	const args = process.argv.slice(process.argv[1] && /\.c?js$/.test(process.argv[1]) ? 2 : 1);
	const [cmd, file, a, b] = args;
	if (cmd === "diarize") {
		const out = diarize(file, parseInt(a || "0", 10) || 0, parseFloat(b || "0.5") || 0.5);
		process.stdout.write(JSON.stringify(out));
	} else if (cmd === "embed") {
		const samples = readSamples(file);
		process.stdout.write(JSON.stringify({ embedding: embedSamples(samples), seconds: Math.round((samples.length / 16000) * 10) / 10 }));
	} else if (cmd === "check") {
		process.stdout.write(JSON.stringify({ ok: true, node: process.version }));
	} else {
		log("usage: speakers.cjs diarize|embed|check <wav>");
		process.exit(2);
	}
}

try {
	main();
} catch (e) {
	log("error: " + (e && e.message ? e.message : String(e)));
	process.exit(1);
}
