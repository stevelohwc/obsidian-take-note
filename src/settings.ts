import { App, Notice, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from "obsidian";
import type TakeNote from "./main.ts";
import { PROVIDERS, type ProviderId, providerModels } from "./providers.ts";
import { listInputDevices } from "./recorder.ts";
import { checkWhisperSetup } from "./transcribe.ts";
import { findNode, forgetVoice, loadVoices, speakerSetupProblems } from "./voices.ts";

export interface TakeNoteSettings {
	// LLM
	provider: ProviderId;
	baseUrl: string;
	apiKeySecret: string; // id in Obsidian's keychain-backed secret storage
	model: string;
	maxInputTokens: number;
	outputLanguage: string;
	myName: string;
	extraInstructions: string;
	/** Settings of providers you switched away from, restored when you switch back. */
	providerMemory: Partial<Record<ProviderId, { baseUrl: string; model: string; apiKeySecret: string }>>;
	// Floating button
	showFloatingButton: boolean;
	floatingButtonPos: { right: number; bottom: number } | null;
	/** Put the Take Note panel in the right sidebar whenever Obsidian starts or the plugin loads. */
	showSidebar: boolean;
	// Notes
	meetingsFolder: string;
	peopleFolder: string;
	linkPeople: boolean;
	tasksEmoji: boolean;
	renameFromTitle: boolean;
	updatePeopleNotes: boolean;
	createPeopleNotes: boolean;
	// Speakers
	speakersEnabled: boolean;
	nodePath: string;
	numSpeakers: number;
	clusterThreshold: number;
	mergeThreshold: number;
	matchThreshold: number;
	// Recording / transcription
	micDeviceId: string;
	/** Recordings stopped before this many seconds are treated as accidental and discarded. 0 = keep all. */
	minRecordingSeconds: number;
	autoTranscribe: boolean;
	autoProcess: boolean;
	ffmpegPath: string;
	whisperPath: string;
	modelPath: string;
	vadModelPath: string;
	language: string;
	whisperPrompt: string;
	timestamps: boolean;
}

export const DEFAULT_SETTINGS: TakeNoteSettings = {
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	apiKeySecret: "",
	model: "",
	maxInputTokens: 50000,
	outputLanguage: "English",
	myName: "",
	extraInstructions: "",
	providerMemory: {},
	showFloatingButton: true,
	floatingButtonPos: null,
	showSidebar: true,
	meetingsFolder: "Meetings",
	peopleFolder: "People",
	linkPeople: true,
	tasksEmoji: true,
	renameFromTitle: true,
	updatePeopleNotes: false,
	createPeopleNotes: false,
	speakersEnabled: true,
	nodePath: "",
	numSpeakers: 0,
	clusterThreshold: 0.7,
	mergeThreshold: 0.75,
	matchThreshold: 0.6,
	micDeviceId: "",
	minRecordingSeconds: 20,
	autoTranscribe: true,
	autoProcess: true,
	ffmpegPath: "/opt/homebrew/bin/ffmpeg",
	whisperPath: "/opt/homebrew/bin/whisper-cli",
	modelPath: "~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin",
	vadModelPath: "",
	language: "auto",
	whisperPrompt: "",
	timestamps: true,
};

/** Run an async handler from a callback that expects nothing back; errors go to the console. */
function later<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => void {
	return (...args) => {
		fn(...args).catch((e) => console.error("Take Note:", e));
	};
}

/** One settings row: its name and description (also what settings search indexes) and its controls. */
interface Row {
	name: string;
	desc?: string | DocumentFragment;
	aliases?: string[];
	/** Adds the controls. May return the Setting (it chains); the value is ignored. */
	render: (setting: Setting) => unknown;
}

interface Section {
	heading: string;
	rows: Row[];
}

export class TakeNoteSettingTab extends PluginSettingTab {
	private models: string[] = [];

	constructor(
		app: App,
		private plugin: TakeNote,
	) {
		super(app, plugin);
	}

	/** Rendered by Obsidian and indexed by its settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((section) => ({
			type: "group",
			heading: section.heading,
			items: section.rows.map((row) => ({
				name: row.name,
				desc: row.desc,
				aliases: row.aliases,
				render: (setting: Setting) => this.renderRow(setting, row),
			})),
		}));
	}

	private renderRow(setting: Setting, row: Row): void {
		setting.setName(row.name);
		if (row.desc !== undefined) setting.setDesc(row.desc);
		row.render(setting);
	}

	/** Rebuild after a change that adds or removes rows (provider switch, forgotten voice). */
	private redraw(): void {
		this.update();
	}

	private sections(): Section[] {
		return [this.llmSection(), this.notesSection(), this.speakersSection(), this.recordingSection()];
	}

	private save(): Promise<void> {
		return this.plugin.saveSettings();
	}

	private llmSection(): Section {
		const s = this.plugin.settings;
		const provider = PROVIDERS[s.provider] ?? PROVIDERS.custom;
		const rows: Row[] = [
			{
				name: "Provider",
				desc: provider.hint,
				aliases: Object.values(PROVIDERS).map((p) => p.name),
				render: (setting) =>
					setting.addDropdown((d) => {
						for (const p of Object.values(PROVIDERS)) d.addOption(p.id, p.name);
						d.setValue(provider.id).onChange(later(async (v) => {
							this.plugin.switchProvider(v as ProviderId);
							await this.save();
							this.redraw();
						}));
					}),
			},
		];

		if (provider.editableUrl) {
			rows.push({
				name: "API base URL",
				desc: provider.id === "custom" ? "The endpoint's /v1 URL, e.g. https://llm.example.com/v1" : `Default: ${provider.baseUrl}`,
				render: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder(provider.baseUrl || "https://llm.example.com/v1")
							.setValue(s.baseUrl)
							.onChange(later(async (v) => {
								s.baseUrl = v.trim();
								await this.save();
							})),
					),
			});
		}

		if (provider.needsKey || provider.id === "custom") {
			rows.push({
				name: "API key",
				desc: createFragment((f) => {
					if (provider.keyUrl) {
						f.createEl("a", { text: `Get a ${provider.name} key`, href: provider.keyUrl });
						f.appendText(". ");
					} else {
						f.appendText("Leave empty if your server doesn't need one. ");
					}
					f.appendText("Stored in your system keychain, not in the vault, so it never syncs or gets committed.");
				}),
				render: (setting) =>
					setting.addComponent((el) =>
						new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(later(async (v) => {
							s.apiKeySecret = v ?? "";
							await this.save();
						})),
					),
			});
		}

		rows.push(
			{
				name: "Model",
				desc: "Click Load models to see what your provider offers, then pick one. Larger models write better notes; long meetings need a large context window.",
				render: (setting) => {
					const modelList = setting.controlEl.createEl("datalist", { attr: { id: "take-note-models" } });
					const fillModels = (ids: string[]) => {
						modelList.empty();
						ids.forEach((id) => modelList.createEl("option", { attr: { value: id } }));
					};
					fillModels(this.models);
					setting
						.addText((t) => {
							t.setPlaceholder(provider.defaultModel || "Pick after loading models")
								.setValue(s.model)
								.onChange(later(async (v) => {
									s.model = v.trim();
									await this.save();
								}));
							t.inputEl.setAttr("list", "take-note-models");
						})
						.addButton((b) =>
							b.setButtonText("Load models").onClick(later(async () => {
								b.setDisabled(true).setButtonText("Loading…");
								try {
									this.models = await providerModels({ provider: s.provider, baseUrl: s.baseUrl, apiKey: this.plugin.getApiKey() });
									fillModels(this.models);
									const status = !s.model ? "Now pick one in the Model box." : this.models.includes(s.model) ? `✅ ${s.model} is available.` : `⚠️ ${s.model} is not in the list.`;
									new Notice(`Connected to ${provider.name}: ${this.models.length} models.\n${status}`, 8000);
								} catch (e) {
									new Notice("❌ " + (e as Error).message, 10000);
								} finally {
									b.setDisabled(false).setButtonText("Load models");
								}
							})),
						);
				},
			},
			{
				name: "Your name",
				desc: "So \"I will…\" in your notes becomes an action item owned by you.",
				render: (setting) =>
					setting.addText((t) =>
						t.setValue(s.myName).onChange(later(async (v) => {
							s.myName = v.trim();
							await this.save();
						})),
					),
			},
			{
				name: "Output language",
				render: (setting) =>
					setting.addDropdown((d) =>
						d
							.addOptions({ English: "English", "same as the meeting": "Same as the meeting", "Simplified Chinese": "简体中文", Malay: "Bahasa Melayu" })
							.setValue(s.outputLanguage)
							.onChange(later(async (v) => {
								s.outputLanguage = v;
								await this.save();
							})),
					),
			},
			{
				name: "Max input tokens per request",
				desc: "Longer transcripts are split into parts and merged. Keep this well under your model's context window.",
				render: (setting) =>
					setting.addText((t) =>
						t.setValue(String(s.maxInputTokens)).onChange(later(async (v) => {
							const n = parseInt(v, 10);
							if (n > 1000) {
								s.maxInputTokens = n;
								await this.save();
							}
						})),
					),
			},
			{
				name: "Extra instructions",
				desc: "Team context the AI should know: project names, who is who, ticket conventions.",
				render: (setting) =>
					setting.addTextArea((t) => {
						t.setPlaceholder("e.g. AK = Alice Kim (dev lead). Acme Bank is our client. Tickets go to the WEB project.")
							.setValue(s.extraInstructions)
							.onChange(later(async (v) => {
								s.extraInstructions = v;
								await this.save();
							}));
						t.inputEl.rows = 4;
						t.inputEl.addClass("take-note-wide");
					}),
			},
		);
		return { heading: "LLM", rows };
	}

	private notesSection(): Section {
		const s = this.plugin.settings;
		const toggle = (name: string, desc: string | undefined, key: "linkPeople" | "tasksEmoji" | "renameFromTitle" | "updatePeopleNotes" | "createPeopleNotes"): Row => ({
			name,
			desc,
			render: (setting) =>
				setting.addToggle((t) =>
					t.setValue(s[key]).onChange(later(async (v) => {
						s[key] = v;
						await this.save();
					})),
				),
		});
		const folder = (name: string, desc: string, key: "meetingsFolder" | "peopleFolder"): Row => ({
			name,
			desc,
			render: (setting) =>
				setting.addText((t) =>
					t.setValue(s[key]).onChange(later(async (v) => {
						s[key] = v.trim().replace(/^\/+|\/+$/g, "");
						await this.save();
					})),
				),
		});
		return {
			heading: "Notes",
			rows: [
				{
					name: "Sidebar",
					desc: "Keep the Take Note panel (summary, transcript, your notes) in the right sidebar.",
					render: (setting) =>
						setting.addToggle((t) =>
							t.setValue(s.showSidebar).onChange(later(async (v) => {
								s.showSidebar = v;
								await this.save();
								if (v) await this.plugin.openSidebar(true);
								else this.plugin.closeSidebar();
							})),
						),
				},
				{
					name: "Floating mic button",
					desc: "A mic button over your notes: click to start or stop recording, right-click for more. Drag it anywhere.",
					render: (setting) =>
						setting
							.addToggle((t) =>
								t.setValue(s.showFloatingButton).onChange(later(async (v) => {
									s.showFloatingButton = v;
									await this.save();
									this.plugin.refreshFloatingButton();
								})),
							)
							.addExtraButton((b) =>
								b
									.setIcon("rotate-ccw")
									.setTooltip("Move it back to the corner")
									.onClick(later(async () => {
										s.floatingButtonPos = null;
										await this.save();
										this.plugin.refreshFloatingButton();
									})),
							),
				},
				folder("Meetings folder", "Where new meeting notes are created.", "meetingsFolder"),
				folder("People folder", "If it exists, names in it are given to Whisper and the AI so people are spelled and linked consistently.", "peopleFolder"),
				toggle("Link people as [[wikilinks]]", undefined, "linkPeople"),
				toggle("Tasks plugin format", "Add 📅 due dates and ⏫ priorities to action items so the Tasks plugin can query them.", "tasksEmoji"),
				toggle("Rename note from AI title", "Turns \"2026-11-19 – Meeting 1530\" into \"2026-11-19 – Bot Flow Review\". Only renames notes that still have the default name.", "renameFromTitle"),
				toggle("Update People notes", "After each meeting, add a line to each speaker's note in the People folder, e.g. \"- [[2026-11-19 – Bot Flow Review]] — reported the release is ready\". Re-running replaces that line.", "updatePeopleNotes"),
				toggle("Create missing People notes", "Also create a People note for named speakers who don't have one yet. Unrecognised \"Speaker N\" voices are never created.", "createPeopleNotes"),
			],
		};
	}

	private speakersSection(): Section {
		const s = this.plugin.settings;
		const voices = Object.keys(loadVoices()).sort();
		const slider = (name: string, desc: string, key: "matchThreshold" | "clusterThreshold", min: number, max: number): Row => ({
			name,
			desc,
			render: (setting) =>
				setting.addSlider((sl) =>
					sl
						.setLimits(min, max, 0.05)
						.setValue(s[key])
						.onChange(later(async (v) => {
							s[key] = v;
							await this.save();
						})),
				),
		});
		return {
			heading: "Speakers",
			rows: [
				{
					name: "Tell speakers apart",
					desc: "Label who said what in the transcript, and recognise saved voices by name. Runs locally.",
					aliases: ["diarization", "speaker separation"],
					render: (setting) =>
						setting.addToggle((t) =>
							t.setValue(s.speakersEnabled).onChange(later(async (v) => {
								s.speakersEnabled = v;
								await this.save();
							})),
						),
				},
				{
					name: "Number of speakers",
					desc: "0 = detect automatically. Set it if you know, e.g. 4 for a 4-person meeting — this is the biggest accuracy boost.",
					render: (setting) =>
						setting.addText((t) =>
							t.setValue(String(s.numSpeakers)).onChange(later(async (v) => {
								const n = parseInt(v, 10);
								if (n >= 0 && n <= 20) {
									s.numSpeakers = n;
									await this.save();
								}
							})),
						),
				},
				slider("Voice match strictness", "How similar a voice must be to a saved voice to be named automatically (0.4 loose – 0.8 strict). Lower it if known people show up as \"Speaker N\"; raise it if people get mixed up.", "matchThreshold", 0.3, 0.9),
				slider("Separation sensitivity", "Higher merges voices more readily (fewer speakers). Raise it if one person is split into several speakers; lower it if two people are merged.", "clusterThreshold", 0.4, 0.95),
				{
					name: "Node.js path",
					desc: `Used to run speaker separation. Leave empty to auto-detect (found: ${findNode("") ?? "none"}).`,
					render: (setting) =>
						setting.addText((t) =>
							t.setValue(s.nodePath).onChange(later(async (v) => {
								s.nodePath = v.trim();
								await this.save();
							})),
						),
				},
				{
					name: "Saved voices",
					desc: voices.length
						? `${voices.join(", ")}. Stored only on this Mac in ~/.take-note/voices.json.`
						: "None yet. Use \"Record a voice sample\" or \"Name the speakers in this note\" to add people.",
					aliases: ["forget a voice", "check speaker setup"],
					render: (setting) => {
						setting.addButton((b) =>
							b.setButtonText("Check speaker setup").onClick(() => {
								const problems = speakerSetupProblems(findNode(s.nodePath));
								new Notice(problems.length ? "❌ " + problems.join("\n") : "✅ Speaker separation is ready.", 8000);
							}),
						);
						if (!voices.length) return;
						setting.addDropdown((d) => {
							d.addOption("", "Forget a voice…");
							for (const v of voices) d.addOption(v, v);
							d.onChange((name) => {
								if (!name) return;
								forgetVoice(name);
								new Notice(`Forgot ${name}'s voice.`);
								this.redraw();
							});
						});
					},
				},
			],
		};
	}

	private recordingSection(): Section {
		const s = this.plugin.settings;
		const toggle = (name: string, key: "autoTranscribe" | "autoProcess" | "timestamps"): Row => ({
			name,
			render: (setting) =>
				setting.addToggle((t) =>
					t.setValue(s[key]).onChange(later(async (v) => {
						s[key] = v;
						await this.save();
					})),
				),
		});
		const path = (name: string, desc: string | undefined, key: "ffmpegPath" | "whisperPath" | "modelPath" | "vadModelPath"): Row => ({
			name,
			desc,
			render: (setting) =>
				setting.addText((t) =>
					t.setValue(s[key]).onChange(later(async (v) => {
						s[key] = v.trim();
						await this.save();
					})),
				),
		});
		return {
			heading: "Recording & transcription",
			rows: [
				{
					name: "Microphone",
					desc: "For Zoom/Teams with headphones, pick an aggregate device (e.g. BlackHole + mic) to capture both sides.",
					aliases: ["input device"],
					render: (setting) =>
						setting.addDropdown(later(async (d) => {
							d.addOption("", "System default");
							for (const dev of await listInputDevices()) {
								d.addOption(dev.deviceId, dev.label || `Input ${dev.deviceId.slice(0, 6)}`);
							}
							d.setValue(s.micDeviceId).onChange(async (v) => {
								s.micDeviceId = v;
								await this.save();
							});
						})),
				},
				{
					name: "Discard short recordings",
					desc: "Seconds. A recording stopped sooner than this is treated as an accidental tap: the audio goes to the trash, nothing is transcribed, and a new meeting note you didn't type in is removed. 0 keeps every recording.",
					render: (setting) =>
						setting.addText((t) =>
							t.setValue(String(s.minRecordingSeconds)).onChange(later(async (v) => {
								const n = parseInt(v, 10);
								if (n >= 0 && n <= 600) {
									s.minRecordingSeconds = n;
									await this.save();
								}
							})),
						),
				},
				toggle("Transcribe automatically when recording stops", "autoTranscribe"),
				toggle("Run AI automatically after transcription", "autoProcess"),
				{
					name: "Spoken language",
					desc: "\"auto\" detects from the first 30 seconds. Set it explicitly if detection guesses wrong.",
					render: (setting) =>
						setting.addDropdown((d) =>
							d
								.addOptions({ auto: "Auto-detect", en: "English", ms: "Malay", zh: "Chinese", id: "Indonesian", ja: "Japanese", ko: "Korean" })
								.setValue(s.language)
								.onChange(later(async (v) => {
									s.language = v;
									await this.save();
								})),
						),
				},
				{
					name: "Vocabulary hint",
					desc: "Names, products and jargon Whisper should recognise (comma separated). People-folder names are added automatically.",
					render: (setting) =>
						setting.addTextArea((t) => {
							t.setPlaceholder("Kubernetes, Grafana, Acme Bank, onboarding flow")
								.setValue(s.whisperPrompt)
								.onChange(later(async (v) => {
									s.whisperPrompt = v;
									await this.save();
								}));
							t.inputEl.rows = 2;
							t.inputEl.addClass("take-note-wide");
						}),
				},
				toggle("Timestamps in transcript", "timestamps"),
				path("ffmpeg path", undefined, "ffmpegPath"),
				path("whisper-cli path", undefined, "whisperPath"),
				path("Whisper model", "ggml model file. large-v3-turbo-q5_0 is a good speed/quality balance.", "modelPath"),
				path("VAD model (optional)", "Silero VAD ggml model; skips silence and reduces hallucinated text.", "vadModelPath"),
				{
					name: "Check Whisper setup",
					desc: "Confirms ffmpeg, whisper-cli and the Whisper model are found.",
					render: (setting) =>
						setting.addButton((b) =>
							b.setButtonText("Check").onClick(() => {
								const problems = checkWhisperSetup({ ...s, prompt: "" });
								new Notice(problems.length ? "❌ " + problems.join("\n") : "✅ ffmpeg, whisper-cli and model found.", 8000);
							}),
						),
				},
			],
		};
	}
}
