import {
	FileSystemAdapter,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	SuggestModal,
	TFile,
	TFolder,
	normalizePath,
	requestUrl,
} from "obsidian";
import { electron, fs, os, path } from "./node.ts";
import { DEFAULT_SETTINGS, TakeNoteSettingTab, TakeNoteSettings } from "./settings.ts";
import { MeetingRecorder } from "./recorder.ts";
import { type SpeakerConfig, checkWhisperSetup, embedWav, toWav, transcribeFile } from "./transcribe.ts";
import { type LiveLine, LiveTranscriber } from "./live.ts";
import HELPER_SOURCE from "../helper/speakers.cjs";
import { addVoice, findNode, loadSession, loadVoices, newSessionId, saveSession, speakerSetupProblems } from "./voices.ts";
import { renameSpeaker, transcriptSpeakers } from "./speakers.ts";
import { NameSpeakersModal, VoiceSampleModal } from "./modals.ts";
import { type ChatImport, ImportChatModal } from "./chat-modal.ts";
import { PROVIDERS, type ProviderId, inferProvider, providerChat } from "./providers.ts";
import { setPlainRequest } from "./llm.ts";
import { hasDesktopFeatures } from "./platform.ts";
import { type FabAction, FloatingButton } from "./fab.ts";
import { BUBBLES, type BubbleId, SIDES, type Side, normalizeLayout } from "./bubbles.ts";
import { MASCOT_ICON, type Mood, registerMascotIcons } from "./mascot.ts";
import { TakeNoteView, VIEW_TYPE } from "./view.ts";
import { extractMeeting, type MeetingNotes } from "./extract.ts";
import {
	AI_END,
	AI_START,
	TX_END,
	TX_START,
	collectSources,
	createdValue,
	stamp,
	formatClock,
	renderMeeting,
	getBlock,
	renderTranscript,
	safeFileName,
	speakerSessionId,
	upsertBlock,
	upsertPersonLine,
} from "./render.ts";

const AUDIO_EXT = ["webm", "m4a", "mp3", "wav", "ogg", "opus", "aac", "flac", "mp4", "mov", "mkv"];
/** A frontmatter value that may be a list, a single value or missing, as strings. */
function asList(v: unknown): string[] {
	if (v === undefined || v === null || v === "") return [];
	return (Array.isArray(v) ? v : [v]).map((x) => String(x).replace(/^#/, ""));
}

/** A vault path's file name without its extension ("Meetings/2026-11-20 – Sync.md" → "2026-11-20 – Sync"). */
function fileBase(p: string): string {
	return p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
}

const DEFAULT_NAME = /^\d{4}-\d{2}-\d{2} – Meeting( \d{4})?( \d+)?$/;

/** A Notice that stays up and can be updated, used for long jobs. */
class Progress {
	private notice: Notice;
	constructor(msg: string) {
		this.notice = new Notice(msg, 0);
	}
	set(msg: string) {
		this.notice.setMessage(msg);
	}
	done(msg: string, ms = 6000) {
		this.notice.hide();
		new Notice(msg, ms);
	}
	hide() {
		this.notice.hide();
	}
}

class AudioPicker extends SuggestModal<TFile> {
	constructor(plugin: Plugin, private files: TFile[], private onPick: (f: TFile) => void) {
		super(plugin.app);
		this.setPlaceholder("Which recording should be transcribed?");
	}
	getSuggestions(q: string) {
		return this.files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));
	}
	renderSuggestion(f: TFile, el: HTMLElement) {
		el.setText(f.path);
	}
	onChooseSuggestion(f: TFile) {
		this.onPick(f);
	}
}

export default class TakeNote extends Plugin {
	declare settings: TakeNoteSettings;
	private recorder = new MeetingRecorder();
	/** `fresh` is the note's text when recording created it, so an untouched note can be removed again. */
	private recording: { note: TFile; audioPath: string; fresh: string | null } | null = null;
	private statusEl!: HTMLElement;
	private jobs = new Map<TFile, AbortController>(); // note -> running job (the TFile survives renames; its path does not)
	private fab: FloatingButton | null = null;
	private busyText = "Working…";
	/** Live transcript of the current (or just finished) recording, until the full transcript replaces it. */
	private live: { note: TFile; t: LiveTranscriber } | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TakeNoteSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("take-note-status");
		this.statusEl.onClickEvent(() => {
			if (this.recording) void this.stopRecording();
		});
		this.registerInterval(window.setInterval(() => this.updateStatus(), 1000));

		registerMascotIcons();
		const desktop = hasDesktopFeatures();
		// Phones have no Node http: the AI is reached through Obsidian's requestUrl there.
		setPlainRequest(async (r) => {
			const res = await requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body, throw: false });
			return { status: res.status, headers: res.headers, text: res.text };
		});
		if (desktop) this.addRibbonIcon(MASCOT_ICON.idle, "Take Note: start / stop recording", () => this.toggleRecording());
		else this.addRibbonIcon(MASCOT_ICON.idle, "Take Note", (evt) => this.mobileMenu(evt));
		this.registerView(VIEW_TYPE, (leaf) => new TakeNoteView(leaf, this));
		this.app.workspace.onLayoutReady(() => {
			this.refreshFloatingButton();
			// Obsidian closes a plugin's panels when the plugin is turned off, so add it back.
			if (this.settings.showSidebar) void this.openSidebar(false);
		});
		this.addCommand({
			id: "open-sidebar",
			name: "Open the sidebar (summary & transcript)",
			callback: () => void this.openSidebar(true),
		});
		this.registerDomEvent(window, "resize", () => this.fab?.clamp());

		this.addCommand({
			id: "new-meeting-note",
			name: "New meeting note (no recording)",
			callback: async () => {
				const f = await this.createMeetingNote();
				await this.openNote(f);
			},
		});
		if (desktop) this.addRecordingCommands();
		this.addCommand({
			id: "process-note",
			name: "Summarize & extract action items, tickets, questions (AI)",
			checkCallback: (checking) => {
				const f = this.activeNote();
				if (!f) return false;
				if (!checking) void this.processNote(f);
				return true;
			},
		});
		this.addCommand({
			id: "import-chat",
			name: "Import a chat (WhatsApp / Telegram export or pasted messages)",
			callback: () => this.importChat(),
		});
		this.addCommand({
			id: "cancel",
			name: desktop ? "Cancel running transcription / AI job" : "Cancel running AI job",
			checkCallback: (checking) => {
				if (!this.jobs.size) return false;
				if (!checking) {
					this.jobs.forEach((c) => c.abort());
					new Notice("Take Note: cancelled.");
				}
				return true;
			},
		});
	}

	/** Commands that need the desktop app: the microphone, Whisper and speaker separation. */
	private addRecordingCommands() {
		this.addCommand({
			id: "start-recording-new",
			name: "Start recording in a new meeting note",
			checkCallback: (checking) => {
				if (this.recording) return false;
				if (!checking) void this.startRecording("new");
				return true;
			},
		});
		this.addCommand({
			id: "start-recording-current",
			name: "Start recording in the current note",
			checkCallback: (checking) => {
				if (this.recording || !this.activeNote()) return false;
				if (!checking) void this.startRecording("current");
				return true;
			},
		});
		this.addCommand({
			id: "stop-recording",
			name: "Stop recording",
			checkCallback: (checking) => {
				if (!this.recording) return false;
				if (!checking) void this.stopRecording();
				return true;
			},
		});
		this.addCommand({
			id: "pause-recording",
			name: "Pause / resume recording",
			checkCallback: (checking) => {
				if (!this.recording) return false;
				if (!checking) {
					this.togglePause();
				}
				return true;
			},
		});
		this.addCommand({
			id: "transcribe-note-audio",
			name: "Transcribe audio embedded in the current note",
			checkCallback: (checking) => {
				const f = this.activeNote();
				if (!f) return false;
				if (!checking) void this.transcribeEmbedded(f);
				return true;
			},
		});
		this.addCommand({
			id: "import-audio",
			name: "Import a recording (Zoom/Teams/phone audio or video) and transcribe",
			callback: () => this.importRecording(),
		});
		this.addCommand({
			id: "name-speakers",
			name: "Name the speakers in this note (and remember their voices)",
			checkCallback: (checking) => {
				const f = this.activeNote();
				if (!f) return false;
				if (!checking) void this.nameSpeakers(f);
				return true;
			},
		});
		this.addCommand({
			id: "voice-sample",
			name: "Record a voice sample for a person",
			callback: () => this.recordVoiceSample(),
		});
	}

	onunload() {
		this.fab?.destroy();
		this.jobs.forEach((c) => c.abort());
		// Flush audio so nothing is lost (best effort).
		this.live?.t.stop();
		if (this.recording) this.recorder.stop().catch(() => {});
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<TakeNoteSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// Settings from before providers existed: work out which one the URL points at.
		if (saved && !saved.provider) this.settings.provider = inferProvider(this.settings.baseUrl);
		delete (this.settings as Partial<Record<"sidebarAdded", unknown>>).sidebarAdded; // replaced by showSidebar
		// Bubbles: known ones only, each once; older versions kept one list (a row, then a column).
		const legacy = (saved as Partial<Record<"fabBubbles", unknown>> | null)?.fabBubbles;
		this.settings.fabLayout = normalizeLayout(saved?.fabLayout, legacy);
		delete (this.settings as Partial<Record<"fabBubbles", unknown>>).fabBubbles;
	}

	/** Switch LLM provider, remembering the old one's URL, model and key for switching back. */
	switchProvider(to: ProviderId) {
		const s = this.settings;
		if (to === s.provider) return;
		s.providerMemory = { ...s.providerMemory, [s.provider]: { baseUrl: s.baseUrl, model: s.model, apiKeySecret: s.apiKeySecret } };
		const p = PROVIDERS[to];
		const back = s.providerMemory[to];
		s.provider = to;
		s.baseUrl = back?.baseUrl || p.baseUrl;
		s.model = back?.model ?? p.defaultModel;
		s.apiKeySecret = back?.apiKeySecret ?? "";
	}

	// ---------- floating button ----------

	refreshFloatingButton() {
		// Phones: no hover and no recording, so no floating button (the ribbon menu has the actions).
		if (!this.settings.showFloatingButton || !hasDesktopFeatures()) {
			this.fab?.destroy();
			this.fab = null;
			return;
		}
		this.fab?.destroy();
		this.fab = new FloatingButton(this.app.workspace.containerEl, this.settings.floatingButtonPos, {
			onClick: () => {
				if (!this.recording && this.jobs.size) new Notice(`Take Note is busy: ${this.busyText} Right-click the button to cancel.`);
				else this.toggleRecording();
			},
			onMenu: (evt) => this.fabMenu(evt),
			onMoved: (pos) => {
				this.settings.floatingButtonPos = pos;
				void this.saveSettings();
			},
			actions: () => this.fabActions(),
		});
		this.updateStatus();
	}

	/** The bubbles on each side of the floating button, as laid out in settings. */
	private fabActions(): Record<Side, FabAction[]> {
		const out: Record<Side, FabAction[]> = { left: [], top: [], right: [], bottom: [] };
		if (!this.settings.fabBubblesOn) return out;
		for (const side of SIDES) {
			for (const id of this.settings.fabLayout[side]) {
				const a = this.bubbleAction(id);
				if (a) out[side].push(a);
			}
		}
		return out;
	}

	/** What a bubble does right now, or null when it doesn't apply (Pause when not recording…). */
	private bubbleAction(id: BubbleId): FabAction | null {
		const rec = this.recording;
		const note = this.activeNote();
		const icon = BUBBLES[id].icon;
		switch (id) {
			case "note":
				return { icon, title: rec ? "Go to the note being recorded" : "Go to the current meeting note", run: () => void this.goToCurrentNote() };
			case "record":
				return {
					icon: rec ? "square" : icon,
					title: rec ? "Stop recording" : this.isMeetingNote(note) ? "Record in this note" : "Record in a new meeting note",
					run: () => this.toggleRecording(),
				};
			case "recordNew":
				return {
					icon: rec ? "square" : icon,
					title: rec ? "Stop recording" : "Record in a new meeting note",
					run: () => void (rec ? this.stopRecording() : this.startRecording("new")),
				};
			case "transcript":
				return { icon, title: "Show the transcript", run: () => void this.showTranscript() };
			case "import":
				return {
					icon,
					title: "Import a chat or recording (new note)…",
					run: (evt) => {
						const menu = new Menu();
						menu.addItem((i) => i.setTitle("Import a chat (WhatsApp / Telegram)…").setIcon("messages-square").onClick(() => this.importChat()));
						menu.addItem((i) => i.setTitle("Import a recording (audio / video)…").setIcon("upload").onClick(() => this.importRecording()));
						menu.showAtMouseEvent(evt);
					},
				};
			case "importChat":
				return { icon, title: "Import a chat (new note)…", run: () => this.importChat() };
			case "importRecording":
				return { icon, title: "Import a recording (new note)…", run: () => this.importRecording() };
			case "summarize":
				return note ? { icon, title: "Summarize this note with AI", run: () => void this.processNote(note) } : null;
			case "pause": {
				if (!rec) return null;
				const paused = this.recorder.isPaused;
				return { icon: paused ? "play" : icon, title: paused ? "Resume recording" : "Pause recording", run: () => this.togglePause() };
			}
			case "speakers":
				return note ? { icon, title: "Name the speakers", run: () => void this.nameSpeakers(note) } : null;
			case "sidebar":
				return { icon, title: "Open the sidebar", run: () => void this.openSidebar(true) };
			case "newNote":
				return { icon, title: "New meeting note", run: () => void this.createMeetingNote().then((f) => this.openNote(f)) };
			case "cancel":
				return this.jobs.size ? { icon, title: "Cancel the running job", run: () => this.cancelJobs() } : null;
		}
	}


	/**
	 * The meeting note you're working on: the one being recorded or processed, else the open
	 * note if it's a meeting note, else the most recently edited one.
	 */
	private currentMeetingNote(): TFile | null {
		if (this.recording) return this.recording.note;
		if (this.live) return this.live.note;
		const busy = [...this.jobs.keys()][0];
		if (busy) return busy;
		const open = this.activeNote();
		if (open && this.isMeetingNote(open)) return open;
		const notes = this.app.vault.getMarkdownFiles().filter((f) => this.isMeetingNote(f));
		return notes.sort((a, b) => b.stat.mtime - a.stat.mtime)[0] ?? null;
	}

	private async goToCurrentNote(): Promise<TFile | null> {
		const note = this.currentMeetingNote();
		if (!note) {
			new Notice("No meeting notes yet. Click the mic to record one.");
			return null;
		}
		if (this.activeNote() !== note) await this.openNote(note);
		return note;
	}

	/** Open the current meeting note with the sidebar on its Transcript tab. */
	private async showTranscript() {
		if (!(await this.goToCurrentNote())) return;
		await this.openSidebar(true);
		this.sidebarViews().forEach((v) => v.showTab("transcript"));
	}

	private fabMenu(evt: MouseEvent) {
		const menu = new Menu();
		const note = this.activeNote();
		const add = (title: string, icon: string, run: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(run));
		if (this.recording) {
			add(this.recorder.isPaused ? "Resume recording" : "Pause recording", this.recorder.isPaused ? "play" : "pause", () => this.togglePause());
			add("Stop recording", "square", () => void this.stopRecording());
		} else {
			add("Record in a new meeting note", "mic", () => void this.startRecording("new"));
			if (note) add("Record in this note", "file-audio", () => void this.startRecording("current"));
		}
		if (this.jobs.size) {
			add("Cancel the running job", "x", () => this.cancelJobs());
		}
		menu.addSeparator();
		if (note) {
			add("Summarize this note with AI", "sparkles", () => void this.processNote(note));
			add("Transcribe audio in this note", "audio-lines", () => void this.transcribeEmbedded(note));
			add("Name the speakers", "users", () => void this.nameSpeakers(note));
		}
		add("Open the sidebar", "panel-right", () => void this.openSidebar(true));
		add("Import a recording…", "upload", () => this.importRecording());
		add("Import a chat…", "messages-square", () => this.importChat());
		add("New meeting note", "file-plus", () => {
			void this.createMeetingNote().then((f) => this.openNote(f));
		});
		menu.addSeparator();
		add("Hide this button", "eye-off", () => {
			this.settings.showFloatingButton = false;
			void this.saveSettings();
			this.refreshFloatingButton();
			new Notice("Floating button hidden. Turn it back on in Settings → Take Note.");
		});
		menu.showAtMouseEvent(evt);
	}

	/** The ribbon button on phones: what Take Note can do without the desktop app. */
	private mobileMenu(evt: MouseEvent) {
		const menu = new Menu();
		const note = this.activeNote();
		const add = (title: string, icon: string, run: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(run));
		add("Import a chat…", "messages-square", () => this.importChat());
		if (note) add("Summarize this note with AI", "sparkles", () => void this.processNote(note));
		if (this.jobs.size) add("Cancel the running job", "x", () => this.cancelJobs());
		add("Open the sidebar", "panel-right", () => void this.openSidebar(true));
		add("New meeting note", "file-plus", () => void this.createMeetingNote().then((f) => this.openNote(f)));
		menu.showAtMouseEvent(evt);
	}

	/** Show the sidebar, creating it in the right sidebar if needed. */
	async openSidebar(reveal: boolean) {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE, active: reveal });
			leaf = right;
		}
		if (reveal) await this.app.workspace.revealLeaf(leaf);
	}

	closeSidebar() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	private sidebarViews(): TakeNoteView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is TakeNoteView => v instanceof TakeNoteView);
	}

	/** What the plugin is doing right now, for the button and the sidebar. */
	status(): { mood: Mood; text: string; recordingNote: TFile | null } {
		if (this.recording) {
			const paused = this.recorder.isPaused;
			return { mood: paused ? "paused" : "recording", text: `${paused ? "Paused" : "Recording"} ${formatClock(this.recorder.elapsedMs)}`, recordingNote: this.recording.note };
		}
		if (this.jobs.size) return { mood: "busy", text: this.busyText, recordingNote: null };
		return { mood: "idle", text: "Ready to take notes", recordingNote: null };
	}

	togglePause() {
		if (!this.recording) return;
		if (this.recorder.isPaused) this.recorder.resume();
		else {
			this.recorder.pause();
			this.live?.t.flush(); // show what was said so far
		}
		this.updateStatus();
	}

	cancelJobs() {
		this.jobs.forEach((c) => c.abort());
		new Notice("Take Note: cancelled.");
	}

	toggleRecording() {
		if (this.recording) void this.stopRecording();
		else void this.startRecording(this.isMeetingNote(this.activeNote()) ? "current" : "new");
	}

	/** Show progress of a long job in the status bar and on the floating button. */
	private showBusy(text: string, short: string) {
		this.busyText = text;
		this.statusEl.setText(short);
		this.statusEl.show();
		this.fab?.set("busy", text, true);
		this.sidebarViews().forEach((v) => v.updateStatus());
	}

	/** data.json changed on disk (iCloud sync or an outside edit): reload so we never overwrite it with stale values. */
	async onExternalSettingsChange() {
		await this.loadSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getApiKey(): string {
		const id = this.settings.apiKeySecret;
		return (id && this.app.secretStorage.getSecret(id)) || "";
	}

	// ---------- helpers ----------

	private activeNote(): TFile | null {
		const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
		return f && f.extension === "md" ? f : null;
	}

	isMeetingNote(f: TFile | null): boolean {
		if (!f) return false;
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		return asList(fm?.tags).some((t) => t === "meeting" || t === "chat") || f.path.startsWith(this.settings.meetingsFolder + "/");
	}

	/** A note made by "Import a chat" (the AI reads it as messages, not a meeting). */
	private isChatNote(f: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		return asList(fm?.tags).includes("chat") || typeof fm?.chat === "string";
	}

	private absPath(vaultPath: string): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Take Note needs the desktop app.");
		return adapter.getFullPath(normalizePath(vaultPath));
	}

	private async ensureFolder(folder: string) {
		if (!folder || folder === "/") return;
		const parts = normalizePath(folder).split("/");
		for (let i = 1; i <= parts.length; i++) {
			const p = parts.slice(0, i).join("/");
			if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p).catch(() => {});
		}
	}

	private uniquePath(folder: string, base: string, ext: string): string {
		let p = normalizePath(`${folder ? folder + "/" : ""}${base}.${ext}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(p); i++) {
			p = normalizePath(`${folder ? folder + "/" : ""}${base} ${i}.${ext}`);
		}
		return p;
	}

	private async openNote(f: TFile) {
		await this.app.workspace.getLeaf(false).openFile(f);
	}

	private knownPeople(): string[] {
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.peopleFolder || "People"));
		if (!(folder instanceof TFolder)) return [];
		return folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md").map((f) => f.basename);
	}

	private noteDate(f: TFile): string {
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		// A chat's date is its last message, not the day it was imported.
		const raw: unknown = fm?.chat_end ?? fm?.created ?? fm?.date;
		const fromFm = (typeof raw === "string" ? raw : "").match(/\d{4}-\d{2}-\d{2}/);
		if (fromFm) return fromFm[0];
		const fromName = f.basename.match(/\d{4}-\d{2}-\d{2}/);
		return fromName ? fromName[0] : stamp("YYYY-MM-DD");
	}

	private updateStatus() {
		if (this.recording) {
			const paused = this.recorder.isPaused;
			this.statusEl.setText(`${paused ? "⏸" : "🔴"} ${formatClock(this.recorder.elapsedMs)}`);
			this.statusEl.setAttr("aria-label", "Click to stop recording");
			this.statusEl.toggleClass("is-recording", !paused);
			this.statusEl.show();
			this.fab?.set(paused ? "paused" : "recording", `${paused ? "Paused" : "Recording"} ${formatClock(this.recorder.elapsedMs)}`, true);
		} else if (!this.jobs.size) {
			this.statusEl.setText("");
			this.statusEl.hide();
			this.fab?.set("idle", "Record a meeting");
		} else {
			this.fab?.set("busy", this.busyText, true);
		}
		this.sidebarViews().forEach((v) => v.updateStatus());
	}

	private async waitForFile(vaultPath: string): Promise<TFile | null> {
		for (let i = 0; i < 20; i++) {
			const f = this.app.vault.getAbstractFileByPath(vaultPath);
			if (f instanceof TFile) return f;
			await new Promise((r) => window.setTimeout(r, 250));
		}
		return null;
	}

	// ---------- speakers ----------

	/** Config for speaker separation, or null if it's off or not set up. */
	private speakerConfig(): SpeakerConfig | null {
		const s = this.settings;
		if (!s.speakersEnabled) return null;
		const nodePath = findNode(s.nodePath);
		if (!nodePath || speakerSetupProblems(nodePath).length) return null;
		return {
			nodePath,
			helperSource: HELPER_SOURCE,
			numSpeakers: s.numSpeakers,
			clusterThreshold: s.clusterThreshold,
			mergeThreshold: s.mergeThreshold,
			matchThreshold: s.matchThreshold,
			profiles: loadVoices(),
		};
	}

	async nameSpeakers(note: TFile) {
		const content = await this.app.vault.read(note);
		const block = getBlock(content, TX_START, TX_END);
		const session = speakerSessionId(content);
		if (!block || !session) {
			new Notice("This note's transcript wasn't separated by speaker. Transcribe it again with \"Tell speakers apart\" on.");
			return;
		}
		const speakers = transcriptSpeakers(block);
		if (!speakers.length) {
			new Notice("No speaker labels found in the transcript.");
			return;
		}
		new NameSpeakersModal(this.app, speakers, this.knownPeople(), async (renames, rerun) => {
			await this.app.vault.process(note, (c) => {
				const b = getBlock(c, TX_START, TX_END);
				if (b === null) return c;
				let nb = b;
				for (const [from, to] of renames) nb = renameSpeaker(nb, from, to);
				return c.replace(b, nb);
			});
			const remembered: string[] = [];
			const stored = loadSession(session);
			if (stored) {
				for (const [from, to] of renames) {
					const print = stored.speakers[from];
					if (!print) continue;
					// Only learn from voices with enough audio to be reliable.
					if (print.embedding && print.seconds >= 3) {
						addVoice(to, print.embedding);
						remembered.push(to);
					}
					delete stored.speakers[from];
					stored.speakers[to] = print;
				}
				saveSession(session, stored);
			}
			new Notice(
				`Renamed ${renames.length} speaker${renames.length === 1 ? "" : "s"}.` +
					(remembered.length ? ` Remembered: ${remembered.join(", ")} — recognised automatically from now on.` : ""),
				8000,
			);
			if (rerun) await this.processNote(note);
		}).open();
	}

	private recordVoiceSample() {
		const nodePath = findNode(this.settings.nodePath);
		const problems = speakerSetupProblems(nodePath);
		if (!nodePath || problems.length) {
			new Notice("Speaker setup incomplete: " + problems.join("; "), 10000);
			return;
		}
		new VoiceSampleModal(this.app, this.knownPeople(), this.settings.micDeviceId, async (name, file) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "take-note-voice-"));
			try {
				const wav = path.join(dir, "voice.wav");
				const secs = await toWav(this.settings, file, wav);
				if (secs < 5) throw new Error("Sample too short — record at least 10 seconds.");
				addVoice(name, await embedWav({ nodePath, helperSource: HELPER_SOURCE }, wav));
				new Notice(`✅ Saved ${name}'s voice. They'll be named automatically in future transcripts.`, 8000);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
				fs.rmSync(file, { force: true });
			}
		}).open();
	}

	/** Add/replace this meeting's line in each speaker's People note. */
	private async updatePeopleNotes(note: TFile, result: MeetingNotes) {
		const folder = normalizePath(this.settings.peopleFolder || "People");
		const people = new Map(this.knownPeople().map((n) => [n.toLowerCase(), n]));
		const me = (this.settings.myName || "").toLowerCase();
		let updated = 0;
		for (const p of result.by_person) {
			const name = safeFileName(p.name);
			if (!name || /^speaker \d+$/i.test(name) || name.toLowerCase() === me) continue;
			const summary = p.summary || p.commitments[0] || p.updates[0] || "attended";
			const existing = people.get(name.toLowerCase());
			const found = existing ? this.app.vault.getAbstractFileByPath(`${folder}/${existing}.md`) : null;
			let file: TFile;
			if (found instanceof TFile) {
				file = found;
			} else {
				if (!this.settings.createPeopleNotes) continue;
				await this.ensureFolder(folder);
				file = await this.app.vault.create(`${folder}/${name}.md`, `---\ntags: [person]\nrole:\n---\n\n# ${name}\n\n## Notes\n`);
			}
			await this.app.vault.process(file, (c) => upsertPersonLine(c, note.basename, summary));
			updated++;
		}
		if (updated) new Notice(`👥 Updated ${updated} People note${updated === 1 ? "" : "s"}.`);
	}

	// ---------- notes ----------

	/**
	 * Whether `created` should carry a time. Follows the vault's property type (Settings →
	 * Properties); a vault that hasn't typed it yet gets date & time.
	 */
	private async createdHasTime(): Promise<boolean> {
		try {
			const raw = await this.app.vault.adapter.read(normalizePath(`${this.app.vault.configDir}/types.json`));
			const types = (JSON.parse(raw) as { types?: Record<string, string> }).types ?? {};
			return types.created !== "date";
		} catch {
			return true;
		}
	}

	async createMeetingNote(title?: string): Promise<TFile> {
		const date = stamp("YYYY-MM-DD");
		const created = (await this.createdHasTime()) ? stamp("YYYY-MM-DDTHH:mm") : date;
		const base = safeFileName(`${date} – ${title ?? "Meeting " + stamp("HHmm")}`);
		await this.ensureFolder(this.settings.meetingsFolder);
		const p = this.uniquePath(this.settings.meetingsFolder, base, "md");
		const content = [
			"---",
			"tags:",
			"  - meeting",
			`created: ${created}`,
			"people: []",
			"---",
			`# ${fileBase(p)}`,
			"",
			"## My notes",
			"- ",
			"",
		].join("\n");
		return this.app.vault.create(p, content);
	}

	// ---------- recording ----------

	async startRecording(where: "new" | "current") {
		let note = where === "current" ? this.activeNote() : null;
		let fresh: string | null = null;
		try {
			if (!note) {
				note = await this.createMeetingNote();
				fresh = await this.app.vault.read(note);
				await this.openNote(note);
			}
			const name = `${stamp("YYYY-MM-DD HHmm")} recording.${this.recorder.ext}`;
			const audioPath = await this.app.fileManager.getAvailablePathForAttachment(name, note.path);
			await this.ensureFolder(path.posix.dirname(audioPath));
			await this.recorder.start(this.absPath(audioPath), this.settings.micDeviceId || undefined);
			this.recording = { note, audioPath, fresh };
			this.startLive(note);
			this.updateStatus();
			new Notice("🔴 Recording. Type your own notes under \"My notes\" — click the timer in the status bar to stop.");
		} catch (e) {
			this.recording = null;
			const msg = (e as Error).message;
			new Notice(
				/Permission|NotAllowed/i.test(msg)
					? "Microphone access was denied. Allow Obsidian in System Settings → Privacy & Security → Microphone."
					: "Could not start recording: " + msg,
				10000,
			);
		}
	}

	async stopRecording() {
		const rec = this.recording;
		if (!rec) return;
		this.recording = null;
		let ms = 0;
		try {
			ms = await this.recorder.stop();
		} catch (e) {
			new Notice((e as Error).message, 10000);
		}
		// Transcribe the last few seconds, then stop listening. The draft stays on screen until
		// the full transcript replaces it.
		this.recorder.onData = null;
		const live = this.live;
		if (live) void live.t.finish().then(() => this.liveChanged(live.note));
		this.updateStatus();
		const min = this.settings.minRecordingSeconds;
		if (min > 0 && ms < min * 1000) {
			this.clearLive();
			await this.discardRecording(rec, ms, min);
			return;
		}
		const audio = await this.waitForFile(rec.audioPath);
		const link = audio ? "!" + this.app.fileManager.generateMarkdownLink(audio, rec.note.path) : `![[${path.basename(rec.audioPath)}]]`;
		// Link the audio right away so it is never orphaned, even if transcription is skipped.
		await this.app.vault.process(rec.note, (c) =>
			upsertBlock(c, TX_START, TX_END, renderTranscript("(not transcribed yet — run \"Transcribe audio embedded in the current note\")", link, "pending"), "end"),
		);
		new Notice(`Recording saved (${formatClock(ms)}).`);
		if (this.settings.autoTranscribe) await this.transcribe(rec.note, rec.audioPath, link);
	}

	/** A recording stopped within seconds was most likely a mis-tap: remove it instead of transcribing. */
	private async discardRecording(rec: { note: TFile; audioPath: string; fresh: string | null }, ms: number, min: number) {
		const audio = await this.waitForFile(rec.audioPath);
		try {
			// trashFile follows the user's "Deleted files" setting, so it can be recovered.
			if (audio) await this.app.fileManager.trashFile(audio);
			else fs.rmSync(this.absPath(rec.audioPath), { force: true });
		} catch {
			/* already gone */
		}
		let removedNote = false;
		const note = this.app.vault.getAbstractFileByPath(rec.note.path);
		if (rec.fresh !== null && note instanceof TFile) {
			const now = await this.app.vault.read(note);
			if (now.trim() === rec.fresh.trim()) {
				await this.app.fileManager.trashFile(note);
				removedNote = true;
			}
		}
		new Notice(
			`🗑️ Discarded a ${formatClock(ms)} recording: stopped within ${min} s, so it looked accidental.` +
				(removedNote ? " Its empty meeting note was removed too." : "") +
				"\nChange this under Settings → Take Note → Discard short recordings.",
			8000,
		);
	}

	// ---------- live transcript ----------

	/** The live draft for this note, if it has one (while recording, and until the full transcript is in). */
	/** Whether `note` is the one being recorded right now. */
	isRecordingInto(note: TFile): boolean {
		return this.recording?.note === note;
	}

	liveTranscript(note: TFile): { lines: LiveLine[]; listening: boolean; error: string | null } | null {
		if (this.live?.note !== note) return null;
		const t = this.live.t;
		return { lines: t.lines, listening: t.listening, error: t.error };
	}

	private startLive(note: TFile) {
		this.clearLive();
		const s = this.settings;
		if (!s.liveTranscript) return;
		const cfg = { ...s, prompt: [s.whisperPrompt, this.knownPeople().join(", ")].filter(Boolean).join(", ") };
		if (checkWhisperSetup(cfg).length) return; // the full transcription reports what is missing
		try {
			const t = new LiveTranscriber(cfg, () => this.liveChanged(note));
			t.start();
			this.recorder.onData = (chunk) => t.push(chunk);
			this.live = { note, t };
		} catch (e) {
			console.error("Take Note: live transcript could not start", e);
		}
		this.liveChanged(note);
	}

	private clearLive() {
		const note = this.live?.note;
		this.recorder.onData = null;
		this.live?.t.stop();
		this.live = null;
		if (note) this.liveChanged(note);
	}

	private liveChanged(note: TFile) {
		this.sidebarViews().forEach((v) => v.liveChanged(note));
	}

	// ---------- transcription ----------

	async transcribeEmbedded(note: TFile) {
		const cache = this.app.metadataCache.getFileCache(note);
		const audios = (cache?.embeds ?? [])
			.map((e) => this.app.metadataCache.getFirstLinkpathDest(e.link.split("#")[0], note.path))
			.filter((f): f is TFile => !!f && AUDIO_EXT.includes(f.extension.toLowerCase()));
		const unique = [...new Map(audios.map((f) => [f.path, f])).values()];
		if (!unique.length) {
			new Notice("No audio or video embedded in this note. Use \"Import a recording\" for files outside the vault.");
			return;
		}
		const go = (f: TFile) => this.transcribe(note, f.path, "!" + this.app.fileManager.generateMarkdownLink(f, note.path));
		if (unique.length === 1) void go(unique[0]);
		else new AudioPicker(this, unique, (f) => void go(f)).open();
	}

	private importRecording() {
		const input = createEl("input");
		input.type = "file";
		input.accept = "audio/*,video/*," + AUDIO_EXT.map((e) => "." + e).join(",");
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			// Electron: get the real path so large videos are never copied into the vault.
			let filePath = "";
			try {
				filePath = electron.webUtils?.getPathForFile?.(file) ?? "";
			} catch {
				/* older Electron */
			}
			filePath = filePath || (file as File & { path?: string }).path || "";
			if (!filePath) {
				new Notice("Could not read that file's location.");
				return;
			}
			const title = safeFileName(path.parse(filePath).name) || undefined;
			const note = await this.createMeetingNote(title);
			await this.openNote(note);
			await this.transcribe(note, filePath, `Source: \`${filePath}\``, true);
		};
		input.click();
	}

	importChat() {
		const s = this.settings;
		new ImportChatModal(this.app, { myName: s.myName, maxInputTokens: s.maxInputTokens, summarize: s.autoProcess }, async (c) => {
			const note = await this.createChatNote(c);
			await this.openNote(note);
			new Notice(`💬 Imported ${c.meta}.`);
			if (s.autoProcess) await this.processNote(note);
		}).open();
	}

	/** A note holding an imported chat, named after its last day, in the meetings folder. */
	private async createChatNote(c: ChatImport): Promise<TFile> {
		const date = c.end ?? stamp("YYYY-MM-DD");
		await this.ensureFolder(this.settings.meetingsFolder);
		const p = this.uniquePath(this.settings.meetingsFolder, safeFileName(`${date} – ${c.title}`), "md");
		const body = [`# ${fileBase(p)}`, "", "## My notes", "- ", "", renderTranscript(c.transcript, null, c.meta, undefined, "Chat"), ""].join("\n");
		const note = await this.app.vault.create(p, body);
		const withTime = await this.createdHasTime();
		await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
			fm.tags = ["chat"];
			fm.created = withTime ? stamp("YYYY-MM-DDTHH:mm") : stamp("YYYY-MM-DD");
			fm.chat = c.source;
			if (c.start) fm.chat_start = c.start;
			if (c.end) fm.chat_end = c.end;
			fm.people = c.people;
		});
		return note;
	}

	/**
	 * Transcribe `audio` (a vault path, or an absolute path when `external`) into the note,
	 * then run the AI if enabled.
	 */
	async transcribe(note: TFile, audio: string, audioLink: string, external = false) {
		if (this.jobs.has(note)) {
			new Notice("This note is already being processed.");
			return;
		}
		const ctrl = new AbortController();
		this.jobs.set(note, ctrl);
		const progress = new Progress("🎙️ Preparing transcription…");
		this.showBusy("Transcribing…", "🎙️");
		const started = Date.now();
		try {
			const s = this.settings;
			const people = this.knownPeople();
			const prompt = [s.whisperPrompt, people.join(", ")].filter(Boolean).join(", ");
			const speakers = this.speakerConfig();
			const res = await transcribeFile(
				external ? audio : this.absPath(audio),
				{ ...s, prompt },
				(pct, stage) => {
					progress.set(`🎙️ ${stage}… ${pct}%  (${formatClock(Date.now() - started)})`);
					this.showBusy(`${stage} ${pct}%`, `🎙️ ${pct}%`);
				},
				ctrl.signal,
				speakers ?? undefined,
			);
			let session: string | undefined;
			if (res.speakers) {
				session = newSessionId();
				saveSession(session, { speakers: res.speakers });
			}
			const speakerCount = res.speakers ? Object.keys(res.speakers).length : 0;
			const meta = [
				formatClock(res.durationSec * 1000),
				res.language,
				speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? "s" : ""}` : "",
				path.basename(s.modelPath).replace(/^ggml-|\.bin$/g, ""),
			]
				.filter(Boolean)
				.join(" · ");
			await this.app.vault.process(note, (c) => upsertBlock(c, TX_START, TX_END, renderTranscript(res.text, audioLink, meta, session), "end"));
			if (this.live?.note === note) this.clearLive();
			let msg = `✅ Transcribed ${formatClock(res.durationSec * 1000)} of audio in ${formatClock(Date.now() - started)}.`;
			if (speakerCount) {
				const unknown = speakerCount - (res.recognised?.length ?? 0);
				msg += `\n👥 ${speakerCount} speaker${speakerCount === 1 ? "" : "s"}` + (res.recognised?.length ? `, recognised: ${res.recognised.join(", ")}` : "");
				if (unknown) {
					const who = unknown === speakerCount ? "them" : `the other ${unknown}`;
					msg += `.\nRun "Name the speakers in this note" to name ${who}.`;
				}
			} else if (res.speakerError) {
				msg += `\n⚠️ Couldn't separate speakers: ${res.speakerError}`;
			}
			progress.done(msg, 10000);
		} catch (e) {
			progress.done("❌ Transcription failed: " + (e as Error).message, 15000);
			return;
		} finally {
			this.jobs.delete(note);
			this.updateStatus();
		}
		if (this.settings.autoProcess) await this.processNote(note);
	}

	// ---------- AI ----------

	async processNote(note: TFile) {
		const apiKey = this.getApiKey(); // may be empty for local servers (Ollama, LM Studio)
		const provider = PROVIDERS[this.settings.provider] ?? PROVIDERS.custom;
		if (!this.settings.model || (provider.editableUrl && !this.settings.baseUrl)) {
			new Notice("Pick an AI provider and model in Settings → Take Note first (Load models lists them).", 10000);
			return;
		}
		if (provider.needsKey && !apiKey) {
			new Notice(`Add your ${provider.name} API key in Settings → Take Note first.`, 10000);
			return;
		}
		if (this.jobs.has(note)) {
			new Notice("This note is already being processed.");
			return;
		}
		const content = await this.app.vault.read(note);
		const { notes, transcript } = collectSources(content);
		if (!notes.replace(/^[-*\s]*$/gm, "").trim() && !transcript) {
			new Notice("Nothing to analyse yet — write some notes, paste a transcript, or record audio.");
			return;
		}

		const chat = this.isChatNote(note);
		const ctrl = new AbortController();
		this.jobs.set(note, ctrl);
		const s = this.settings;
		const progress = new Progress("🧠 Sending to " + s.model + "…");
		this.showBusy("Thinking…", "🧠 AI…");
		const started = Date.now();
		try {
			const result: MeetingNotes = await extractMeeting(
				(messages, label) =>
					providerChat({ provider: s.provider, baseUrl: s.baseUrl, apiKey, model: s.model }, messages, {
						signal: ctrl.signal,
						onProgress: (p) => {
							const what = p.contentChars ? `writing (${p.contentChars} chars)` : `thinking (${p.reasoningChars} chars)`;
							progress.set(`🧠 ${label}… ${what}  ${formatClock(Date.now() - started)}`);
							this.showBusy(p.contentChars ? "Writing notes…" : "Thinking…", "🧠 AI…");
						},
					}),
				{
					notes,
					transcript,
					date: this.noteDate(note),
					myName: s.myName || "me",
					outputLanguage: s.outputLanguage,
					knownPeople: this.knownPeople(),
					extraInstructions: s.extraInstructions,
					kind: chat ? "chat" : "meeting",
				},
				s.maxInputTokens,
			);

			const md = renderMeeting(result, {
				linkPeople: s.linkPeople,
				tasksEmoji: s.tasksEmoji,
				generatedAt: stamp("YYYY-MM-DD HH:mm"),
				model: s.model,
			});
			await this.app.vault.process(note, (c) => upsertBlock(c, AI_START, AI_END, md, "afterTitle"));
			const withTime = await this.createdHasTime();
			await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				const tags = new Set<string>(asList(fm.tags));
				tags.add(chat ? "chat" : "meeting");
				fm.tags = [...tags];
				fm.created = createdValue(fm.created, { withTime, content, fileCreated: note.stat.ctime, fallbackDate: this.noteDate(note) });
				const people = new Set<string>(asList(fm.people));
				result.attendees.filter((a) => !/^(speaker \d+|unknown)$/i.test(a)).forEach((a) => people.add(a));
				fm.people = [...people];
			});
			await this.maybeRename(note, result.title);
			if (s.updatePeopleNotes) await this.updatePeopleNotes(note, result);

			const counts = [
				[result.action_items.length, "action items"],
				[result.tickets.length, "tickets"],
				[result.questions.length, "questions"],
				[result.ai_assignments.length, "AI assignments"],
			]
				.filter(([n]) => n)
				.map(([n, l]) => `${n} ${l}`)
				.join(", ");
			progress.done(`✅ ${chat ? "Chat" : "Meeting"} processed in ${formatClock(Date.now() - started)}${counts ? ": " + counts : ""}.`, 8000);
		} catch (e) {
			progress.done("❌ AI step failed: " + (e as Error).message, 15000);
		} finally {
			this.jobs.delete(note);
			this.updateStatus();
		}
	}

	private async maybeRename(note: TFile, title: string) {
		if (!this.settings.renameFromTitle || !title || !DEFAULT_NAME.test(note.basename)) return;
		const date = note.basename.slice(0, 10);
		const oldBase = note.basename;
		const folder = note.parent?.path === "/" ? "" : note.parent?.path ?? "";
		const target = this.uniquePath(folder, safeFileName(`${date} – ${title}`), "md");
		await this.app.fileManager.renameFile(note, target);
		// Keep the H1 in sync with the file name.
		await this.app.vault.process(note, (c) => c.replace(new RegExp(`^# ${oldBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"), `# ${note.basename}`));
	}
}
