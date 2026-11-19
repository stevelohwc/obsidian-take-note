// The Take Note sidebar: summary and transcript of the meeting note you're looking at.
import { ItemView, Keymap, MarkdownRenderer, TFile, type WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type TakeNote from "./main.ts";
import { MASCOT_ICON } from "./mascot.ts";
import { AI_END, AI_START, TX_END, TX_START, getBlock } from "./render.ts";
import { type TranscriptLine, embedTarget, parseTranscript, setTaskInAiBlock } from "./sidebar-data.ts";

export const VIEW_TYPE = "take-note-sidebar";

type Tab = "summary" | "transcript";

export class TakeNoteView extends ItemView {
	private note: TFile | null = null;
	private tab: Tab = "summary";
	private filter = "";
	private statusEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private audio: HTMLAudioElement | null = null;
	private lineEls: { el: HTMLElement; seconds: number | null }[] = [];
	private renderSeq = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: TakeNote,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Take Note";
	}

	getIcon(): string {
		return MASCOT_ICON.idle;
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("take-note-side");
		this.statusEl = this.contentEl.createDiv({ cls: "take-note-side-status take-note-mood" });
		this.bodyEl = this.contentEl.createDiv({ cls: "take-note-side-body" });

		const refreshSoon = debounce(() => void this.render(), 400, true);
		this.registerEvent(this.app.workspace.on("file-open", () => this.followActive()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.followActive()));
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (f === this.note) refreshSoon();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (f) => {
				if (f === this.note) void this.render();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (f === this.note) {
					this.note = null;
					void this.render();
				}
			}),
		);
		this.followActive(true);
	}

	async onClose(): Promise<void> {
		this.audio?.pause();
	}

	/** Show the active Markdown note. Clicking into the sidebar itself keeps the current note. */
	private followActive(force = false) {
		const f = this.app.workspace.getActiveFile();
		if (!f || f.extension !== "md") {
			if (force) void this.render();
			return;
		}
		if (f === this.note && !force) return;
		this.note = f;
		this.filter = "";
		void this.render();
	}

	/** Called by the plugin every second and whenever recording / jobs change. */
	updateStatus() {
		if (!this.statusEl) return;
		const s = this.plugin.status();
		this.statusEl.empty();
		this.statusEl.dataset.mood = s.mood;
		const face = this.statusEl.createDiv({ cls: "take-note-side-face" });
		setIcon(face, MASCOT_ICON[s.mood]);
		const text = this.statusEl.createDiv({ cls: "take-note-side-status-text" });
		text.createDiv({ cls: "take-note-side-status-main", text: s.text });
		if (s.recordingNote && s.recordingNote !== this.note) {
			const link = text.createEl("a", { cls: "take-note-side-status-sub", text: `in ${s.recordingNote.basename}`, href: "#" });
			const target = s.recordingNote;
			link.addEventListener("click", (evt) => {
				evt.preventDefault();
				void this.app.workspace.getLeaf(false).openFile(target);
			});
		}
		const toolbar = this.statusEl.createDiv({ cls: "take-note-side-toolbar" });
		const button = (icon: string, label: string, run: () => void, enabled = true) => {
			const b = toolbar.createDiv({ cls: "clickable-icon", attr: { "aria-label": label, role: "button", tabindex: "0" } });
			setIcon(b, icon);
			if (!enabled) {
				b.addClass("is-disabled");
				return;
			}
			b.addEventListener("click", run);
			b.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					run();
				}
			});
		};
		const note = this.note;
		const busy = s.mood === "busy";
		if (s.mood === "recording" || s.mood === "paused") {
			button(s.mood === "paused" ? "play" : "pause", s.mood === "paused" ? "Resume" : "Pause", () => this.plugin.togglePause());
			button("square", "Stop recording", () => void this.plugin.stopRecording());
		} else {
			button("mic", note && this.plugin.isMeetingNote(note) ? "Record in this note" : "Record in a new meeting note", () => this.plugin.toggleRecording(), !busy);
		}
		button("sparkles", "Summarize with AI", () => note && void this.plugin.processNote(note), !!note && !busy);
		button("audio-lines", "Transcribe audio in this note", () => note && void this.plugin.transcribeEmbedded(note), !!note && !busy);
		button("users", "Name the speakers", () => note && void this.plugin.nameSpeakers(note), !!note && !busy);
		if (busy) button("x", "Cancel", () => this.plugin.cancelJobs());
	}

	async render(): Promise<void> {
		const seq = ++this.renderSeq;
		this.updateStatus();
		const note = this.note;
		const content = note ? await this.app.vault.cachedRead(note) : "";
		if (seq !== this.renderSeq) return; // a newer render started meanwhile
		this.audio?.pause();
		this.audio = null;
		this.lineEls = [];
		this.bodyEl.empty();

		if (!note) {
			this.emptyState("Open a meeting note, or start a new one.", [["mic", "Record a meeting", () => this.plugin.toggleRecording()]]);
			return;
		}

		const title = this.bodyEl.createDiv({ cls: "take-note-side-title", text: note.basename });
		title.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(note));

		const tabs = this.bodyEl.createDiv({ cls: "take-note-side-tabs" });
		for (const [id, label] of [
			["summary", "Summary"],
			["transcript", "Transcript"],
		] as [Tab, string][]) {
			const t = tabs.createDiv({ cls: "take-note-side-tab", text: label });
			t.toggleClass("is-active", this.tab === id);
			t.addEventListener("click", () => {
				this.tab = id;
				void this.render();
			});
		}

		const pane = this.bodyEl.createDiv({ cls: "take-note-side-pane" });
		if (this.tab === "summary") await this.renderSummary(pane, note, content);
		else this.renderTranscript(pane, note, content);
	}

	private emptyState(message: string, actions: [string, string, () => void][], parent = this.bodyEl) {
		const box = parent.createDiv({ cls: "take-note-side-empty take-note-mood" });
		setIcon(box.createDiv({ cls: "take-note-side-empty-face" }), MASCOT_ICON.idle);
		box.createDiv({ text: message });
		for (const [icon, label, run] of actions) {
			const b = box.createEl("button", { cls: "mod-cta" });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", run);
		}
	}

	private async renderSummary(pane: HTMLElement, note: TFile, content: string) {
		const md = getBlock(content, AI_START, AI_END);
		if (md === null) {
			this.emptyState("No AI notes yet. Write some notes, paste a transcript or record, then summarize.", [["sparkles", "Summarize this note", () => void this.plugin.processNote(note)]], pane);
			return;
		}
		const el = pane.createDiv({ cls: "take-note-side-summary markdown-rendered" });
		await MarkdownRenderer.render(this.app, md, el, note.path, this);

		// Ticking a task here ticks it in the note.
		el.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox").forEach((box, n) => {
			box.addEventListener("click", (evt) => {
				evt.preventDefault();
				const done = box.checked; // the new state; preventDefault puts the box back until the note updates
				void this.app.vault.process(note, (c) => setTaskInAiBlock(c, n, done));
			});
		});
		// Links in the rendered summary open like they do in the editor.
		el.addEventListener("click", (evt) => {
			const a = (evt.target as HTMLElement).closest("a.internal-link");
			if (!a?.instanceOf(HTMLAnchorElement)) return;
			evt.preventDefault();
			const href = a.dataset.href ?? a.getAttribute("href") ?? "";
			void this.app.workspace.openLinkText(href, note.path, Keymap.isModEvent(evt));
		});
	}

	private renderTranscript(pane: HTMLElement, note: TFile, content: string) {
		const block = getBlock(content, TX_START, TX_END);
		const parsed = block === null ? null : parseTranscript(block);
		if (!parsed || !parsed.lines.length) {
			this.emptyState(
				parsed ? "The recording hasn't been transcribed yet." : "No transcript in this note yet.",
				[
					["audio-lines", "Transcribe audio in this note", () => void this.plugin.transcribeEmbedded(note)],
					["mic", "Record in this note", () => void this.plugin.startRecording("current")],
				],
				pane,
			);
			return;
		}

		// Player for the recording, if it's in the vault.
		const target = parsed.audioLink ? embedTarget(parsed.audioLink) : null;
		const file = target ? this.app.metadataCache.getFirstLinkpathDest(target, note.path) : null;
		if (file instanceof TFile) {
			const audio = pane.createEl("audio", { cls: "take-note-side-audio", attr: { controls: "", preload: "metadata", src: this.app.vault.getResourcePath(file) } });
			audio.addEventListener("timeupdate", () => this.highlight(audio.currentTime));
			this.audio = audio;
		}

		const tools = pane.createDiv({ cls: "take-note-side-tools" });
		const search = tools.createEl("input", { type: "search", placeholder: "Search the transcript", value: this.filter });
		const speakers = [...new Set(parsed.lines.map((l) => l.speaker).filter((s): s is string => !!s))];
		if (parsed.meta) tools.createDiv({ cls: "take-note-side-meta", text: parsed.meta });

		const list = pane.createDiv({ cls: "take-note-side-lines" });
		const draw = () => {
			list.empty();
			this.lineEls = [];
			const q = this.filter.toLowerCase();
			const shown = parsed.lines.filter((l) => !q || l.text.toLowerCase().includes(q) || (l.speaker ?? "").toLowerCase().includes(q));
			if (!shown.length) list.createDiv({ cls: "take-note-side-none", text: "Nothing matches." });
			for (const line of shown) this.drawLine(list, line, speakers);
		};
		search.addEventListener("input", () => {
			this.filter = search.value;
			draw();
		});
		draw();
	}

	private drawLine(list: HTMLElement, line: TranscriptLine, speakers: string[]) {
		const row = list.createDiv({ cls: "take-note-side-line" });
		if (line.clock) {
			const time = row.createEl("button", { cls: "take-note-side-time", text: line.clock.replace(/^00:/, "") });
			if (this.audio && line.seconds !== null) {
				const at = line.seconds;
				time.setAttr("aria-label", "Play from here");
				time.addEventListener("click", () => {
					if (!this.audio) return;
					this.audio.currentTime = at;
					void this.audio.play();
				});
			} else {
				time.disabled = true;
			}
		}
		const body = row.createDiv({ cls: "take-note-side-text" });
		if (line.speaker) {
			const n = speakers.indexOf(line.speaker);
			body.createSpan({ cls: `take-note-side-speaker take-note-spk-${n % 6}`, text: line.speaker });
		}
		body.createSpan({ text: line.text });
		this.lineEls.push({ el: row, seconds: line.seconds });
	}

	private highlight(now: number) {
		let current: HTMLElement | null = null;
		for (const l of this.lineEls) {
			if (l.seconds !== null && l.seconds <= now) current = l.el;
		}
		for (const l of this.lineEls) l.el.toggleClass("is-playing", l.el === current);
	}
}
