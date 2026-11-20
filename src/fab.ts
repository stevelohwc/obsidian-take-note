// The floating mic button: click to record / stop, hover for quick actions, right-click for
// everything, drag to move.
import { setIcon, setTooltip } from "obsidian";
import { MASCOT_ICON, type Mood } from "./mascot.ts";
import { SIDES, type Side, flipSides } from "./bubbles.ts";

export interface FabPosition {
	right: number;
	bottom: number;
}

export interface FabAction {
	icon: string;
	title: string;
	run: (evt: MouseEvent) => void;
}

const DEFAULT_POS: FabPosition = { right: 24, bottom: 48 };
const SIZE = 52;
const BUBBLE = 40; // px, plus GAP between bubbles and from the button
const GAP = 8;
const OPEN_DELAY = 150; // ms: just passing over the button doesn't pop the actions
const CLOSE_DELAY = 300; // ms: time to move the pointer from the button to an action

export class FloatingButton {
	private el: HTMLElement;
	private button: HTMLButtonElement;
	private label: HTMLElement;
	private mood: Mood | null = null;
	private pos: FabPosition;
	private suppressClick = false;
	private lines: Record<Side, HTMLElement>; // a line of bubbles on each side of the button
	private hoverTimer = 0;

	constructor(
		host: HTMLElement,
		pos: FabPosition | null,
		private handlers: {
			onClick: () => void;
			onMenu: (evt: MouseEvent) => void;
			onMoved: (pos: FabPosition) => void;
			actions: () => Record<Side, FabAction[]>; // read on each hover, so they follow the open note and recording state
		},
	) {
		this.el = host.createDiv({ cls: "take-note-fab take-note-mood" });
		this.label = this.el.createDiv({ cls: "take-note-fab-label" });
		const line = (side: Side) => this.el.createDiv({ cls: `take-note-fab-actions is-${side}`, attr: { role: "menu" } });
		this.lines = { left: line("left"), top: line("top"), right: line("right"), bottom: line("bottom") };
		this.button = this.el.createEl("button", { cls: "take-note-fab-button", attr: { "aria-label": "Take Note" } });
		this.pos = pos ?? DEFAULT_POS;
		this.place();

		this.button.addEventListener("click", () => {
			if (this.suppressClick) {
				this.suppressClick = false;
				return;
			}
			this.closeActions();
			this.handlers.onClick();
		});
		this.button.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.closeActions();
			this.handlers.onMenu(evt);
		});
		for (const target of [this.button, ...Object.values(this.lines)]) {
			target.addEventListener("mouseenter", () => this.hover(true));
			target.addEventListener("mouseleave", () => this.hover(false));
		}
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
		window.clearTimeout(this.hoverTimer);
		this.el.remove();
	}

	private hover(inside: boolean): void {
		window.clearTimeout(this.hoverTimer);
		if (inside && this.el.hasClass("is-open")) return;
		if (inside && this.el.hasClass("is-dragging")) return;
		this.hoverTimer = window.setTimeout(() => (inside ? this.openActions() : this.closeActions()), inside ? OPEN_DELAY : CLOSE_DELAY);
	}

	/**
	 * Small buttons on the sides of the mascot, as laid out in settings, each line starting next
	 * to it. Near a window edge a line that wouldn't fit swaps with the opposite one.
	 */
	private openActions(): void {
		Object.values(this.lines).forEach((l) => l.empty());
		const actions = this.handlers.actions();
		if (!SIDES.some((side) => actions[side].length)) return;
		const space: Record<Side, number> = {
			left: window.innerWidth - this.pos.right - SIZE,
			right: this.pos.right,
			top: window.innerHeight - this.pos.bottom - SIZE,
			bottom: this.pos.bottom,
		};
		const counts = { left: actions.left.length, top: actions.top.length, right: actions.right.length, bottom: actions.bottom.length };
		const flip = flipSides(counts, space, (n) => (n ? n * (BUBBLE + GAP) + GAP : 0));
		const onLeftHalf = this.pos.right > window.innerWidth / 2;
		for (const side of SIDES) {
			const at: Side = flip.x && (side === "left" || side === "right") ? (side === "left" ? "right" : "left") : flip.y && (side === "top" || side === "bottom") ? (side === "top" ? "bottom" : "top") : side;
			const placement = at === "left" || at === "right" ? "top" : onLeftHalf ? "right" : "left";
			actions[side].forEach((a, i) => {
				const b = this.lines[at].createEl("button", { cls: "take-note-fab-action", attr: { role: "menuitem", "aria-label": a.title } });
				setIcon(b, a.icon);
				setTooltip(b, a.title, { placement });
				b.setCssProps({ "--take-note-fab-i": String(i) });
				b.addEventListener("click", (evt) => {
					this.closeActions();
					a.run(evt);
				});
			});
		}
		this.el.addClass("is-open");
	}

	private closeActions(): void {
		window.clearTimeout(this.hoverTimer);
		this.el.removeClass("is-open");
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
			this.closeActions();
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
