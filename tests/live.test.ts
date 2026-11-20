import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE, chunkWindow, contextTail, findCut, rms, splitSentences, wavFile } from "../src/live-audio.ts";

/** `sec` seconds of a tone at `level`, or silence when level is 0. */
function tone(sec: number, level: number): Int16Array {
	const out = new Int16Array(Math.round(sec * RATE));
	for (let i = 0; i < out.length; i++) out[i] = Math.round(level * Math.sin(i / 8));
	return out;
}

function join(...parts: Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

test("rms is 0 for silence and grows with level", () => {
	assert.equal(rms(tone(1, 0)), 0);
	assert.ok(rms(tone(1, 1000)) > 600);
	assert.equal(rms(new Int16Array(0)), 0);
});

test("findCut picks the pause, not the middle of speech", () => {
	// speech 0-9.5 s, pause 9.5-10 s, speech 10-13 s
	const audio = join(tone(9.5, 3000), tone(0.5, 0), tone(3, 3000));
	const cut = findCut(audio, 8, 12) / RATE;
	assert.ok(cut > 9.5 && cut < 10, `cut at ${cut}s`);
});

test("chunkWindow waits for 12 s and caps a backlog at 28 s", () => {
	assert.equal(chunkWindow(11.9), null);
	assert.deepEqual(chunkWindow(12), { minSec: 6, maxSec: 12 });
	assert.deepEqual(chunkWindow(60), { minSec: 22, maxSec: 28 });
});

test("wavFile writes a 16 kHz mono 16-bit header", () => {
	const wav = wavFile(tone(1, 500));
	const v = new DataView(wav.buffer);
	assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
	assert.equal(v.getUint32(24, true), 16000);
	assert.equal(v.getUint16(22, true), 1);
	assert.equal(v.getUint32(40, true), RATE * 2);
	assert.equal(wav.length, 44 + RATE * 2);
});

test("contextTail keeps the last words without cutting one in half", () => {
	assert.equal(contextTail(["Hello there.", "How are you?"]), "Hello there. How are you?");
	const tail = contextTail(["word ".repeat(100)], 30);
	assert.ok(tail.length <= 30 && tail.startsWith("word"));
});

test("splitSentences gives each sentence its own line and time", () => {
	const lines = splitSentences(" Can you send it by tomorrow? Sure. I will send it in the morning.", 10, 16);
	assert.deepEqual(lines.map((l) => l.text), ["Can you send it by tomorrow?", "Sure.", "I will send it in the morning."]);
	assert.equal(lines[0].seconds, 10);
	assert.ok(lines[1].seconds > 10 && lines[2].seconds > lines[1].seconds && lines[2].seconds < 16);
	assert.deepEqual(splitSentences("no punctuation here", 5, 6), [{ seconds: 5, text: "no punctuation here" }]);
	assert.deepEqual(splitSentences("你好。我们开始吧！", 0, 2).map((l) => l.text), ["你好。", "我们开始吧！"]);
});
