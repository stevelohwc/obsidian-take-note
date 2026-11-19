// The floating mic button: click to record / stop, right-click for more, drag to move.
import { setIcon } from "obsidian";
import { MASCOT_ICON, type Mood } from "./mascot.ts";

export interface FabPosition {
	right: number;
	bottom: number;
}

const DEFAULT_POS: FabPosition = { right: 24, bottom: 48 };
const SIZE = 52;

export class FloatingButton {
	private el: HTMLElement;
	private button: HTMLButtonElement;
	private label: HTMLElement;
	private mood: Mood | null = null;
	private pos: FabPosition;
	private suppressClick = false;

	constructor(
		host: HTMLElement,
		pos: FabPosition | null,
		private handlers: {
			onClick: () => void;
			onMenu: (evt: MouseEvent) => void;
			onMoved: (pos: FabPosition) => void;
		},
	) {
		this.el = host.createDiv({ cls: "take-note-fab take-note-mood" });
		this.label = this.el.createDiv({ cls: "take-note-fab-label" });
		this.button = this.el.createEl("button", { cls: "take-note-fab-button", attr: { "aria-label": "Take Note" } });
		this.pos = pos ?? DEFAULT_POS;
		this.place();

		this.button.addEventListener("click", () => {
			if (this.suppressClick) {
				this.suppressClick = false;
				return;
			}
			this.handlers.onClick();
		});
		this.button.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.handlers.onMenu(evt);
		});
		this.enableDrag();
		this.set("idle", "Record a meeting");
	}

	/** Update the mascot's mood and the text next to it. `pinned` keeps the text visible. */
	set(mood: Mood, text: string, pinned = false): void {
		if (mood !== this.mood) {
			this.mood = mood;
			setIcon(this.button, MASCOT_ICON[mood]);
			this.el.dataset.mood = mood;
		}
		this.label.setText(text);
		this.el.toggleClass("is-pinned", pinned);
		this.button.setAttr("aria-label", text);
	}

	/** Keep the button on screen after the window is resized. */
	clamp(): void {
		this.place();
	}

	destroy(): void {
		this.el.remove();
	}

	private place(): void {
		const maxRight = Math.max(8, window.innerWidth - SIZE - 8);
		const maxBottom = Math.max(8, window.innerHeight - SIZE - 8);
		this.pos = {
			right: Math.min(Math.max(8, this.pos.right), maxRight),
			bottom: Math.min(Math.max(8, this.pos.bottom), maxBottom),
		};
		this.el.setCssProps({ "--take-note-fab-right": `${this.pos.right}px`, "--take-note-fab-bottom": `${this.pos.bottom}px` });
	}

	private enableDrag(): void {
		let start: { x: number; y: number; pos: FabPosition } | null = null;
		let dragging = false;
		this.button.addEventListener("pointerdown", (evt) => {
			if (evt.button !== 0) return;
			start = { x: evt.clientX, y: evt.clientY, pos: { ...this.pos } };
			dragging = false;
			this.suppressClick = false;
			this.button.setPointerCapture(evt.pointerId);
		});
		this.button.addEventListener("pointermove", (evt) => {
			if (!start) return;
			const dx = evt.clientX - start.x;
			const dy = evt.clientY - start.y;
			if (!dragging && Math.hypot(dx, dy) < 5) return;
			dragging = true;
			this.el.addClass("is-dragging");
			this.pos = { right: start.pos.right - dx, bottom: start.pos.bottom - dy };
			this.place();
		});
		const end = (evt: PointerEvent) => {
			if (!start) return;
			start = null;
			if (this.button.hasPointerCapture(evt.pointerId)) this.button.releasePointerCapture(evt.pointerId);
			if (dragging) {
				this.suppressClick = evt.type === "pointerup"; // a click event follows; don't treat the drop as a click
				this.el.removeClass("is-dragging");
				this.handlers.onMoved({ ...this.pos });
			}
		};
		this.button.addEventListener("pointerup", end);
		this.button.addEventListener("pointercancel", end);
	}
}
