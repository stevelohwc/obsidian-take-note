// Settings editor for the hover bubbles: a live preview of the floating button with a line of
// bubbles on each side. Drag bubbles between sides, drag chips in from "Add", drag a bubble
// back to "Add" (or click its ×) to remove it.
import { setIcon, setTooltip } from "obsidian";
import {
	BUBBLES,
	type BubbleId,
	type BubbleLayout,
	PER_SIDE,
	SIDES,
	type Side,
	copyLayout,
	placeBubble,
	removeBubble,
	sideWithRoom,
} from "./bubbles.ts";
import { MASCOT_ICON } from "./mascot.ts";

const SIDE_NAME: Record<Side, string> = { left: "left", top: "above", right: "right", bottom: "below" };
/** Arrow key that moves a bubble away from the mic on each side (the opposite one moves it closer). */
const AWAY: Record<Side, string> = { left: "ArrowLeft", right: "ArrowRight", top: "ArrowUp", bottom: "ArrowDown" };
const TOWARD: Record<Side, string> = { left: "ArrowRight", right: "ArrowLeft", top: "ArrowDown", bottom: "ArrowUp" };

export function renderBubbleEditor(host: HTMLElement, initial: BubbleLayout, onChange: (layout: BubbleLayout) => void): void {
	let layout = copyLayout(initial);
	const root = host.createDiv({ cls: "take-note-bubble-editor" });
	/** What is being dragged: a bubble from a side, or a chip from "Add" (side null). */
	let drag: { id: BubbleId; from: Side | null; el: HTMLElement } | null = null;
	let dropped = false;
	const ghost = createDiv({ cls: "take-note-bubble-ghost" });

	const commit = (next: BubbleLayout, focus?: BubbleId) => {
		layout = next;
		onChange(copyLayout(layout));
		draw(focus);
	};

	const endDrag = () => {
		ghost.detach();
		root.removeClass("is-dragging");
		root.querySelectorAll(".is-drop-target").forEach((el) => el.removeClass("is-drop-target"));
		if (drag) drag.el.removeClass("is-dragging", "is-hidden");
		drag = null;
	};

	const draw = (focus?: BubbleId) => {
		root.empty();
		const stage = root.createDiv({ cls: "take-note-bubble-stage" });
		const cross = stage.createDiv({ cls: "take-note-bubble-cross" });
		const mic = cross.createDiv({ cls: "take-note-bubble-mic take-note-mood", attr: { "aria-hidden": "true" } });
		setIcon(mic, MASCOT_ICON.idle);

		for (const side of SIDES) {
			const zone = cross.createDiv({ cls: `take-note-bubble-zone is-${side}` });
			zone.dataset.side = side;
			layout[side].forEach((id, i) => drawItem(zone, side, id, i, id === focus));
			if (layout[side].length < PER_SIDE) {
				const slot = zone.createDiv({ cls: "take-note-bubble-slot", attr: { "aria-hidden": "true" } });
				setIcon(slot, "plus");
				if (!layout[side].length) slot.addClass("is-empty-side");
			}
			wireZone(zone, side);
		}

		stage.createDiv({
			cls: "take-note-bubble-hint",
			text: `Drag bubbles to any side, up to ${PER_SIDE} each; each line starts next to the mic. Drag one down to Add, or click its ×, to remove it.`,
		});

		// What can be added: drag a chip onto a side, or click it to add it to the first side with room.
		const rest = (Object.keys(BUBBLES) as BubbleId[]).filter((id) => !SIDES.some((side) => layout[side].includes(id)));
		const room = sideWithRoom(layout);
		const tray = root.createDiv({ cls: "take-note-bubble-tray" });
		tray.createDiv({ cls: "take-note-bubble-subhead", text: rest.length ? "Add: drag onto a side, or click" : "All bubbles are placed" });
		const chips = tray.createDiv({ cls: "take-note-bubble-chips" });
		for (const id of rest) {
			const b = BUBBLES[id];
			const chip = chips.createEl("button", { cls: "take-note-bubble-chip", attr: { draggable: "true", "aria-label": `Add ${b.name}` } });
			setIcon(chip.createSpan({ cls: "take-note-bubble-chip-icon" }), b.icon);
			chip.createSpan({ text: b.short });
			setTooltip(chip, b.desc, { placement: "top" });
			chip.disabled = !room;
			chip.addEventListener("click", () => {
				const side = sideWithRoom(layout);
				if (side) commit(placeBubble(layout, id, side, layout[side].length) ?? layout, id);
			});
			startDrag(chip, id, null);
		}
		tray.createDiv({ cls: "take-note-bubble-remove-hint", text: "Drop here to remove" });
		wireTray(tray);
	};

	const drawItem = (zone: HTMLElement, side: Side, id: BubbleId, i: number, focus: boolean) => {
		const b = BUBBLES[id];
		const item = zone.createDiv({
			cls: "take-note-bubble-item",
			attr: {
				draggable: "true",
				tabindex: "0",
				role: "button",
				"aria-label": `${b.name}, ${SIDE_NAME[side]} the mic, position ${i + 1}. Arrow keys move it, Delete removes it.`,
			},
		});
		item.dataset.id = id;
		setIcon(item.createDiv({ cls: "take-note-bubble-face" }), b.icon);
		item.createDiv({ cls: "take-note-bubble-caption", text: b.short });
		setTooltip(item, `${b.name}\n${b.desc}`, { placement: side === "bottom" ? "bottom" : "top" });
		const remove = item.createEl("button", { cls: "take-note-bubble-remove", attr: { "aria-label": `Remove ${b.name}`, tabindex: "-1", draggable: "false" } });
		setIcon(remove, "x");
		remove.addEventListener("click", (evt) => {
			evt.stopPropagation();
			commit(removeBubble(layout, id));
		});
		item.addEventListener("keydown", (evt) => {
			const at = layout[side].indexOf(id);
			if (evt.key === AWAY[side] || evt.key === TOWARD[side]) {
				evt.preventDefault();
				const to = at + (evt.key === AWAY[side] ? 1 : -1);
				if (to >= 0 && to < layout[side].length) commit(placeBubble(removeBubble(layout, id), id, side, to) ?? layout, id);
			} else if (evt.key === "Delete" || evt.key === "Backspace") {
				evt.preventDefault();
				commit(removeBubble(layout, id), layout[side][at + 1] ?? layout[side][at - 1]);
			}
		});
		startDrag(item, id, side);
		if (focus) window.setTimeout(() => item.focus(), 0);
	};

	const startDrag = (el: HTMLElement, id: BubbleId, from: Side | null) => {
		el.addEventListener("dragstart", (evt) => {
			drag = { id, from, el };
			dropped = false;
			evt.dataTransfer?.setData("text/plain", id);
			if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
			el.addClass("is-dragging");
			root.addClass("is-dragging");
			if (from) root.addClass("is-dragging-placed");
			else root.removeClass("is-dragging-placed");
			// Hide a dragged bubble once the browser has its drag image, so the gap closes up.
			if (from) window.setTimeout(() => drag?.el === el && el.addClass("is-hidden"), 0);
		});
		el.addEventListener("dragend", () => {
			const wasDropped = dropped;
			endDrag();
			if (!wasDropped) draw();
		});
	};

	/** Where in `side`'s line the pointer is: how many of its other bubbles are nearer the mic. */
	const indexAt = (zone: HTMLElement, side: Side, evt: DragEvent): number => {
		const along = (x: number, y: number) => (side === "left" ? -x : side === "right" ? x : side === "top" ? -y : y);
		const pointer = along(evt.clientX, evt.clientY);
		let n = 0;
		zone.querySelectorAll<HTMLElement>(".take-note-bubble-item").forEach((el) => {
			if (el === drag?.el) return;
			const r = el.getBoundingClientRect();
			if (along(r.left + r.width / 2, r.top + r.height / 2) < pointer) n++;
		});
		return n;
	};

	const wireZone = (zone: HTMLElement, side: Side) => {
		zone.addEventListener("dragover", (evt) => {
			if (!drag) return;
			const others = layout[side].filter((x) => x !== drag?.id);
			if (others.length >= PER_SIDE) return; // full: not a drop target
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			root.querySelectorAll(".is-drop-target").forEach((el) => el !== zone && el.removeClass("is-drop-target"));
			zone.addClass("is-drop-target");
			const at = indexAt(zone, side, evt);
			const items = Array.from(zone.querySelectorAll<HTMLElement>(".take-note-bubble-item")).filter((el) => el !== drag?.el);
			zone.insertBefore(ghost, items[at] ?? zone.querySelector(".take-note-bubble-slot"));
		});
		zone.addEventListener("drop", (evt) => {
			if (!drag) return;
			evt.preventDefault();
			dropped = true;
			const id = drag.id;
			const next = placeBubble(removeBubble(layout, id), id, side, indexAt(zone, side, evt));
			endDrag();
			if (next) commit(next, id);
			else draw();
		});
	};

	const wireTray = (tray: HTMLElement) => {
		tray.addEventListener("dragover", (evt) => {
			if (!drag?.from) return; // only placed bubbles can be dropped here (to remove them)
			evt.preventDefault();
			ghost.detach();
			root.querySelectorAll(".is-drop-target").forEach((el) => el !== tray && el.removeClass("is-drop-target"));
			tray.addClass("is-drop-target");
		});
		tray.addEventListener("drop", (evt) => {
			if (!drag?.from) return;
			evt.preventDefault();
			dropped = true;
			const id = drag.id;
			endDrag();
			commit(removeBubble(layout, id));
		});
	};

	draw();
}
