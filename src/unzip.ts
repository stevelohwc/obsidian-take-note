// Just enough zip reading to pull the chat text out of a WhatsApp export (iPhone shares a .zip).
import { inflateRawSync } from "zlib";

export interface ZipEntry {
	name: string;
	read: () => string; // the entry's contents as UTF-8 text
}

/** The files in a zip archive (no zip64, no encryption: WhatsApp exports need neither). */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
		if (b.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end === -1) throw new Error("This isn't a zip file.");
	const count = b.readUInt16LE(end + 10);
	let p = b.readUInt32LE(end + 16);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count && p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50; i++) {
		const method = b.readUInt16LE(p + 10);
		const size = b.readUInt32LE(p + 20);
		const nameLen = b.readUInt16LE(p + 28);
		const local = b.readUInt32LE(p + 42);
		const name = b.toString("utf8", p + 46, p + 46 + nameLen);
		p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
		entries.push({
			name,
			read: () => {
				const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
				const data = b.subarray(start, start + size);
				if (method === 0) return data.toString("utf8");
				if (method === 8) return inflateRawSync(data).toString("utf8");
				throw new Error(`Unsupported zip compression in ${name}.`);
			},
		});
	}
	return entries;
}

/** The chat text inside a WhatsApp export zip ("_chat.txt", else the only .txt file). */
export function chatTextFromZip(bytes: Uint8Array): string {
	const txt = zipEntries(bytes).filter((e) => /\.txt$/i.test(e.name) && !e.name.startsWith("__MACOSX/"));
	const entry = txt.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) ?? (txt.length === 1 ? txt[0] : undefined);
	if (!entry) throw new Error(txt.length ? "This zip has several text files; unzip it and pick the chat's .txt." : "No chat text (.txt) in this zip.");
	return entry.read();
}
