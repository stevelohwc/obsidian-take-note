// What this device can do. Recording, transcription and speaker separation need the desktop
// app (microphone files, local programs, Node); on phones and tablets only the text features
// are offered. Also true under Obsidian's mobile emulation, so the phone layout can be tried
// on a computer.
import { Platform } from "obsidian";

export function hasDesktopFeatures(): boolean {
	return Platform.isDesktopApp && !Platform.isMobile;
}
