import { test } from "node:test";
import assert from "node:assert/strict";
import {
	labelTranscript,
	matchVoices,
	mergeSimilarSpeakers,
	renameSpeaker,
	speakerAt,
	transcriptSpeakers,
	type DiarSegment,
} from "../src/speakers.ts";
import { renderMeeting, renderTranscript, speakerSessionId, upsertPersonLine, collectSources, upsertBlock, TX_START, TX_END } from "../src/render.ts";
import { normalize } from "../src/extract.ts";

const A = [1, 0, 0];
const A2 = [0.95, 0.1, 0];
const B = [0, 1, 0];
const C = [0, 0, 1];

test("mergeSimilarSpeakers joins a person split into two clusters", () => {
	const segs: DiarSegment[] = [
		{ start: 0, end: 5, speaker: 0 },
		{ start: 5, end: 9, speaker: 1 },
		{ start: 9, end: 12, speaker: 7 },
	];
	const out = mergeSimilarSpeakers(segs, { "0": { embedding: A, seconds: 5 }, "1": { embedding: B, seconds: 4 }, "7": { embedding: A2, seconds: 3 } }, 0.75);
	assert.deepEqual(out.segments.map((s) => s.speaker), [0, 1, 0]);
	assert.deepEqual(Object.keys(out.speakers).sort(), ["0", "1"]);
	assert.equal(out.speakers["0"].seconds, 8);
});

test("matchVoices names only voices above the threshold", () => {
	const m = matchVoices(
		{ "0": { embedding: A, seconds: 5 }, "1": { embedding: B, seconds: 5 }, "2": { embedding: C, seconds: 5 } },
		{ Dana: [A2], Alice: [[0.1, 0.99, 0]] },
		0.6,
	);
	assert.equal(m.get(0)?.name, "Dana");
	assert.equal(m.get(1)?.name, "Alice");
	assert.equal(m.has(2), false);
});

test("labelTranscript merges a speaker's consecutive segments and labels unknowns in order", () => {
	const segs: DiarSegment[] = [
		{ start: 0, end: 4, speaker: 3 },
		{ start: 4, end: 8, speaker: 5 },
		{ start: 8, end: 12, speaker: 9 },
	];
	const whisper = [
		{ from: 0, to: 2000, text: " Morning all." },
		{ from: 2000, to: 3900, text: " Let's start." },
		{ from: 4100, to: 7900, text: " Template by Friday." },
		{ from: 8100, to: 11000, text: " I'll chase the bank." },
	];
	const { lines, labels } = labelTranscript(whisper, segs, new Map([[5, { name: "Alice" }]]), true);
	assert.deepEqual(lines, [
		"[00:00:00] Speaker 1: Morning all. Let's start.",
		"[00:00:04] Alice: Template by Friday.",
		"[00:00:08] Speaker 2: I'll chase the bank.",
	]);
	assert.equal(labels.get(9), "Speaker 2");
	assert.equal(speakerAt(20, 21, segs), 9); // after the end -> nearest
});

test("transcriptSpeakers and renameSpeaker work on the callout transcript", () => {
	const block = renderTranscript("[00:00:00] Speaker 1: Morning all.\n[00:00:04] Alice: Template: by Friday.\n[00:00:09] Speaker 1: Thanks Alice.", null, "1:00", "abc123");
	assert.equal(speakerSessionId(upsertBlock("# T\n", TX_START, TX_END, block, "end")), "abc123");
	const sp = transcriptSpeakers(block);
	assert.deepEqual(sp.map((s) => s.label), ["Speaker 1", "Alice"]);
	assert.deepEqual(sp[0].samples, ["Morning all.", "Thanks Alice."]);
	const renamed = renameSpeaker(block, "Speaker 1", "Dana");
	assert.match(renamed, /> \[00:00:00\] Dana: Morning all\./);
	assert.match(renamed, /> \[00:00:09\] Dana: Thanks Alice\./);
	assert.match(renamed, /Alice: Template: by Friday/); // other speakers untouched
	// The AI still reads the transcript with speaker labels, and not the session marker.
	const { transcript } = collectSources(upsertBlock("# T\n", TX_START, TX_END, renamed, "end"));
	assert.ok(transcript.startsWith("[00:00:00] Dana: Morning all."));
	assert.ok(!transcript.includes("take-note:speakers"));
});

test("upsertPersonLine appends under ## Notes and replaces on re-run", () => {
	const note = "---\ntags: [person]\n---\n\n# Dana\n\nDev lead.\n\n## Notes\n\n- [[2026-11-01]] — first chat.\n\n## Projects\n- x\n";
	const once = upsertPersonLine(note, "2026-11-19 – Weekly Sync", "verified the login flow");
	assert.match(once, /- \[\[2026-11-01\]\] — first chat\.\n- \[\[2026-11-19 – Weekly Sync\]\] — verified the login flow\n\n## Projects/);
	const twice = upsertPersonLine(once, "2026-11-19 – Weekly Sync", "verified the login flow, reviews ES options");
	assert.equal(twice.split("Weekly Sync").length, 2);
	assert.match(twice, /reviews ES options/);
	const noSection = upsertPersonLine("# Alice\n", "M", "s");
	assert.match(noSection, /## Notes\n\n- \[\[M\]\] — s\n$/);
});

test("renderMeeting shows a By person section", () => {
	const md = renderMeeting(
		normalize({
			by_person: [
				{ name: "Dana", summary: "Ran the sync", updates: ["Login flow verified"], commitments: ["Review ES options"], asks: [] },
				{ name: "Speaker 3", summary: "Asked about logs", asks: ["Better log search?"] },
			],
		}),
		{ linkPeople: true, tasksEmoji: true, generatedAt: "x", model: "m" },
	);
	assert.match(md, /## 👥 By person\n### \[\[Dana\]\]\nRan the sync\n- \*\*Updates\*\*\n    - Login flow verified\n- \*\*Will do\*\*\n    - Review ES options/);
	assert.match(md, /### Speaker 3\n/); // unknown voices are not linked
	const md2 = renderMeeting(normalize({ attendees: ["Dana", "Speaker 1"], action_items: [{ task: "Chase bank", owner: "Speaker 1" }] }), {
		linkPeople: true,
		tasksEmoji: true,
		generatedAt: "x",
		model: "m",
	});
	assert.match(md2, /\*\*Attendees:\*\* \[\[Dana\]\], Speaker 1/);
	assert.match(md2, /- \[ \] Chase bank — Speaker 1/);
});

test("absorbMinorSpeakers folds a 2-person call split into many tiny speakers", async () => {
	const { absorbMinorSpeakers } = await import("../src/speakers.ts");
	const unitv = (v: number[]) => {
		const n = Math.hypot(...v);
		return v.map((x) => x / n);
	};
	// Two real voices (orthogonal) plus noisy short fragments of each.
	const A = [1, 0, 0];
	const B = [0, 1, 0];
	const speakers: Record<string, { embedding: number[] | null; seconds: number }> = {
		0: { embedding: A, seconds: 222 },
		1: { embedding: B, seconds: 74 },
		2: { embedding: unitv([0.7, 0.2, 0.6]), seconds: 3.3 }, // like A
		3: { embedding: unitv([0.2, 0.75, 0.6]), seconds: 3 }, // like B
		4: { embedding: unitv([0.3, 0.05, 0.95]), seconds: 2.8 }, // weakly A
		5: { embedding: null, seconds: 0.6 }, // no fingerprint: left alone
	};
	const segments = [
		{ start: 0, end: 5, speaker: 0 },
		{ start: 5, end: 8, speaker: 2 },
		{ start: 8, end: 11, speaker: 3 },
		{ start: 11, end: 14, speaker: 4 },
		{ start: 14, end: 20, speaker: 1 },
		{ start: 20, end: 21, speaker: 5 },
	];
	const out = absorbMinorSpeakers(segments, speakers);
	assert.deepEqual(Object.keys(out.speakers).sort(), ["0", "1", "5"]);
	assert.deepEqual(
		out.segments.map((s) => s.speaker),
		[0, 0, 1, 0, 1, 5],
	);
	assert.equal(out.speakers[0].seconds, 228.1);
	assert.deepEqual(out.speakers[0].embedding, A, "keeps the main speaker's reliable fingerprint");
});

test("absorbMinorSpeakers keeps a real person who spoke little in a long meeting", async () => {
	const { absorbMinorSpeakers } = await import("../src/speakers.ts");
	const speakers = {
		0: { embedding: [1, 0, 0], seconds: 1500 },
		1: { embedding: [0, 1, 0], seconds: 1200 },
		2: { embedding: [0.1, 0.1, 0.99], seconds: 40 }, // 1.4% of talk time, sounds like nobody else
		3: { embedding: [0.05, 0.08, 0.99], seconds: 5 }, // very short, but distinct from the main voices
	};
	const out = absorbMinorSpeakers([], speakers);
	assert.ok(out.speakers[2], "40 s of a distinct voice stays its own speaker");
	assert.ok(out.speakers[3], "a short clip that sounds like nobody is not forced into someone");
});

test("isHallucination drops Whisper's invented phrases, not real speech", async () => {
	const { isHallucination } = await import("../src/render.ts");
	for (const t of [
		"请不吝点赞 订阅 转发 打赏支持明镜与点点栏目 请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
		"字幕由Amara.org社区提供",
		"谢谢观看!",
		"Thank you for watching.",
		"Thanks for watching!",
		"[MUSIC]",
		"(applause)",
		"ご視聴ありがとうございました",
	])
		assert.ok(isHallucination(t), t);
	for (const t of ["OK 好 OK OK 拜拜 拜拜", "谢谢", "Thank you, Alice, that helps.", "也是可以 对", "subscribe the webhook to the deposit topic", "music module is done"])
		assert.ok(!isHallucination(t), t);
});
