// Records the microphone (or any input device, e.g. a BlackHole aggregate device for
// Zoom/Teams audio) and streams it straight to disk every second, so a crash or
// closed laptop never loses the meeting.
import * as fs from "fs";

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
	try {
		// Labels are only visible after permission has been granted once.
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === "audioinput");
	} catch {
		return [];
	}
}

function pickMimeType(): { mime: string; ext: string } {
	const options = [
		{ mime: "audio/webm;codecs=opus", ext: "webm" },
		{ mime: "audio/ogg;codecs=opus", ext: "ogg" },
		{ mime: "audio/mp4", ext: "m4a" },
	];
	return options.find((o) => MediaRecorder.isTypeSupported(o.mime)) ?? { mime: "", ext: "webm" };
}

export class MeetingRecorder {
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private fd: number | null = null;
	private startedAt = 0;
	private pausedTotal = 0;
	private pausedAt = 0;
	private writeChain: Promise<void> = Promise.resolve();
	private writeError: Error | null = null;
	readonly ext: string;
	private readonly mime: string;
	/** Called with each piece of audio after it is written to the file (for the live transcript). */
	onData: ((chunk: Buffer) => void) | null = null;

	constructor() {
		const t = pickMimeType();
		this.ext = t.ext;
		this.mime = t.mime;
	}

	get isRecording(): boolean {
		return this.recorder !== null && this.recorder.state !== "inactive";
	}

	get isPaused(): boolean {
		return this.recorder?.state === "paused";
	}

	get elapsedMs(): number {
		if (!this.startedAt) return 0;
		const now = this.isPaused ? this.pausedAt : Date.now();
		return now - this.startedAt - this.pausedTotal;
	}

	/** Start recording into `absPath` (file is created/truncated). */
	async start(absPath: string, deviceId?: string): Promise<void> {
		const audio: MediaTrackConstraints = {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		};
		if (deviceId) audio.deviceId = { exact: deviceId };
		this.stream = await navigator.mediaDevices.getUserMedia({ audio });
		this.fd = fs.openSync(absPath, "w");
		this.writeError = null;
		this.recorder = new MediaRecorder(this.stream, {
			...(this.mime ? { mimeType: this.mime } : {}),
			audioBitsPerSecond: 48_000,
		});
		this.recorder.ondataavailable = (e) => {
			if (!e.data.size || this.fd === null) return;
			const fd = this.fd;
			this.writeChain = this.writeChain.then(async () => {
				try {
					const chunk = Buffer.from(await e.data.arrayBuffer());
					fs.writeSync(fd, chunk);
					try {
						this.onData?.(chunk);
					} catch {
						/* the live transcript must never break the recording */
					}
				} catch (err) {
					this.writeError = err as Error;
				}
			});
		};
		this.recorder.start(1000);
		this.startedAt = Date.now();
		this.pausedTotal = 0;
	}

	pause(): void {
		if (this.recorder?.state === "recording") {
			this.recorder.pause();
			this.pausedAt = Date.now();
		}
	}

	resume(): void {
		if (this.recorder?.state === "paused") {
			this.recorder.resume();
			this.pausedTotal += Date.now() - this.pausedAt;
		}
	}

	/** Stop and flush to disk. Returns the recorded duration in ms. */
	async stop(): Promise<number> {
		const rec = this.recorder;
		const elapsed = this.elapsedMs;
		if (rec && rec.state !== "inactive") {
			await new Promise<void>((resolve) => {
				rec.addEventListener("stop", () => resolve(), { once: true });
				rec.stop();
			});
		}
		await this.writeChain;
		this.stream?.getTracks().forEach((t) => t.stop());
		if (this.fd !== null) fs.closeSync(this.fd);
		this.fd = null;
		this.recorder = null;
		this.stream = null;
		this.startedAt = 0;
		if (this.writeError) throw new Error("Writing the recording failed: " + this.writeError.message);
		return elapsed;
	}
}
