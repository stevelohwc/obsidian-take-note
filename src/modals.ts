import { App, Modal, Notice, Setting } from "obsidian";
import * as os from "os";
import * as path from "path";
import { MeetingRecorder } from "./recorder.ts";
import { formatClock, safeFileName } from "./render.ts";

function peopleDatalist(container: HTMLElement, people: string[]): string {
	const id = "mc-people-" + Math.random().toString(36).slice(2);
	const list = container.createEl("datalist", { attr: { id } });
	people.forEach((p) => list.createEl("option", { attr: { value: p } }));
	return id;
}

/** Shows each speaker with sample lines; the user types who it is. */
export class NameSpeakersModal extends Modal {
	private values = new Map<string, string>();

	constructor(
		app: App,
		private speakers: { label: string; samples: string[] }[],
		private people: string[],
		private onSubmit: (renames: [string, string][], rerun: boolean) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Who is speaking?");
		contentEl.createEl("p", {
			text: "Type a name for each voice. Named voices are remembered on this Mac and recognised automatically next time. Leave blank to skip.",
			cls: "setting-item-description",
		});
		const listId = peopleDatalist(contentEl, this.people);
		for (const sp of this.speakers) {
			const unknown = /^Speaker \d+$/.test(sp.label);
			const setting = new Setting(contentEl).setName(sp.label);
			const desc = setting.descEl;
			for (const s of sp.samples) desc.createEl("div", { text: `“${s}”`, cls: "meeting-copilot-sample" });
			setting.addText((t) => {
				t.setPlaceholder(unknown ? "Name" : "Correct name (if wrong)");
				t.inputEl.setAttr("list", listId);
				t.onChange((v) => this.values.set(sp.label, v.trim()));
			});
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Save").onClick(() => this.submit(false)))
			.addButton((b) =>
				b
					.setButtonText("Save & redo AI notes")
					.setCta()
					.onClick(() => this.submit(true)),
			);
	}

	private async submit(rerun: boolean) {
		const renames: [string, string][] = [];
		for (const [from, raw] of this.values) {
			const to = safeFileName(raw).replace(/:/g, "");
			if (to && to !== from) renames.push([from, to]);
		}
		if (!renames.length) {
			new Notice("No names entered.");
			return;
		}
		this.close();
		try {
			await this.onSubmit(renames, rerun);
		} catch (e) {
			new Notice("❌ " + (e as Error).message, 10000);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

const READ_ALOUD =
	"Please read this aloud at your normal speaking pace. " +
	"The quick brown fox jumps over the lazy dog while the team plans the next release. " +
	"Yesterday I reviewed the open tickets and found two issues that need a fix before Friday. " +
	"Today I will follow up with the client, update the board, and share the results with everyone before the end of the day.";

/** Record ~20 s of one person's voice and save it as their voice fingerprint. */
export class VoiceSampleModal extends Modal {
	private recorder = new MeetingRecorder();
	private file = "";
	private timer = 0;
	private name = "";

	constructor(
		app: App,
		private people: string[],
		private deviceId: string,
		private onDone: (name: string, file: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Record a voice sample");
		contentEl.createEl("p", {
			text: "Have the person speak for about 20 seconds in a quiet room, using the mic you use in meetings. The voice fingerprint stays on this Mac.",
			cls: "setting-item-description",
		});
		const listId = peopleDatalist(contentEl, this.people);
		new Setting(contentEl).setName("Person").addText((t) => {
			t.setPlaceholder("e.g. Alice");
			t.inputEl.setAttr("list", listId);
			t.onChange((v) => (this.name = safeFileName(v).replace(/:/g, "")));
		});
		contentEl.createEl("blockquote", { text: READ_ALOUD, cls: "meeting-copilot-readaloud" });
		const status = contentEl.createEl("p", { text: "Ready." });
		let btn: HTMLButtonElement;
		new Setting(contentEl).addButton((b) => {
			btn = b.buttonEl;
			b.setButtonText("Start recording")
				.setCta()
				.onClick(async () => {
					if (!this.recorder.isRecording) {
						if (!this.name) {
							new Notice("Enter the person's name first.");
							return;
						}
						this.file = path.join(os.tmpdir(), `meeting-copilot-voice-${Date.now()}.${this.recorder.ext}`);
						try {
							await this.recorder.start(this.file, this.deviceId || undefined);
						} catch (e) {
							new Notice("Could not start recording: " + (e as Error).message, 10000);
							return;
						}
						b.setButtonText("Stop & save");
						this.timer = window.setInterval(() => {
							const ms = this.recorder.elapsedMs;
							status.setText(`🔴 ${formatClock(ms)}${ms < 10000 ? " — keep going (10 s minimum, 20 s best)" : " — good, stop whenever"}`);
							if (ms >= 30000) btn.click(); // auto-stop at 30 s
						}, 250);
					} else {
						window.clearInterval(this.timer);
						const ms = await this.recorder.stop();
						if (ms < 8000) {
							status.setText("Too short — please record at least 10 seconds.");
							b.setButtonText("Start recording");
							return;
						}
						status.setText("Saving voice fingerprint…");
						b.setDisabled(true);
						try {
							await this.onDone(this.name, this.file);
							this.close();
						} catch (e) {
							status.setText("❌ " + (e as Error).message);
							b.setDisabled(false).setButtonText("Start recording");
						}
					}
				});
		});
	}

	async onClose() {
		window.clearInterval(this.timer);
		if (this.recorder.isRecording) await this.recorder.stop().catch(() => {});
		this.contentEl.empty();
	}
}
