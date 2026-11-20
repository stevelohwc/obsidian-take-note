// "Import a chat": paste messages or pick a WhatsApp / Telegram export, check what was found, import.
import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent } from "obsidian";
import { type ChatSource, type ParsedChat, chatNameFromFile, chatStats, filterByDate, formatChat, parseChat } from "./chat.ts";
import { estimateTokens } from "./extract.ts";
import { safeFileName } from "./render.ts";
import { chatTextFromZip } from "./unzip.ts";

export interface ChatImport {
	title: string;
	source: ChatSource;
	transcript: string; // formatted lines, or the pasted text as is when no chat format was recognised
	meta: string; // "WhatsApp · 120 messages · 3 people"
	start: string | null; // first and last message day, YYYY-MM-DD
	end: string | null;
	people: string[]; // everyone who wrote, except you
}

interface Options {
	myName: string;
	maxInputTokens: number;
	summarize: boolean; // the AI runs right after the import
}

const NONE = "";

export class ImportChatModal extends Modal {
	private chat: ParsedChat | null = null;
	private rawText = "";
	private fileLabel = "";
	private me = NONE;
	private from = "";
	private to = "";
	private titleTouched = false;
	private timer = 0;

	private pasteBox!: TextAreaComponent;
	private infoEl!: HTMLElement;
	private meDropdown!: DropdownComponent;
	private titleInput!: TextComponent;
	private importButton!: ButtonComponent;

	constructor(
		app: App,
		private opts: Options,
		private onImport: (c: ChatImport) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Import a chat");
		contentEl.addClass("take-note-chat-import");
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Paste messages copied from WhatsApp or Telegram, or choose an export: WhatsApp's Export chat (.txt or .zip), " +
				"or Telegram Desktop's Export chat history (result.json, or messages.html — pick all its pages).",
		});

		const picker = contentEl.createEl("input", { type: "file", attr: { accept: ".txt,.zip,.json,.html,.htm", multiple: "" } });
		picker.hide();
		picker.onchange = () => void this.readFiles(Array.from(picker.files ?? []));
		new Setting(contentEl)
			.setName("Export file")
			.setDesc("Or paste below.")
			.addButton((b) => b.setButtonText("Choose file…").onClick(() => picker.click()));

		this.pasteBox = new TextAreaComponent(contentEl);
		this.pasteBox.setPlaceholder("[20/11/2026, 10:15:32] Alice: Can you send the deck by Friday?");
		this.pasteBox.inputEl.addClass("take-note-chat-paste");
		this.pasteBox.onChange(() => {
			this.fileLabel = "";
			window.clearTimeout(this.timer);
			this.timer = window.setTimeout(() => this.useText(this.pasteBox.getValue(), null), 300);
		});

		this.infoEl = contentEl.createDiv({ cls: "take-note-chat-info setting-item-description" });

		new Setting(contentEl)
			.setName("Which one is you?")
			.setDesc("Your messages are labelled with your name from settings, so the AI knows which commitments are yours.")
			.addDropdown((d) => {
				this.meDropdown = d;
				d.onChange((v) => {
					this.me = v;
					this.refresh();
				});
			});

		new Setting(contentEl)
			.setName("Only messages between")
			.setDesc("Optional. Long histories are read in several parts, which takes longer and costs more.")
			.addText((t) => {
				t.inputEl.type = "date";
				t.onChange((v) => {
					this.from = v;
					this.refresh();
				});
			})
			.addText((t) => {
				t.inputEl.type = "date";
				t.onChange((v) => {
					this.to = v;
					this.refresh();
				});
			});

		new Setting(contentEl).setName("Note title").addText((t) => {
			this.titleInput = t;
			t.onChange(() => (this.titleTouched = true));
		});

		new Setting(contentEl).addButton((b) => {
			this.importButton = b;
			b.setButtonText(this.opts.summarize ? "Import & summarize" : "Import")
				.setCta()
				.onClick(() => void this.submit());
		});
		this.refresh();
	}

	onClose() {
		window.clearTimeout(this.timer);
		this.contentEl.empty();
	}

	private async readFiles(files: File[]) {
		if (!files.length) return;
		try {
			files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
			const texts = await Promise.all(
				files.map(async (f) => (/\.zip$/i.test(f.name) ? chatTextFromZip(new Uint8Array(await f.arrayBuffer())) : f.text())),
			);
			// Telegram splits big HTML exports into messages.html, messages2.html…: read them as one chat.
			const parts = texts.map((t) => parseChat(t));
			const merged: ParsedChat = { ...parts[0], messages: parts.flatMap((p) => p.messages) };
			if (!merged.name) merged.name = chatNameFromFile(files[0].name);
			this.fileLabel = files.length === 1 ? files[0].name : `${files.length} files`;
			this.pasteBox.setValue("");
			this.useText(texts.join("\n\n"), merged);
		} catch (e) {
			this.chat = null;
			this.rawText = "";
			this.refresh((e as Error).message);
		}
	}

	private useText(text: string, parsed: ParsedChat | null) {
		this.rawText = text;
		try {
			this.chat = parsed ?? (text.trim() ? parseChat(text) : null);
		} catch (e) {
			this.chat = null;
			this.refresh((e as Error).message);
			return;
		}
		this.titleTouched = false;
		this.fillSenders();
		this.refresh();
	}

	private fillSenders() {
		const senders = this.chat ? chatStats(this.chat.messages).senders : [];
		const mine = this.opts.myName.toLowerCase();
		this.me =
			senders.find((s) => s.toLowerCase() === mine) ??
			senders.find((s) => /^you$/i.test(s)) ??
			(mine ? senders.find((s) => s.toLowerCase().split(" ").includes(mine.split(" ")[0])) : undefined) ??
			NONE;
		const sel = this.meDropdown.selectEl;
		sel.empty();
		this.meDropdown.addOption(NONE, senders.length ? "Not in this chat" : "—");
		for (const s of senders) this.meDropdown.addOption(s, s);
		this.meDropdown.setValue(this.me);
	}

	/** What would be imported right now, or null when there is nothing. */
	private build(): ChatImport | null {
		const chat = this.chat;
		if (!chat || !chat.messages.length) {
			const text = this.rawText.trim();
			if (!text) return null;
			return { title: "Chat", source: "Chat", transcript: text, meta: "pasted text", start: null, end: null, people: [] };
		}
		const messages = filterByDate(chat.messages, this.from, this.to);
		const { senders, first, last } = chatStats(messages);
		const myName = this.opts.myName.trim();
		const rename = this.me && myName && this.me !== myName ? { [this.me]: myName } : {};
		const others = senders.filter((s) => s !== this.me);
		const name = chat.name ?? (others.slice(0, 3).join(", ") + (others.length > 3 ? " and others" : ""));
		const span = first && last ? (first === last ? first : `${first} → ${last}`) : "";
		return {
			title: name ? `Chat with ${name}` : "Chat",
			source: chat.source,
			transcript: formatChat(messages, rename),
			meta: [chat.source, `${messages.length} message${messages.length === 1 ? "" : "s"}`, `${senders.length} ${senders.length === 1 ? "person" : "people"}`, span]
				.filter(Boolean)
				.join(" · "),
			start: first,
			end: last,
			people: others,
		};
	}

	private refresh(error?: string) {
		const c = error ? null : this.build();
		this.infoEl.empty();
		this.infoEl.toggleClass("mod-warning", !!error);
		if (error) this.infoEl.setText(error);
		else if (!c) this.infoEl.setText("Nothing to import yet.");
		else {
			const lines: string[] = [];
			if (this.fileLabel) lines.push(this.fileLabel);
			if (!this.chat?.messages.length) lines.push("Not a chat format I recognise: it will be imported as is, and the AI will still read it.");
			else {
				lines.push(`Found: ${c.meta}.`);
				if (c.people.length) lines.push(`People: ${c.people.slice(0, 8).join(", ")}${c.people.length > 8 ? ` and ${c.people.length - 8} more` : ""}.`);
				if (!c.transcript) lines.push("No messages in those dates.");
			}
			const tokens = estimateTokens(c.transcript);
			const parts = Math.ceil(tokens / Math.max(2000, this.opts.maxInputTokens - 3000));
			if (parts > 1) lines.push(`About ${Math.round(tokens / 1000)}k tokens: the AI will read it in ${parts} parts. Narrow the dates to make it faster.`);
			lines.forEach((l) => this.infoEl.createDiv({ text: l }));
		}
		if (!this.titleTouched) this.titleInput.setValue(c?.title ?? "");
		this.importButton.setDisabled(!c?.transcript);
	}

	private async submit() {
		const c = this.build();
		if (!c?.transcript) return;
		c.title = safeFileName(this.titleInput.getValue().trim()) || c.title;
		this.close();
		try {
			await this.onImport(c);
		} catch (e) {
			new Notice("❌ Chat import failed: " + (e as Error).message, 10000);
		}
	}
}
