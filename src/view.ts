// The Take Note sidebar: summary, transcript and your own notes for the open meeting note.
import { ItemView, Keymap, MarkdownRenderer, TFile, type WorkspaceLeaf, debounce, setIcon, setTooltip } from "obsidian";
import type TakeNote from "./main.ts";
import { MASCOT_ICON, type Mood } from "./mascot.ts";
import { AI_END, AI_START, TX_END, TX_START, getBlock } from "./render.ts";
import { clock } from "./speakers.ts";
import type { LiveLine } from "./live.ts";
import { type TranscriptLine, embedTarget, getMyNotes, parseTranscript, setMyNotes, setTaskInAiBlock } from "./sidebar-data.ts";

export const VIEW_TYPE = "take-note-sidebar";

export type Tab = "summary" | "transcript" | "notes";

export class TakeNoteView extends ItemView {
	private note: TFile | null = null;
	private tab: Tab = "summary";
	private filter = "";
	private statusEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private audio: HTMLAudioElement | null = null;
	private lineEls: { el: HTMLElement; seconds: number | null }[] = [];
	private renderSeq = 0;
	private statusParts: {
		face: HTMLElement;
		main: HTMLElement;
		sub: HTMLElement;
		toolbar: HTMLElement;
		mood: Mood | null;
		subKeyShown: string;
		toolbarKeyShown: string;
	} | null = null;
	private live: { list: HTMLElement; state: HTMLElement; waiting: HTMLElement | null; shown: number } | null = null;
	private notesEl: HTMLTextAreaElement | null = null;
	private notesStateEl: HTMLElement | null = null;
	private pendingNotes: { note: TFile; text: string } | null = null;
	private saveNotesSoon = debounce(() => void this.flushNotes(), 800, true);

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
				// Don't redraw under the cursor while you're typing in the Notes tab.
				if (f === this.note && !this.editingNotes()) refreshSoon();
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
		await this.flushNotes();
	}

	/** Show the active Markdown note. Clicking into the sidebar itself keeps the current note. */
	private followActive(force = false) {
		const f = this.app.workspace.getActiveFile();
		if (!f || f.extension !== "md") {
			if (force) void this.render();
			return;
		}
		if (f === this.note && !force) return;
		void this.flushNotes();
		this.note = f;
		this.filter = "";
		void this.render();
	}

	/** Called by the plugin every second and whenever recording / jobs change. */
	updateStatus() {
		if (!this.statusEl) return;
		const s = this.plugin.status();
		const note = this.note;
		const busy = s.mood === "busy";
		const meeting = !!note && this.plugin.isMeetingNote(note);

		// Runs every second for the timer: only rebuild what changed, so hovering a button
		// keeps its tooltip instead of the element being replaced under the mouse.
		if (!this.statusParts) {
			this.statusEl.empty();
			const face = this.statusEl.createDiv({ cls: "take-note-side-face" });
			const text = this.statusEl.createDiv({ cls: "take-note-side-status-text" });
			const main = text.createDiv({ cls: "take-note-side-status-main" });
			const sub = text.createDiv({ cls: "take-note-side-status-sub" });
			const toolbar = this.statusEl.createDiv({ cls: "take-note-side-toolbar" });
			this.statusParts = { face, main, sub, toolbar, mood: null, subKeyShown: "", toolbarKeyShown: "" };
		}
		const parts = this.statusParts;
		this.statusEl.dataset.mood = s.mood;
		if (parts.mood !== s.mood) {
			parts.mood = s.mood;
			setIcon(parts.face, MASCOT_ICON[s.mood]);
		}
		parts.main.setText(s.text);

		const subKey = s.recordingNote && s.recordingNote !== note ? s.recordingNote.path : "";
		if (subKey !== parts.subKeyShown) {
			parts.subKeyShown = subKey;
			parts.sub.empty();
			if (s.recordingNote && subKey) {
				const target = s.recordingNote;
				const link = parts.sub.createEl("a", { text: `in ${target.basename}`, href: "#" });
				setTooltip(link, "Go to the note being recorded", { placement: "bottom" });
				link.addEventListener("click", (evt) => {
					evt.preventDefault();
					void this.app.workspace.getLeaf(false).openFile(target);
				});
			}
		}

		const toolbarKey = [s.mood, note?.path ?? "", meeting].join("|");
		if (toolbarKey === parts.toolbarKeyShown) return;
		parts.toolbarKeyShown = toolbarKey;
		const toolbar = parts.toolbar;
		toolbar.empty();
		const button = (icon: string, tip: string, run: () => void, disabledBecause?: string) => {
			const b = toolbar.createDiv({ cls: "clickable-icon", attr: { role: "button", tabindex: "0" } });
			setIcon(b, icon);
			setTooltip(b, disabledBecause ? `${tip}\n(${disabledBecause})` : tip, { placement: "bottom" });
			if (disabledBecause) {
				b.addClass("is-disabled");
				b.setAttr("aria-disabled", "true");
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
		const why = busy ? "busy, wait or cancel" : !note ? "open a note first" : undefined;
		if (s.mood === "recording" || s.mood === "paused") {
			button(s.mood === "paused" ? "play" : "pause", s.mood === "paused" ? "Resume recording" : "Pause recording", () => this.plugin.togglePause());
			button("square", "Stop recording, then transcribe and summarize", () => void this.plugin.stopRecording());
		} else {
			button(
				"mic",
				meeting ? "Record this meeting into this note" : "Record a meeting into a new meeting note",
				() => this.plugin.toggleRecording(),
				busy ? "busy, wait or cancel" : undefined,
			);
		}
		button(
			"sparkles",
			"Summarize with AI: summary, decisions, action items, tickets and questions",
			() => note && void this.flushNotes().then(() => this.plugin.processNote(note)),
			why,
		);
		button("audio-lines", "Transcribe the recording in this note", () => note && void this.plugin.transcribeEmbedded(note), why);
		button("users", "Name the speakers (their voices are remembered next time)", () => note && void this.plugin.nameSpeakers(note), why);
		if (busy) button("x", "Cancel the running transcription or AI job", () => this.plugin.cancelJobs());
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
		this.live = null;
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
			["notes", "Notes"],
		] as [Tab, string][]) {
			const t = tabs.createDiv({ cls: "take-note-side-tab", text: label });
			t.toggleClass("is-active", this.tab === id);
			t.addEventListener("click", () => {
				this.tab = id;
				void this.render();
			});
		}

		const pane = this.bodyEl.createDiv({ cls: "take-note-side-pane" });
		this.notesEl = null;
		if (this.tab === "summary") await this.renderSummary(pane, note, content);
		else if (this.tab === "transcript") this.renderTranscript(pane, note, content);
		else this.renderNotes(pane, note, content);
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
		const live = this.plugin.liveTranscript(note);
		if (live && (!parsed || !parsed.lines.length || parsed.meta === "pending")) {
			this.renderLive(pane, live);
			return;
		}
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

	/** Switch to a tab (the floating button's "Show the transcript"). */
	showTab(tab: Tab) {
		this.tab = tab;
		void this.render();
	}

	/** Called by the plugin when the live transcript of `note` changes. */
	liveChanged(note: TFile) {
		if (note !== this.note || this.tab !== "transcript") return;
		const live = this.plugin.liveTranscript(note);
		if (live && this.live?.list.isConnected) this.appendLive(live);
		else void this.render(); // live started or ended: switch between draft and transcript
	}

	private renderLive(pane: HTMLElement, live: { lines: LiveLine[]; listening: boolean; error: string | null }) {
		const head = pane.createDiv({ cls: "take-note-side-live-head" });
		head.createSpan({ cls: "take-note-side-live-dot" });
		const state = head.createSpan();
		const list = pane.createDiv({ cls: "take-note-side-lines take-note-side-live" });
		const waiting = list.createDiv({ cls: "take-note-side-none", text: "Listening… the first lines appear about 15 seconds in." });
		this.live = { list, state, waiting, shown: 0 };
		this.appendLive(live);
	}

	private appendLive(live: { lines: LiveLine[]; listening: boolean; error: string | null }) {
		const view = this.live;
		if (!view) return;
		view.list.parentElement?.toggleClass("is-listening", live.listening);
		view.state.setText(
			live.error
				? `Live transcript stopped (${live.error}). The recording continues.`
				: live.listening
					? "Live transcript (draft). Speaker names are added when you stop."
					: "Draft. The full transcript with speaker names replaces it when ready.",
		);
		if (view.shown >= live.lines.length) {
			if (!live.listening) view.waiting?.setText(live.error ? "" : "Nothing was transcribed live.");
			return;
		}
		view.waiting?.remove();
		view.waiting = null;
		// Follow new lines only if you're already at the bottom, so reading back isn't interrupted.
		const scroller = this.contentEl;
		const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
		for (const line of live.lines.slice(view.shown)) {
			this.drawLine(view.list, { seconds: line.seconds, clock: clock(line.seconds * 1000), speaker: null, text: line.text }, []);
		}
		view.shown = live.lines.length;
		if (atBottom) scroller.scrollTop = scroller.scrollHeight;
	}

	private editingNotes(): boolean {
		return !!this.notesEl?.isConnected && this.notesEl.ownerDocument.activeElement === this.notesEl;
	}

	/** Write what you typed into the note's "My notes" section. */
	private async flushNotes() {
		const pending = this.pendingNotes;
		if (!pending) return;
		this.pendingNotes = null;
		await this.app.vault.process(pending.note, (c) => (getMyNotes(c) === pending.text.replace(/\s+$/, "") ? c : setMyNotes(c, pending.text)));
		if (!this.pendingNotes) this.notesStateEl?.setText("Saved");
	}

	private renderNotes(pane: HTMLElement, note: TFile, content: string) {
		pane.createDiv({ cls: "take-note-side-meta", text: "Saved into this note's \"My notes\" section. The AI reads it when it summarizes." });
		const area = pane.createEl("textarea", {
			cls: "take-note-side-notes",
			attr: { placeholder: "- What was decided\n- Who will do what\n- Questions to follow up", spellcheck: "true" },
		});
		area.value = getMyNotes(content) ?? "";
		this.notesEl = area;
		this.notesStateEl = pane.createDiv({ cls: "take-note-side-saved" });

		const grow = () => {
			area.setCssProps({ "--take-note-notes-height": "auto" });
			area.setCssProps({ "--take-note-notes-height": `${Math.max(160, area.scrollHeight + 4)}px` });
		};
		area.addEventListener("input", () => {
			this.pendingNotes = { note, text: area.value };
			this.notesStateEl?.setText("Saving…");
			grow();
			this.saveNotesSoon();
		});
		area.addEventListener("blur", () => {
			void this.flushNotes().then(() => void this.render());
		});
		// Enter continues a list: "- ", "- [ ] ", "1. ". Enter on an empty bullet ends the list.
		area.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" || evt.shiftKey || evt.isComposing) return;
			const pos = area.selectionStart;
			if (pos !== area.selectionEnd) return;
			const lineStart = area.value.lastIndexOf("\n", pos - 1) + 1;
			const line = area.value.slice(lineStart, pos);
			const m = line.match(/^(\s*)([-*+]|\d+\.)( \[[ xX]\])? /);
			if (!m) return;
			evt.preventDefault();
			if (line === m[0]) {
				area.setRangeText("", lineStart, pos, "end");
			} else {
				const bullet = /^\d+\.$/.test(m[2]) ? `${parseInt(m[2], 10) + 1}.` : m[2];
				area.setRangeText(`\n${m[1]}${bullet}${m[3] ? " [ ]" : ""} `, pos, pos, "end");
			}
			area.dispatchEvent(new Event("input"));
		});
		window.setTimeout(grow, 0);
	}

	private drawLine(list: HTMLElement, line: TranscriptLine, speakers: string[]) {
		const row = list.createDiv({ cls: "take-note-side-line" });
		if (line.clock) {
			const time = row.createEl("button", { cls: "take-note-side-time", text: line.seconds === null ? line.clock : line.clock.replace(/^00:/, "") });
			if (this.audio && line.seconds !== null) {
				const at = line.seconds;
				setTooltip(time, "Play the recording from here");
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
