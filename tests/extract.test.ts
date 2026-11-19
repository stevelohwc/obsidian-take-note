import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, estimateTokens, extractMeeting, normalize, parseJsonReply, type ChatFn } from "../src/extract.ts";
import {
	AI_END,
	AI_START,
	TX_END,
	TX_START,
	cleanTranscript,
	collectSources,
	renderMeeting,
	renderTranscript,
	upsertBlock,
} from "../src/render.ts";

test("parseJsonReply handles think blocks, fences and trailing commas", () => {
	const reply = '<think>let me think {not json}</think>\n```json\n{"title": "Bot flow", "decisions": ["a",],}\n```';
	assert.deepEqual(parseJsonReply(reply), { title: "Bot flow", decisions: ["a"] });
});

test("normalize coerces sloppy model output", () => {
	const m = normalize({
		title: "Team sync",
		summary: "One line summary",
		action_items: ["Fix QR", { task: "Send template", owner: "Alice", due: "by 2026-11-21", priority: "P1" }],
		questions: [{ question: "Who owns Grafana?", ask: "unknown" }],
		tickets: [{ title: "CheckoutApp QR issue", type: "BUG", priority: "urgent", acceptance_criteria: "QR scans" }],
	});
	assert.deepEqual(m.summary, ["One line summary"]);
	assert.equal(m.action_items[0].task, "Fix QR");
	assert.deepEqual(m.action_items[1], { task: "Send template", owner: "Alice", due: "2026-11-21", priority: "high" });
	assert.equal(m.questions[0].ask, null);
	assert.equal(m.tickets[0].type, "bug");
	assert.equal(m.tickets[0].priority, "high");
	assert.deepEqual(m.tickets[0].acceptance_criteria, ["QR scans"]);
	assert.deepEqual(m.risks, []);
});

test("chunkText respects the token budget", () => {
	const text = Array.from({ length: 400 }, (_, i) => `[00:00:${i}] speaker says something fairly ordinary here`).join("\n");
	const chunks = chunkText(text, 1000);
	assert.ok(chunks.length > 1);
	for (const c of chunks) assert.ok(estimateTokens(c) <= 1000 + 20);
	assert.equal(chunks.join("\n"), text);
	assert.ok(estimateTokens("中文测试") === 4);
});

test("upsertBlock inserts after H1 then replaces in place", () => {
	const note = "---\ntags: [meeting]\n---\n# 2026-11-19 – Meeting 1530\n\n## My notes\n- hello\n";
	const once = upsertBlock(note, AI_START, AI_END, `${AI_START}\nA\n${AI_END}`, "afterTitle");
	assert.match(once, /# 2026-11-19 – Meeting 1530\n\n<!-- take-note:ai:start -->\nA\n<!-- take-note:ai:end -->\n\n## My notes/);
	const twice = upsertBlock(once, AI_START, AI_END, `${AI_START}\nB\n${AI_END}`, "afterTitle");
	assert.ok(twice.includes("\nB\n") && !twice.includes("\nA\n"));
	assert.equal(twice.split(AI_START).length, 2);
});

test("collectSources separates my notes from transcript and ignores generated output", () => {
	let note = "---\ntags: [meeting]\n---\n# T\n\n## My notes\n- chase client account\n";
	note = upsertBlock(note, AI_START, AI_END, `${AI_START}\nOLD SUMMARY\n${AI_END}`, "afterTitle");
	note = upsertBlock(note, TX_START, TX_END, renderTranscript("[00:00:01] hello team\n[00:00:05] next item", "![[a.webm]]", "1:00"), "end");
	const { notes, transcript } = collectSources(note);
	assert.equal(notes, "# T\n\n- chase client account");
	assert.equal(transcript, "[00:00:01] hello team\n[00:00:05] next item");
});

test("cleanTranscript drops whisper repetition loops", () => {
	const out = cleanTranscript(["[00:01] Thank you.", "[00:02] Thank you.", "[00:03] Thank you.", "[00:04] Thank you.", "", "[00:05] Next"]);
	assert.deepEqual(out, ["[00:01] Thank you.", "[00:02] Thank you.", "[00:05] Next"]);
});

test("renderMeeting produces Tasks-plugin action items and links people", () => {
	const md = renderMeeting(
		normalize({
			title: "Team sync",
			attendees: ["Alice", "Bob"],
			summary: ["Bot flow needs alignment"],
			action_items: [{ task: "Provide API design template", owner: "Alice", due: "2026-11-21", priority: "high" }],
			questions: [{ question: "Why was Bob late on CheckoutApp?", ask: "Alice" }],
			tickets: [{ title: "CheckoutApp QR issue", type: "bug", priority: "high", owner: "Bob", description: "QR fails", acceptance_criteria: ["QR scans on iOS"] }],
			ai_assignments: [{ task: "Draft test cases for the login flow", prompt: "Write test cases for:\n- item 1" }],
		}),
		{ linkPeople: true, tasksEmoji: true, generatedAt: "2026-11-19 16:00", model: "m" },
	);
	assert.match(md, /- \[ \] Provide API design template — \[\[Alice\]\] ⏫ 📅 2026-11-21/);
	assert.match(md, /### 1\. \[Bug\] CheckoutApp QR issue/);
	assert.match(md, /> \[!example\]- Prompt\n> Write test cases for:\n> - item 1/);
	assert.match(md, /\*\*Attendees:\*\* \[\[Alice\]\], \[\[Bob\]\]/);
	assert.ok(md.startsWith(AI_START) && md.endsWith(AI_END));
});

test("extractMeeting splits long transcripts and merges", async () => {
	const calls: string[] = [];
	const chat: ChatFn = async (messages, label) => {
		calls.push(label);
		const n = calls.length;
		return JSON.stringify({ title: "T", summary: [`s${n}`], action_items: [{ task: `a${n}` }] });
	};
	const transcript = Array.from({ length: 300 }, (_, i) => `line ${i} with some words in it to make it longer`).join("\n");
	const res = await extractMeeting(
		chat,
		{ notes: "", transcript, date: "2026-11-19", myName: "Sam", outputLanguage: "English", knownPeople: [], extraInstructions: "" },
		3000,
	);
	assert.ok(calls.length >= 3, "expected parts + merge, got " + calls.join(","));
	assert.equal(calls[calls.length - 1], "Merging parts");
	assert.equal(res.title, "T");
});

test("enforcePriorities keeps only priorities backed by an urgency word about that item", async () => {
	const { enforcePriorities, justifiedPriority } = await import("../src/extract.ts");
	const source = [
		"4. checkoutapp has issue qr issue -> bob has late response, will ask alice on this.",
		"5. invoice rounding bug is a blocker for launch, fix asap",
		"6. dark mode for admin panel is nice to have",
	].join("\n");
	const m = enforcePriorities(
		normalize({
			action_items: [
				{ task: "Investigate CheckoutApp QR issue", owner: "Alice", priority: "high" },
				{ task: "Fix invoice rounding bug", priority: "medium" },
				{ task: "Add dark mode to admin panel", priority: "high" },
				{ task: "Write docs", priority: null },
			],
			tickets: [{ title: "CheckoutApp QR code fails", priority: "high" }],
		}),
		source,
	);
	assert.deepEqual(
		m.action_items.map((a) => a.priority),
		[null, "high", "low", null],
	);
	assert.equal(m.tickets[0].priority, null);
	assert.equal(justifiedPriority("Deploy hotfix", "Alice: deploy the hotfix today please"), "high");
	assert.equal(justifiedPriority("Deploy hotfix", "today we talked about many things"), null);
});

test("tickets without a priority render without a Priority label", () => {
	const md = renderMeeting(normalize({ tickets: [{ title: "Job monitor history", owner: "Dana" }] }), {
		linkPeople: true,
		tasksEmoji: true,
		generatedAt: "x",
		model: "m",
	});
	assert.ok(!md.includes("**Priority:**"));
	assert.match(md, /\*\*Owner:\*\* \[\[Dana\]\]/);
});
