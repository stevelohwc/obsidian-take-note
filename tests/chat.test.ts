import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { chatNameFromFile, chatStats, dateOrder, filterByDate, formatChat, parseChat } from "../src/chat.ts";
import { chatTextFromZip } from "../src/unzip.ts";
import { systemPrompt } from "../src/extract.ts";

const LRM = "\u200e";
const NNBSP = "\u202f";

test("WhatsApp iPhone export: brackets, AM/PM, attachments, wrapped lines, system lines", () => {
	const text = [
		`[03/11/2026, 9:05:12${NNBSP}AM] Project X: ${LRM}Messages and calls are end-to-end encrypted. Only people in this chat can read them.`,
		`[03/11/2026, 9:06:00${NNBSP}AM] Alice Tan: Morning! Can you send the deck`,
		"by Friday?",
		`[03/11/2026, 12:30:45${NNBSP}PM] Sam: ${LRM}<attached: 00000012-PHOTO-2026-11-03-12-30-45.jpg>`,
		`[13/11/2026, 12:01:02${NNBSP}AM] Alice Tan: ${LRM}audio omitted`,
		`[13/11/2026, 8:00:00${NNBSP}PM] Sam: Sure <This message was edited>`,
		`[13/11/2026, 8:01:00${NNBSP}PM] Alice Tan: This message was deleted`,
	].join("\n");
	const chat = parseChat(text);
	assert.equal(chat.source, "WhatsApp");
	assert.deepEqual(
		chat.messages.map((m) => [m.date, m.time, m.sender, m.text]),
		[
			["2026-11-03", "09:06", "Alice Tan", "Morning! Can you send the deck\nby Friday?"],
			["2026-11-03", "12:30", "Sam", "[photo]"],
			["2026-11-13", "00:01", "Alice Tan", "[voice message]"],
			["2026-11-13", "20:00", "Sam", "Sure"],
		],
	);
});

test("WhatsApp Android export: dash separator, 24h, media omitted, group events skipped", () => {
	const text = [
		"20/11/2026, 10:15 - Alice created group \"Launch\"",
		"20/11/2026, 10:16 - Alice: Kickoff at 3",
		"20/11/2026, 10:17 - Bob: <Media omitted>",
		"20/11/2026, 10:18 - Bob: report.pdf (file attached)",
		"Q4 numbers",
	].join("\n");
	const chat = parseChat(text);
	assert.equal(chat.source, "WhatsApp");
	assert.deepEqual(
		chat.messages.map((m) => `${m.date} ${m.time} ${m.sender}: ${m.text}`),
		["2026-11-20 10:16 Alice: Kickoff at 3", "2026-11-20 10:17 Bob: [media]", "2026-11-20 10:18 Bob: [file: report.pdf]\nQ4 numbers"],
	);
});

test("US-style dates are recognised from the whole chat", () => {
	const chat = parseChat("11/3/26, 9:05 PM - Alice: hi\n11/20/26, 9:06 PM - Bob: hey");
	assert.deepEqual(
		chat.messages.map((m) => [m.date, m.time]),
		[
			["2026-11-03", "21:05"],
			["2026-11-20", "21:06"],
		],
	);
	assert.equal(dateOrder([[3, 4, 2026]]), "dmy"); // ambiguous: day first
	assert.equal(dateOrder([[2026, 11, 20]]), "ymd");
});

test("Telegram copied messages", () => {
	const text = "Alice, [20.11.2026 10:15]\nCan we ship Monday?\nOr Tuesday\n\nSam Lee, [20.11.2026 10:16]\nMonday works";
	const chat = parseChat(text);
	assert.equal(chat.source, "Telegram");
	assert.deepEqual(
		chat.messages.map((m) => [m.date, m.time, m.sender, m.text]),
		[
			["2026-11-20", "10:15", "Alice", "Can we ship Monday?\nOr Tuesday"],
			["2026-11-20", "10:16", "Sam Lee", "Monday works"],
		],
	);
	const named = parseChat("Bob, [20 Nov 2026 at 9:05 PM]:\nok");
	assert.deepEqual([named.messages[0].date, named.messages[0].time], ["2026-11-20", "21:05"]);
});

test("Telegram Desktop result.json: entities, media, forwards, service messages", () => {
	const json = {
		name: "Launch team",
		type: "private_group",
		messages: [
			{ id: 1, type: "service", date: "2026-11-20T09:00:00", actor: "Alice", action: "create_group" },
			{ id: 2, type: "message", date: "2026-11-20T09:01:02", from: "Alice", text: ["See ", { type: "text_link", text: "the doc", href: "https://x.test/d" }, " please"] },
			{ id: 3, type: "message", date: "2026-11-20T09:02:00", from: "Bob", photo: "photos/1.jpg", text: "screenshot of the bug" },
			{ id: 4, type: "message", date: "2026-11-21T18:30:00", from: "Bob", media_type: "voice_message", file: "voice/1.ogg", text: "" },
			{ id: 5, type: "message", date: "2026-11-21T18:31:00", from: "Alice", forwarded_from: "Carol", text: "FYI" },
			{ id: 6, type: "message", date: "2026-11-21T18:32:00", from: "Alice", media_type: "sticker", sticker_emoji: "👍", text: "" },
		],
	};
	const chat = parseChat(JSON.stringify(json));
	assert.equal(chat.source, "Telegram");
	assert.equal(chat.name, "Launch team");
	assert.deepEqual(
		chat.messages.map((m) => `${m.date} ${m.time} ${m.sender}: ${m.text}`),
		[
			"2026-11-20 09:01 Alice: See the doc (https://x.test/d) please",
			"2026-11-20 09:02 Bob: [photo] screenshot of the bug",
			"2026-11-21 18:30 Bob: [voice message]",
			"2026-11-21 18:31 Alice: [forwarded from Carol] FYI",
			"2026-11-21 18:32 Alice: [sticker 👍]",
		],
	);
	const full = { chats: { list: [json, json] } };
	assert.throws(() => parseChat(JSON.stringify(full)), /2 chats/);
	assert.equal(parseChat(JSON.stringify({ chats: { list: [json] } })).messages.length, 5);
});

test("Telegram Desktop messages.html: joined messages, entities, media, forwards", () => {
	const msg = (id: number, cls: string, inner: string) => `<div class="message ${cls}" id="message${id}">${inner}</div>`;
	const date = (t: string) => `<div class="pull_right date details" title="${t} UTC+08:00">x</div>`;
	const html = [
		'<div class="page_header"><div class="content"><div class="text bold">Alice Tan</div></div></div>',
		msg(-1, "service", '<div class="body details">20 November 2026</div>'),
		msg(1, "default clearfix", `<div class="body">${date("20.11.2026 10:15:32")}<div class="from_name">Alice Tan </div><div class="text">Q&amp;A at <strong>3pm</strong><br>room 2</div></div>`),
		msg(2, "default clearfix joined", `<div class="body">${date("20.11.2026 10:16:00")}<div class="media_wrap clearfix"><a class="photo_wrap clearfix pull_left" href="photos/1.jpg"></a></div><div class="text">the photo</div></div>`),
		msg(3, "default clearfix", `<div class="body">${date("21.11.2026 08:00:00")}<div class="from_name">Sam</div><div class="forwarded body"><div class="from_name">Carol<span class="details"> 19.11.2026</span></div><div class="text">old news</div></div></div>`),
	].join("\n");
	const chat = parseChat(html);
	assert.equal(chat.source, "Telegram");
	assert.equal(chat.name, "Alice Tan");
	assert.deepEqual(
		chat.messages.map((m) => `${m.date} ${m.time} ${m.sender}: ${m.text}`),
		["2026-11-20 10:15 Alice Tan: Q&A at 3pm\nroom 2", "2026-11-20 10:16 Alice Tan: [photo] the photo", "2026-11-21 08:00 Sam: [forwarded from Carol] old news"],
	);
});

test("generic '[time] Name: text' lines, and plain text that isn't a chat", () => {
	const chat = parseChat("[10:15] Alice: hi\n[10:16] Bob: hello\nsecond line");
	assert.equal(chat.source, "Chat");
	assert.deepEqual(
		chat.messages.map((m) => [m.time, m.sender, m.text]),
		[
			["10:15", "Alice", "hi"],
			["10:16", "Bob", "hello\nsecond line"],
		],
	);
	assert.equal(parseChat("Just some notes about the launch.\nNothing chat-like here.").messages.length, 0);
});

test("formatChat: day headers, one line per message, renamed sender", () => {
	const chat = parseChat("20/11/2026, 10:15 - Alice: line one\nline two\n21/11/2026, 09:00 - Me Myself: ok");
	assert.equal(
		formatChat(chat.messages, { "Me Myself": "Sam" }),
		"--- 2026-11-20 (Friday) ---\n[10:15] Alice: line one / line two\n--- 2026-11-21 (Saturday) ---\n[09:00] Sam: ok",
	);
	assert.deepEqual(chatStats(chat.messages), { senders: ["Alice", "Me Myself"], first: "2026-11-20", last: "2026-11-21" });
	assert.deepEqual(
		filterByDate(chat.messages, "2026-11-21").map((m) => m.sender),
		["Me Myself"],
	);
	assert.deepEqual(
		filterByDate(chat.messages, "", "2026-11-20").map((m) => m.sender),
		["Alice"],
	);
});

test("chatNameFromFile reads WhatsApp export names", () => {
	assert.equal(chatNameFromFile("WhatsApp Chat with Alice Tan.txt"), "Alice Tan");
	assert.equal(chatNameFromFile("/Users/x/Downloads/WhatsApp Chat - Launch team.zip"), "Launch team");
	assert.equal(chatNameFromFile("_chat.txt"), null);
});

/** A minimal zip writer, enough to test the reader. */
function zip(files: { name: string; text: string; deflate: boolean }[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const raw = Buffer.from(f.text, "utf8");
		const data = f.deflate ? deflateRawSync(raw) : raw;
		const name = Buffer.from(f.name, "utf8");
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(f.deflate ? 8 : 0, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(f.deflate ? 8 : 0, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, data);
		centrals.push(central, name);
		offset += 30 + name.length + data.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

test("chatTextFromZip finds _chat.txt in a WhatsApp export", () => {
	const chatText = "[20/11/2026, 10:15:00] Alice: hi ".repeat(20);
	const bytes = zip([
		{ name: "00000012-PHOTO-2026-11-20.jpg", text: "binary", deflate: false },
		{ name: "_chat.txt", text: chatText, deflate: true },
	]);
	assert.equal(chatTextFromZip(bytes), chatText);
	assert.equal(chatTextFromZip(zip([{ name: "WhatsApp Chat with Bob.txt", text: "x", deflate: false }])), "x");
	assert.throws(() => chatTextFromZip(new Uint8Array([1, 2, 3])), /zip/);
});

test("system prompt switches to chat wording for chats", () => {
	const base = { notes: "", transcript: "", date: "2026-11-20", myName: "Sam", outputLanguage: "English", knownPeople: [], extraInstructions: "" };
	const chat = systemPrompt({ ...base, kind: "chat" });
	assert.match(chat, /chat conversation/);
	assert.match(chat, /"I"\/"me" inside a message means its sender/);
	assert.doesNotMatch(chat, /voice recognition/);
	assert.match(systemPrompt(base), /voice recognition/);
});

test("the sidebar reads an imported chat block: time of day, speaker, nothing to seek", async () => {
	const { parseTranscript } = await import("../src/sidebar-data.ts");
	const { renderTranscript, getBlock, TX_START, TX_END } = await import("../src/render.ts");
	const block = renderTranscript("--- 2026-11-20 (Friday) ---\n[00:15] Alice: late one", null, "WhatsApp · 1 message", undefined, "Chat");
	assert.match(block, /^## Chat$/m);
	const t = parseTranscript(getBlock(block, TX_START, TX_END)!);
	assert.equal(t.meta, "WhatsApp · 1 message");
	assert.deepEqual(
		t.lines.map((l) => [l.clock, l.seconds, l.speaker, l.text]),
		[
			[null, null, null, "--- 2026-11-20 (Friday) ---"],
			["00:15", null, "Alice", "late one"],
		],
	);
});

test("bubble layout: four sides, five each, migrated from the old single list", async () => {
	const { normalizeLayout, placeBubble, removeBubble, sideWithRoom, flipSides, DEFAULT_LAYOUT } = await import("../src/bubbles.ts");
	assert.deepEqual(normalizeLayout(undefined), DEFAULT_LAYOUT);
	assert.deepEqual(normalizeLayout(undefined, ["note", "record", "transcript", "import", "sidebar", "newNote", "bogus"]), {
		left: ["note", "record", "transcript", "import", "sidebar"],
		top: ["newNote"],
		right: [],
		bottom: [],
	});
	// Unknown ids, duplicates and a sixth bubble on one side are dropped.
	const l = normalizeLayout({ left: ["note", "note", "x", "record", "transcript", "import", "sidebar", "newNote"], bottom: ["record", "pause"] });
	assert.deepEqual(l.left, ["note", "record", "transcript", "import", "sidebar"]);
	assert.deepEqual(l.bottom, ["pause"]);

	// Move within a side, across sides, and refuse a full side.
	assert.deepEqual(placeBubble(l, "note", "left", 3)!.left, ["record", "transcript", "note", "import", "sidebar"]);
	const moved = placeBubble(l, "transcript", "right", 0)!;
	assert.deepEqual([moved.left, moved.right], [["note", "record", "import", "sidebar"], ["transcript"]]);
	assert.equal(placeBubble(l, "cancel", "left", 0), null);
	assert.deepEqual(placeBubble(l, "cancel", "top", 9)!.top, ["cancel"]);
	assert.deepEqual(removeBubble(l, "pause").bottom, []);
	assert.equal(sideWithRoom(l), "top");

	// Near the right edge, a right-hand row that doesn't fit swaps with the left one.
	const need = (n: number) => n * 48;
	const counts = { left: 1, top: 0, right: 3, bottom: 0 };
	assert.deepEqual(flipSides(counts, { left: 900, right: 30, top: 500, bottom: 40 }, need), { x: true, y: false });
	assert.deepEqual(flipSides(counts, { left: 900, right: 400, top: 500, bottom: 40 }, need), { x: false, y: false });
});
