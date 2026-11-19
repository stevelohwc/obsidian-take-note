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
	moment,
} from "obsidian";
import * as path from "path";
import { DEFAULT_SETTINGS, TakeNoteSettingTab, TakeNoteSettings } from "./settings.ts";
import { MeetingRecorder } from "./recorder.ts";
import { type SpeakerConfig, embedWav, toWav, transcribeFile } from "./transcribe.ts";
import HELPER_SOURCE from "../helper/speakers.cjs";
import { addVoice, findNode, loadSession, loadVoices, newSessionId, saveSession, speakerSetupProblems } from "./voices.ts";
import { renameSpeaker, transcriptSpeakers } from "./speakers.ts";
import { NameSpeakersModal, VoiceSampleModal } from "./modals.ts";
import * as fs from "fs";
import * as os from "os";
import { PROVIDERS, type ProviderId, inferProvider, providerChat } from "./providers.ts";
import { FloatingButton } from "./fab.ts";
import { MASCOT_ICON, type Mood, registerMascotIcons } from "./mascot.ts";
import { TakeNoteView, VIEW_TYPE } from "./view.ts";
import { extractMeeting, type MeetingNotes } from "./extract.ts";
import {
	AI_END,
	AI_START,
	TX_END,
	TX_START,
	collectSources,
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
	private recording: { note: TFile; audioPath: string } | null = null;
	private statusEl!: HTMLElement;
	private jobs = new Map<TFile, AbortController>(); // note -> running job (the TFile survives renames; its path does not)
	private fab: FloatingButton | null = null;
	private busyText = "Working…";

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
		this.addRibbonIcon(MASCOT_ICON.idle, "Take Note: start / stop recording", () => this.toggleRecording());
		this.registerView(VIEW_TYPE, (leaf) => new TakeNoteView(leaf, this));
		this.app.workspace.onLayoutReady(() => {
			this.refreshFloatingButton();
			if (!this.settings.sidebarAdded) {
				this.settings.sidebarAdded = true;
				void this.saveSettings();
				void this.openSidebar(false);
			}
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
					if (this.recorder.isPaused) this.recorder.resume();
					else this.recorder.pause();
					this.updateStatus();
				}
				return true;
			},
		});
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
		this.addCommand({
			id: "cancel",
			name: "Cancel running transcription / AI job",
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

	onunload() {
		this.fab?.destroy();
		this.jobs.forEach((c) => c.abort());
		// Flush audio so nothing is lost (best effort).
		if (this.recording) this.recorder.stop().catch(() => {});
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<TakeNoteSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// Settings from before providers existed: work out which one the URL points at.
		if (saved && !saved.provider) this.settings.provider = inferProvider(this.settings.baseUrl);
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
		if (!this.settings.showFloatingButton) {
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
		});
		this.updateStatus();
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
		else this.recorder.pause();
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
		return asList(fm?.tags).some((t) => t === "meeting") || f.path.startsWith(this.settings.meetingsFolder + "/");
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
		const raw: unknown = fm?.created ?? fm?.date;
		const fromFm = (typeof raw === "string" ? raw : "").match(/\d{4}-\d{2}-\d{2}/);
		if (fromFm) return fromFm[0];
		const fromName = f.basename.match(/\d{4}-\d{2}-\d{2}/);
		return fromName ? fromName[0] : moment().format("YYYY-MM-DD");
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

	async createMeetingNote(title?: string): Promise<TFile> {
		const date = moment().format("YYYY-MM-DD");
		const base = safeFileName(`${date} – ${title ?? "Meeting " + moment().format("HHmm")}`);
		await this.ensureFolder(this.settings.meetingsFolder);
		const p = this.uniquePath(this.settings.meetingsFolder, base, "md");
		const content = [
			"---",
			"tags:",
			"  - meeting",
			`created: ${date}`,
			"people: []",
			"---",
			`# ${path.basename(p, ".md")}`,
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
		try {
			if (!note) {
				note = await this.createMeetingNote();
				await this.openNote(note);
			}
			const name = `${moment().format("YYYY-MM-DD HHmm")} recording.${this.recorder.ext}`;
			const audioPath = await this.app.fileManager.getAvailablePathForAttachment(name, note.path);
			await this.ensureFolder(path.posix.dirname(audioPath));
			await this.recorder.start(this.absPath(audioPath), this.settings.micDeviceId || undefined);
			this.recording = { note, audioPath };
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
		this.updateStatus();
		const audio = await this.waitForFile(rec.audioPath);
		const link = audio ? "!" + this.app.fileManager.generateMarkdownLink(audio, rec.note.path) : `![[${path.basename(rec.audioPath)}]]`;
		// Link the audio right away so it is never orphaned, even if transcription is skipped.
		await this.app.vault.process(rec.note, (c) =>
			upsertBlock(c, TX_START, TX_END, renderTranscript("(not transcribed yet — run \"Transcribe audio embedded in the current note\")", link, "pending"), "end"),
		);
		new Notice(`Recording saved (${formatClock(ms)}).`);
		if (this.settings.autoTranscribe) await this.transcribe(rec.note, rec.audioPath, link);
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
				const electron = require("electron") as { webUtils?: { getPathForFile?: (f: File) => string } };
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
			let msg = `✅ Transcribed ${formatClock(res.durationSec * 1000)} of audio in ${formatClock(Date.now() - started)}.`;
			if (speakerCount) {
				const unknown = speakerCount - (res.recognised?.length ?? 0);
				msg += `\n👥 ${speakerCount} speakers` + (res.recognised?.length ? `, recognised: ${res.recognised.join(", ")}` : "");
				if (unknown) msg += `.\nRun "Name the speakers in this note" to name the other ${unknown}.`;
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
				},
				s.maxInputTokens,
			);

			const md = renderMeeting(result, {
				linkPeople: s.linkPeople,
				tasksEmoji: s.tasksEmoji,
				generatedAt: moment().format("YYYY-MM-DD HH:mm"),
				model: s.model,
			});
			await this.app.vault.process(note, (c) => upsertBlock(c, AI_START, AI_END, md, "afterTitle"));
			await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				const tags = new Set<string>(asList(fm.tags));
				tags.add("meeting");
				fm.tags = [...tags];
				if (!fm.created) fm.created = this.noteDate(note);
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
			progress.done(`✅ Meeting processed in ${formatClock(Date.now() - started)}${counts ? ": " + counts : ""}.`, 8000);
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
