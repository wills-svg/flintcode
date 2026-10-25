import {
	Box,
	Input,
	SelectList,
	Spacer,
	Text,
	visibleWidth,
	type Component,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { ANSI, FLINTCODE, ansiBg, ansiFg } from "./palette.js";

const RESET = ANSI.reset;
const DIM = ANSI.muted;
const CYAN = ANSI.accent;
const BOLD = ANSI.bold;

function title(text: string): Text {
	return new Text(`${CYAN}${BOLD}${text}${RESET}`, 0, 0);
}

export interface SelectDialogOptions {
	tui: TUI;
	title: string;
	items: SelectItem[];
	maxVisible?: number;
	onSelect: (value: string) => void | Promise<void>;
	onCancel?: () => void;
	restoreFocus?: () => void;
}

const BG = ansiBg(FLINTCODE.panel);
const FG = ansiFg(FLINTCODE.text);

class Rule implements Component {
	invalidate(): void {
		// Static.
	}

	render(width: number): string[] {
		return [`${ANSI.dim}${"─".repeat(Math.max(0, width))}${RESET}`];
	}
}

function clipBody(body: string | undefined, maxLines = 8): string | undefined {
	if (!body) return undefined;
	const lines = body.split("\n");
	const visible = lines.slice(0, maxLines).map((line) =>
		line.length > 180 ? `${line.slice(0, 177)}…` : line,
	);
	if (lines.length > maxLines) visible.push(`… ${lines.length - maxLines} more lines`);
	return visible.join("\n");
}

function terminalRows(tui: TUI): number {
	return Number((tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24);
}

function optionBudget(tui: TUI, requested: number, itemCount: number): number {
	return Math.max(3, Math.min(requested, itemCount, Math.floor(terminalRows(tui) * 0.35)));
}

function bodyBudget(tui: TUI): number {
	return Math.max(2, Math.min(8, Math.floor(terminalRows(tui) * 0.25)));
}

class SolidPanel implements Component {
	constructor(private readonly child: Component) {}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		return this.child.render(width).map((line) => {
			const repainted = line.replaceAll(RESET, `${RESET}${BG}${FG}`);
			const padding = Math.max(0, width - visibleWidth(repainted));
			return `${BG}${FG}${repainted}${" ".repeat(padding)}${RESET}`;
		});
	}
}

function panel(component: Component): Component {
	return new SolidPanel(component);
}

export function showSelectDialog(options: SelectDialogOptions): void {
	const box = new Box(1, 1);
	box.addChild(title(options.title));
	box.addChild(new Rule());
	if (options.items.length === 0) {
		box.addChild(new Text(`${DIM}No choices available.${RESET}`, 0, 0));
	} else {
		const list = new SelectList(
			options.items,
			optionBudget(options.tui, options.maxVisible ?? 10, options.items.length),
			getSelectListTheme(),
		);
		box.addChild(list);
		list.onSelect = (item) => {
			close();
			void options.onSelect(item.value);
		};
		list.onCancel = () => {
			close();
			options.onCancel?.();
		};
	}
	box.addChild(new Spacer(1));
	box.addChild(new Text(`${DIM}Enter select  ·  Esc cancel${RESET}`, 0, 0));
	const handle = options.tui.showOverlay(panel(box), {
		width: "82%",
		minWidth: 28,
		maxHeight: "90%",
		margin: 1,
	});
	let closed = false;
	function close() {
		if (closed) return;
		closed = true;
		handle.hide();
		if (options.restoreFocus) setTimeout(options.restoreFocus, 0);
	}
	if (options.items.length === 0) {
		setTimeout(close, 10);
	} else {
		const list = box.children.find((child): child is SelectList => child instanceof SelectList);
		if (list) options.tui.setFocus(list);
	}
}

export interface InputDialogOptions {
	tui: TUI;
	title: string;
	placeholder?: string;
	value?: string;
	onSubmit: (value: string) => void | Promise<void>;
	onCancel?: () => void;
	restoreFocus?: () => void;
}

export function showInputDialog(options: InputDialogOptions): void {
	const box = new Box(1, 1);
	box.addChild(title(options.title));
	box.addChild(new Spacer(1));
	const input = new Input({
		prompt: "> ",
		placeholder: options.placeholder ?? "",
		placeholderStyle: (text) => `${DIM}${text}${RESET}`,
	});
	if (options.value) input.setValue(options.value);
	box.addChild(input);
	box.addChild(new Spacer(1));
	box.addChild(new Text(`${DIM}Enter confirm  ·  Esc cancel${RESET}`, 0, 0));
	const handle = options.tui.showOverlay(panel(box), {
		width: "82%",
		minWidth: 28,
		maxHeight: 10,
		margin: 1,
	});
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		handle.hide();
		if (options.restoreFocus) setTimeout(options.restoreFocus, 0);
	};
	input.onSubmit = (value) => {
		close();
		void options.onSubmit(value);
	};
	input.onEscape = () => {
		close();
		options.onCancel?.();
	};
	options.tui.setFocus(input);
}

export interface ChoiceDialogOptions {
	tui: TUI;
	title: string;
	body?: string;
	items: SelectItem[];
	maxVisible?: number;
	restoreFocus?: () => void;
}

export interface ChoiceDialogHandle {
	promise: Promise<string | null>;
	close: (value?: string | null) => void;
}

export function showChoiceDialog(options: ChoiceDialogOptions): ChoiceDialogHandle {
	const box = new Box(1, 1);
	box.addChild(title(options.title));
	box.addChild(new Rule());
	const body = clipBody(options.body, bodyBudget(options.tui));
	if (body) {
		box.addChild(new Text(body, 0, 0));
	}
	box.addChild(new Spacer(1));
	const list = new SelectList(
		options.items,
		optionBudget(options.tui, options.maxVisible ?? 6, Math.max(1, options.items.length)),
		getSelectListTheme(),
	);
	box.addChild(list);
	box.addChild(new Spacer(1));
	box.addChild(new Text(`${DIM}Enter select  ·  Esc cancel${RESET}`, 0, 0));
	const handle = options.tui.showOverlay(panel(box), {
		width: "90%",
		minWidth: 32,
		maxHeight: "92%",
		margin: 1,
	});
	let settled = false;
	let resolvePromise!: (value: string | null) => void;
	const promise = new Promise<string | null>((resolve) => {
		resolvePromise = resolve;
	});
	const settle = (value: string | null) => {
		if (settled) return;
		settled = true;
		handle.hide();
		resolvePromise(value);
		if (options.restoreFocus) setTimeout(options.restoreFocus, 0);
	};
	list.onSelect = (item) => settle(item.value);
	list.onCancel = () => settle(null);
	options.tui.setFocus(list);
	return {
		promise,
		close: (value = null) => settle(value),
	};
}

export interface AsyncInputDialogOptions {
	tui: TUI;
	title: string;
	message?: string;
	placeholder?: string;
	value?: string;
	restoreFocus?: () => void;
}

export function showInputDialogAsync(options: AsyncInputDialogOptions): ChoiceDialogHandle {
	const box = new Box(1, 1);
	box.addChild(title(options.title));
	if (options.message) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(options.message, 0, 0));
	}
	box.addChild(new Spacer(1));
	const input = new Input({
		prompt: "> ",
		placeholder: options.placeholder ?? "",
		placeholderStyle: (text) => `${DIM}${text}${RESET}`,
	});
	if (options.value) input.setValue(options.value);
	box.addChild(input);
	box.addChild(new Spacer(1));
	box.addChild(new Text(`${DIM}Enter confirm  ·  Esc cancel${RESET}`, 0, 0));
	const handle = options.tui.showOverlay(panel(box), {
		width: "82%",
		minWidth: 28,
		maxHeight: 14,
		margin: 1,
	});
	let settled = false;
	let resolvePromise!: (value: string | null) => void;
	const promise = new Promise<string | null>((resolve) => {
		resolvePromise = resolve;
	});
	const settle = (value: string | null) => {
		if (settled) return;
		settled = true;
		handle.hide();
		resolvePromise(value);
		if (options.restoreFocus) setTimeout(options.restoreFocus, 0);
	};
	input.onSubmit = (value) => settle(value);
	input.onEscape = () => settle(null);
	options.tui.setFocus(input);
	return { promise, close: (value = null) => settle(value) };
}

export interface ConfirmDialogOptions {
	tui: TUI;
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
	onResult: (confirmed: boolean) => void | Promise<void>;
	restoreFocus?: () => void;
}

export function showConfirmDialog(options: ConfirmDialogOptions): void {
	showSelectDialog({
		tui: options.tui,
		title: options.title,
		items: [
			{ value: "yes", label: options.confirmLabel ?? "Yes", description: options.danger ? "destructive" : undefined },
			{ value: "no", label: options.cancelLabel ?? "Cancel" },
		],
		maxVisible: 2,
		onSelect: (value) => options.onResult(value === "yes"),
		onCancel: () => options.onResult(false),
		...(options.restoreFocus ? { restoreFocus: options.restoreFocus } : {}),
	});
}
