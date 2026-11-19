import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
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

export class TakeNoteSettingTab extends PluginSettingTab {
	private models: string[] = [];

	constructor(app: App, private plugin: TakeNote) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("LLM").setHeading();

		const provider = PROVIDERS[s.provider] ?? PROVIDERS.custom;
		new Setting(containerEl)
			.setName("Provider")
			.setDesc(provider.hint)
			.addDropdown((d) => {
				for (const p of Object.values(PROVIDERS)) d.addOption(p.id, p.name);
				d.setValue(provider.id).onChange(async (v) => {
					this.plugin.switchProvider(v as ProviderId);
					await save();
					this.display();
				});
			});

		if (provider.editableUrl) {
			new Setting(containerEl)
				.setName("API base URL")
				.setDesc(provider.id === "custom" ? "The endpoint's /v1 URL, e.g. https://llm.example.com/v1" : `Default: ${provider.baseUrl}`)
				.addText((t) =>
					t
						.setPlaceholder(provider.baseUrl || "https://llm.example.com/v1")
						.setValue(s.baseUrl)
						.onChange(async (v) => {
							s.baseUrl = v.trim();
							await save();
						}),
				);
		}

		if (provider.needsKey || provider.id === "custom") {
			new Setting(containerEl)
				.setName("API key")
				.setDesc(
					createFragment((f) => {
						if (provider.keyUrl) {
							f.createEl("a", { text: `Get a ${provider.name} key`, href: provider.keyUrl });
							f.appendText(". ");
						} else {
							f.appendText("Leave empty if your server doesn't need one. ");
						}
						f.appendText("Stored in your system keychain, not in the vault, so it never syncs or gets committed.");
					}),
				)
				.addComponent((el) =>
					new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (v) => {
						s.apiKeySecret = v ?? "";
						await save();
					}),
				);
		}

		const modelList = containerEl.createEl("datalist", { attr: { id: "take-note-models" } });
		const fillModels = (ids: string[]) => {
			modelList.empty();
			ids.forEach((id) => modelList.createEl("option", { attr: { value: id } }));
		};
		fillModels(this.models);
		new Setting(containerEl)
			.setName("Model")
			.setDesc("Click Load models to see what your provider offers, then pick one. Larger models write better notes; long meetings need a large context window.")
			.addText((t) => {
				t.setPlaceholder(provider.defaultModel || "Pick after loading models")
					.setValue(s.model)
					.onChange(async (v) => {
						s.model = v.trim();
						await save();
					});
				t.inputEl.setAttr("list", "take-note-models");
			})
			.addButton((b) =>
				b.setButtonText("Load models").onClick(async () => {
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
				}),
			);

		new Setting(containerEl)
			.setName("Your name")
			.setDesc("So \"I will…\" in your notes becomes an action item owned by you.")
			.addText((t) =>
				t.setValue(s.myName).onChange(async (v) => {
					s.myName = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Output language")
			.addDropdown((d) =>
				d
					.addOptions({ English: "English", "same as the meeting": "Same as the meeting", "Simplified Chinese": "简体中文", Malay: "Bahasa Melayu" })
					.setValue(s.outputLanguage)
					.onChange(async (v) => {
						s.outputLanguage = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Max input tokens per request")
			.setDesc("Longer transcripts are split into parts and merged. Keep this well under your model's context window.")
			.addText((t) =>
				t.setValue(String(s.maxInputTokens)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n > 1000) {
						s.maxInputTokens = n;
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Extra instructions")
			.setDesc("Team context the AI should know: project names, who is who, ticket conventions.")
			.addTextArea((t) => {
				t.setPlaceholder("e.g. AK = Alice Kim (dev lead). Acme Bank is our client. Tickets go to the WEB project.")
					.setValue(s.extraInstructions)
					.onChange(async (v) => {
						s.extraInstructions = v;
						await save();
					});
				t.inputEl.rows = 4;
				t.inputEl.addClass("take-note-wide");
			});

		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Sidebar")
			.setDesc("Keep the Take Note panel (summary, transcript, your notes) in the right sidebar.")
			.addToggle((t) =>
				t.setValue(s.showSidebar).onChange(async (v) => {
					s.showSidebar = v;
					await save();
					if (v) await this.plugin.openSidebar(true);
					else this.plugin.closeSidebar();
				}),
			);

		new Setting(containerEl)
			.setName("Floating mic button")
			.setDesc("A mic button over your notes: click to start or stop recording, right-click for more. Drag it anywhere.")
			.addToggle((t) =>
				t.setValue(s.showFloatingButton).onChange(async (v) => {
					s.showFloatingButton = v;
					await save();
					this.plugin.refreshFloatingButton();
				}),
			)
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Move it back to the corner")
					.onClick(async () => {
						s.floatingButtonPos = null;
						await save();
						this.plugin.refreshFloatingButton();
					}),
			);

		new Setting(containerEl)
			.setName("Meetings folder")
			.setDesc("Where new meeting notes are created.")
			.addText((t) =>
				t.setValue(s.meetingsFolder).onChange(async (v) => {
					s.meetingsFolder = v.trim().replace(/^\/+|\/+$/g, "");
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("People folder")
			.setDesc("If it exists, names in it are given to Whisper and the AI so people are spelled and linked consistently.")
			.addText((t) =>
				t.setValue(s.peopleFolder).onChange(async (v) => {
					s.peopleFolder = v.trim().replace(/^\/+|\/+$/g, "");
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Link people as [[wikilinks]]")
			.addToggle((t) =>
				t.setValue(s.linkPeople).onChange(async (v) => {
					s.linkPeople = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Tasks plugin format")
			.setDesc("Add 📅 due dates and ⏫ priorities to action items so the Tasks plugin can query them.")
			.addToggle((t) =>
				t.setValue(s.tasksEmoji).onChange(async (v) => {
					s.tasksEmoji = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Rename note from AI title")
			.setDesc("Turns \"2026-11-19 – Meeting 1530\" into \"2026-11-19 – Bot Flow Review\". Only renames notes that still have the default name.")
			.addToggle((t) =>
				t.setValue(s.renameFromTitle).onChange(async (v) => {
					s.renameFromTitle = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Update People notes")
			.setDesc("After each meeting, add a line to each speaker's note in the People folder, e.g. \"- [[2026-11-19 – Bot Flow Review]] — reported the release is ready\". Re-running replaces that line.")
			.addToggle((t) =>
				t.setValue(s.updatePeopleNotes).onChange(async (v) => {
					s.updatePeopleNotes = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Create missing People notes")
			.setDesc("Also create a People note for named speakers who don't have one yet. Unrecognised \"Speaker N\" voices are never created.")
			.addToggle((t) =>
				t.setValue(s.createPeopleNotes).onChange(async (v) => {
					s.createPeopleNotes = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Speakers").setHeading();

		new Setting(containerEl)
			.setName("Tell speakers apart")
			.setDesc("Label who said what in the transcript, and recognise saved voices by name. Runs locally.")
			.addToggle((t) =>
				t.setValue(s.speakersEnabled).onChange(async (v) => {
					s.speakersEnabled = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Number of speakers")
			.setDesc("0 = detect automatically. Set it if you know, e.g. 4 for a 4-person meeting — this is the biggest accuracy boost.")
			.addText((t) =>
				t.setValue(String(s.numSpeakers)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n >= 0 && n <= 20) {
						s.numSpeakers = n;
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Voice match strictness")
			.setDesc("How similar a voice must be to a saved voice to be named automatically (0.4 loose – 0.8 strict). Lower it if known people show up as \"Speaker N\"; raise it if people get mixed up.")
			.addSlider((sl) =>
				sl
					.setLimits(0.3, 0.9, 0.05)
					.setValue(s.matchThreshold)
					.onChange(async (v) => {
						s.matchThreshold = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Separation sensitivity")
			.setDesc("Higher merges voices more readily (fewer speakers). Raise it if one person is split into several speakers; lower it if two people are merged.")
			.addSlider((sl) =>
				sl
					.setLimits(0.4, 0.95, 0.05)
					.setValue(s.clusterThreshold)
					.onChange(async (v) => {
						s.clusterThreshold = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Node.js path")
			.setDesc(`Used to run speaker separation. Leave empty to auto-detect (found: ${findNode("") ?? "none"}).`)
			.addText((t) =>
				t.setValue(s.nodePath).onChange(async (v) => {
					s.nodePath = v.trim();
					await save();
				}),
			);

		const voices = Object.keys(loadVoices()).sort();
		const voicesSetting = new Setting(containerEl)
			.setName("Saved voices")
			.setDesc(
				voices.length
					? `${voices.join(", ")}. Stored only on this Mac in ~/.take-note/voices.json.`
					: "None yet. Use \"Record a voice sample\" or \"Name the speakers in this note\" to add people.",
			)
			.addButton((b) =>
				b.setButtonText("Check speaker setup").onClick(() => {
					const problems = speakerSetupProblems(findNode(s.nodePath));
					new Notice(problems.length ? "❌ " + problems.join("\n") : "✅ Speaker separation is ready.", 8000);
				}),
			);
		if (voices.length) {
			voicesSetting.addDropdown((d) => {
				d.addOption("", "Forget a voice…");
				voices.forEach((v) => d.addOption(v, v));
				d.onChange((name) => {
					if (!name) return;
					forgetVoice(name);
					new Notice(`Forgot ${name}'s voice.`);
					this.display();
				});
			});
		}

		new Setting(containerEl).setName("Recording & transcription").setHeading();

		const mic = new Setting(containerEl)
			.setName("Microphone")
			.setDesc("For Zoom/Teams with headphones, pick an aggregate device (e.g. BlackHole + mic) to capture both sides.");
		mic.addDropdown(async (d) => {
			d.addOption("", "System default");
			for (const dev of await listInputDevices()) {
				d.addOption(dev.deviceId, dev.label || `Input ${dev.deviceId.slice(0, 6)}`);
			}
			d.setValue(s.micDeviceId).onChange(async (v) => {
				s.micDeviceId = v;
				await save();
			});
		});

		new Setting(containerEl)
			.setName("Discard short recordings")
			.setDesc("Seconds. A recording stopped sooner than this is treated as an accidental tap: the audio goes to the trash, nothing is transcribed, and a new meeting note you didn't type in is removed. 0 keeps every recording.")
			.addText((t) =>
				t.setValue(String(s.minRecordingSeconds)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n >= 0 && n <= 600) {
						s.minRecordingSeconds = n;
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Transcribe automatically when recording stops")
			.addToggle((t) =>
				t.setValue(s.autoTranscribe).onChange(async (v) => {
					s.autoTranscribe = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Run AI automatically after transcription")
			.addToggle((t) =>
				t.setValue(s.autoProcess).onChange(async (v) => {
					s.autoProcess = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Spoken language")
			.setDesc("\"auto\" detects from the first 30 seconds. Set it explicitly if detection guesses wrong.")
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto-detect", en: "English", ms: "Malay", zh: "Chinese", id: "Indonesian", ja: "Japanese", ko: "Korean" })
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Vocabulary hint")
			.setDesc("Names, products and jargon Whisper should recognise (comma separated). People-folder names are added automatically.")
			.addTextArea((t) => {
				t.setPlaceholder("Kubernetes, Grafana, Acme Bank, onboarding flow")
					.setValue(s.whisperPrompt)
					.onChange(async (v) => {
						s.whisperPrompt = v;
						await save();
					});
				t.inputEl.rows = 2;
				t.inputEl.addClass("take-note-wide");
			});

		new Setting(containerEl)
			.setName("Timestamps in transcript")
			.addToggle((t) =>
				t.setValue(s.timestamps).onChange(async (v) => {
					s.timestamps = v;
					await save();
				}),
			);

		const paths: ["ffmpegPath" | "whisperPath" | "modelPath" | "vadModelPath", string, string][] = [
			["ffmpegPath", "ffmpeg path", ""],
			["whisperPath", "whisper-cli path", ""],
			["modelPath", "Whisper model", "ggml model file. large-v3-turbo-q5_0 is a good speed/quality balance."],
			["vadModelPath", "VAD model (optional)", "Silero VAD ggml model; skips silence and reduces hallucinated text."],
		];
		for (const [key, name, desc] of paths) {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v.trim();
						await save();
					}),
				);
		}

		new Setting(containerEl).addButton((b) =>
			b.setButtonText("Check Whisper setup").onClick(() => {
				const problems = checkWhisperSetup({ ...s, prompt: "" });
				new Notice(problems.length ? "❌ " + problems.join("\n") : "✅ ffmpeg, whisper-cli and model found.", 8000);
			}),
		);
	}
}
