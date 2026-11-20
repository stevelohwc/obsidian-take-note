// Just enough zip reading to pull the chat text out of a WhatsApp export (iPhone shares a .zip).
// Uses only web APIs (DataView, DecompressionStream), so it works in Obsidian on phones too.

export interface ZipEntry {
	name: string;
	read: () => Promise<string>; // the entry's contents as UTF-8 text
}

const utf8 = new TextDecoder("utf-8");

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a zip archive (no zip64, no encryption: WhatsApp exports need neither). */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (i: number) => v.getUint32(i, true);
	const u16 = (i: number) => v.getUint16(i, true);
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
		if (u32(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end === -1) throw new Error("This isn't a zip file.");
	const count = u16(end + 10);
	let p = u32(end + 16);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count && p + 46 <= bytes.length && u32(p) === 0x02014b50; i++) {
		const method = u16(p + 10);
		const size = u32(p + 20);
		const nameLen = u16(p + 28);
		const local = u32(p + 42);
		const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + u16(p + 30) + u16(p + 32);
		entries.push({
			name,
			read: async () => {
				const start = local + 30 + u16(local + 26) + u16(local + 28);
				const data = bytes.subarray(start, start + size);
				if (method === 0) return utf8.decode(data);
				if (method === 8) return utf8.decode(await inflateRaw(data));
				throw new Error(`Unsupported zip compression in ${name}.`);
			},
		});
	}
	return entries;
}

/** The chat text inside a WhatsApp export zip ("_chat.txt", else the only .txt file). */
export async function chatTextFromZip(bytes: Uint8Array): Promise<string> {
	const txt = zipEntries(bytes).filter((e) => /\.txt$/i.test(e.name) && !e.name.startsWith("__MACOSX/"));
	const entry = txt.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) ?? (txt.length === 1 ? txt[0] : undefined);
	if (!entry) throw new Error(txt.length ? "This zip has several text files; unzip it and pick the chat's .txt." : "No chat text (.txt) in this zip.");
	return entry.read();
}
