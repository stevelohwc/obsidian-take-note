// Take Note's mascot: a little microphone with a face. One icon per mood, registered with
// Obsidian's addIcon (100×100 viewBox). Colours come from styles.css so it follows the theme.
import { addIcon } from "obsidian";

export type Mood = "idle" | "recording" | "paused" | "busy";

export const MASCOT_ICON: Record<Mood, string> = {
	idle: "take-note-mascot",
	recording: "take-note-mascot-recording",
	paused: "take-note-mascot-paused",
	busy: "take-note-mascot-busy",
};

const LINE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

const body = [
	`<path class="tn-stand" d="M22 48a28 28 0 0 0 56 0" ${LINE} stroke-width="6"/>`,
	`<path class="tn-stand" d="M50 76v11M37 89h26" ${LINE} stroke-width="6"/>`,
	`<rect class="tn-body" x="31" y="6" width="38" height="60" rx="19" fill="currentColor"/>`,
	`<ellipse class="tn-cheek" cx="37.5" cy="43" rx="4.2" ry="2.6" fill="none"/>`,
	`<ellipse class="tn-cheek" cx="62.5" cy="43" rx="4.2" ry="2.6" fill="none"/>`,
].join("");

const faces: Record<Mood, string> = {
	// Happy, waiting.
	idle: [
		`<circle class="tn-face" cx="43" cy="33" r="3.6"/>`,
		`<circle class="tn-face" cx="57" cy="33" r="3.6"/>`,
		`<path class="tn-face-line" d="M44.5 43.5q5.5 5.5 11 0" fill="none" stroke-width="3.4" stroke-linecap="round"/>`,
	].join(""),
	// Listening: wide eyes, little "o" mouth, sound waves.
	recording: [
		`<circle class="tn-face" cx="43" cy="32" r="4.4"/>`,
		`<circle class="tn-face" cx="57" cy="32" r="4.4"/>`,
		`<circle class="tn-shine" cx="44.4" cy="30.4" r="1.4"/>`,
		`<circle class="tn-shine" cx="58.4" cy="30.4" r="1.4"/>`,
		`<ellipse class="tn-face" cx="50" cy="45" rx="3.4" ry="4"/>`,
		`<path class="tn-wave" d="M13 24q-6 11 0 22M88 24q6 11 0 22" ${LINE} stroke-width="4.5"/>`,
	].join(""),
	// Paused: resting eyes.
	paused: [
		`<path class="tn-face-line" d="M39 33h8M53 33h8M46 45h8" fill="none" stroke-width="3.4" stroke-linecap="round"/>`,
	].join(""),
	// Thinking: content closed eyes and a sparkle.
	busy: [
		`<path class="tn-face-line" d="M39 34q4-4.5 8 0M53 34q4-4.5 8 0" fill="none" stroke-width="3.4" stroke-linecap="round"/>`,
		`<path class="tn-face-line" d="M46.5 44.5q3.5 2.5 7 0" fill="none" stroke-width="3.2" stroke-linecap="round"/>`,
		`<path class="tn-sparkle" d="M84 4l2.6 6.4L93 13l-6.4 2.6L84 22l-2.6-6.4L75 13l6.4-2.6z" fill="currentColor"/>`,
	].join(""),
};

export function registerMascotIcons(): void {
	for (const mood of Object.keys(faces) as Mood[]) {
		addIcon(MASCOT_ICON[mood], `<g class="tn-mascot tn-${mood}">${body}${faces[mood]}</g>`);
	}
}
