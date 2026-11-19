import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTarget, parseTranscript, setTaskInAiBlock } from "../src/sidebar-data.ts";
import { AI_END, AI_START, TX_END, TX_START, getBlock, renderTranscript } from "../src/render.ts";

test("parses a speaker-labelled transcript block", () => {
	const block = getBlock(
		renderTranscript(
			"[00:00:03] Alice: The release is ready.\n[00:01:12] Speaker 2: Any blockers?\n[01:02:03] Bob: Invoice rounding: still open.",
			"![[2026-11-19 1530 recording.webm]]",
			"12:04 · en · 3 speakers",
			"abc123",
		),
		TX_START,
		TX_END,
	)!;
	const t = parseTranscript(block);
	assert.equal(t.audioLink, "![[2026-11-19 1530 recording.webm]]");
	assert.equal(t.meta, "12:04 · en · 3 speakers");
	assert.equal(t.lines.length, 3);
	assert.deepEqual(t.lines[0], { seconds: 3, clock: "00:00:03", speaker: "Alice", text: "The release is ready." });
	assert.equal(t.lines[1].speaker, "Speaker 2");
	assert.equal(t.lines[2].seconds, 3723);
	assert.equal(t.lines[2].speaker, "Bob");
	assert.equal(t.lines[2].text, "Invoice rounding: still open.");
});

test("parses a plain transcript without speakers or timestamps", () => {
	const t = parseTranscript(getBlock(renderTranscript("hello there\nso the plan is simple", null, "pending"), TX_START, TX_END)!);
	assert.equal(t.audioLink, null);
	assert.deepEqual(
		t.lines.map((l) => [l.seconds, l.speaker, l.text]),
		[
			[null, null, "hello there"],
			[null, null, "so the plan is simple"],
		],
	);
});

test("a long sentence before a colon is not a speaker", () => {
	const t = parseTranscript("> [!quote]- Transcript (x)\n> [00:00:01] What we agreed on last time with the whole team: ship it");
	assert.equal(t.lines[0].speaker, null);
});

test("embedTarget reads wiki and markdown embeds", () => {
	assert.equal(embedTarget("![[rec.webm]]"), "rec.webm");
	assert.equal(embedTarget("![[folder/rec.m4a|audio]]"), "folder/rec.m4a");
	assert.equal(embedTarget("![](Attachments/my%20rec.webm)"), "Attachments/my rec.webm");
	assert.equal(embedTarget("Source: `/tmp/x.mp4`"), null);
});

test("ticks the n-th task inside the AI block only", () => {
	const note = [
		"# Meeting",
		"- [ ] my own task outside",
		AI_START,
		"## 📌 Action items",
		"- [ ] Send the template — [[Alice]]",
		"- [x] Check the logs — [[Bob]]",
		AI_END,
		"- [ ] another outside",
	].join("\n");
	const a = setTaskInAiBlock(note, 0, true);
	assert.match(a, /- \[x\] Send the template/);
	assert.match(a, /- \[ \] my own task outside/);
	const b = setTaskInAiBlock(a, 1, false);
	assert.match(b, /- \[ \] Check the logs/);
	assert.equal(setTaskInAiBlock(note, 5, true), note);
	assert.equal(setTaskInAiBlock("no block", 0, true), "no block");
});
