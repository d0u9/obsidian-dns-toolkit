import {
	RangeSetBuilder,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
	type Text,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { containsCjk } from '../render/custom-container';
import type DnsToolkitPlugin from '../main';

const OPENING = /^(:{3,})\s*(?:([a-zA-Z][a-zA-Z0-9_-]*)(?:\{[^}]*\})?(?:\s+.+)?)?\s*$/;
const CLOSING = /^(:{3,})\s*$/;
const CODE_FENCE = /^\s*(```|~~~)/;
const KNOWN_TYPE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

interface OpenBlock {
	type: string;
	fence: number;
	openedAt: number;
	startLine: number;
	firstContentLine: number;
}

export interface LineMark {
	classes: string[];
}

/** Settings changed, so editors that are already open rebuild their marks. */
export const refreshColonBlocks = StateEffect.define<null>();

/**
 * Reading view owns the rendered blocks; this gives the editor the same shape
 * by classing the lines a block spans, without rewriting any text.
 *
 * These classes change line heights, so they have to come from a state field.
 * CodeMirror computes heights and the viewport before it runs view plugins, so
 * a plugin that resizes lines invalidates the viewport it was just handed: the
 * measure loop restarts until CodeMirror gives up, and the scroll position goes
 * with it.
 */
export function colonBlockEditorExtension(plugin: DnsToolkitPlugin): Extension {
	return StateField.define<DecorationSet>({
		create: (state) => buildDecorations(state, plugin),
		update(value, transaction) {
			// Block structure only depends on the text, on whether the view is
			// showing raw Markdown, and on the settings behind it.
			const modeChanged = transaction.startState.field(editorLivePreviewField, false)
				!== transaction.state.field(editorLivePreviewField, false);
			const refreshed = transaction.effects.some((effect) => effect.is(refreshColonBlocks));
			// Line marks sit at line starts, which an unchanged document keeps.
			if (!transaction.docChanged && !modeChanged && !refreshed) return value;
			return buildDecorations(transaction.state, plugin);
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildDecorations(state: EditorState, plugin: DnsToolkitPlugin): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	// Source mode asks for the raw text, so it gets it unshaped.
	if (!state.field(editorLivePreviewField, false)) return builder.finish();
	if (!plugin.settings.enableCustomContainers || !plugin.settings.enableEditorColonBlocks) {
		return builder.finish();
	}

	const marks = markLines(state.doc, plugin.settings.defaultType);
	for (const [line, mark] of marks) {
		builder.add(
			line,
			line,
			Decoration.line({ class: mark.classes.join(' ') }),
		);
	}
	return builder.finish();
}

/** Walks the document once, tracking open fences, and returns line positions. */
export function markLines(document: Text, defaultType: string): Map<number, LineMark> {
	const marks = new Map<number, LineMark>();
	const open: OpenBlock[] = [];
	let codeFence: string | null = null;

	for (let number = 1; number <= document.lines; number += 1) {
		const line = document.line(number);
		const text = line.text;

		const fenceMatch = text.match(CODE_FENCE);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? '';
			if (codeFence === null) codeFence = marker;
			else if (codeFence === marker) codeFence = null;
		}
		if (codeFence !== null) {
			markInside(marks, line.from, open);
			continue;
		}

		const closing = text.match(CLOSING);
		const current = open[open.length - 1];
		if (closing && current && (closing[1] ?? '').length >= current.fence) {
			markInside(marks, line.from, open);
			addClass(marks, line.from, 'dns-cm-delimiter');
			addClass(marks, line.from, 'dns-cm-block--last');
			open.pop();
			markCjkVerse(marks, document, current, number);
			continue;
		}

		const opening = text.match(OPENING);
		if (opening) {
			const type = (opening[2] ?? defaultType).toLowerCase();
			if (KNOWN_TYPE.test(type)) {
				markInside(marks, line.from, open);
				open.push({
					type,
					fence: (opening[1] ?? ':::').length,
					openedAt: line.from,
					startLine: number,
					firstContentLine: line.to + 1,
				});
				addClass(marks, line.from, `dns-cm-block--${type}`);
				addClass(marks, line.from, 'dns-cm-block');
				addClass(marks, line.from, 'dns-cm-delimiter');
				addClass(marks, line.from, 'dns-cm-block--first');
				continue;
			}
		}

		markInside(marks, line.from, open);

		// A blank line between stanzas. Latin leading is tighter than the CJK
		// leading beside it, so the break is given a height of its own rather
		// than left to whatever the verse's line height happens to be.
		const inside = open[open.length - 1];
		if (inside?.type === 'poem' && text.trim() === '') {
			addClass(marks, line.from, 'dns-cm-block--poem-break');
		}
	}

	// Whatever is still open never met a closing fence. A verse being typed is
	// still verse, so it is spaced as one until the closer arrives.
	for (const block of open) {
		addClass(marks, block.openedAt, 'dns-cm-unclosed');
		markCjkVerse(marks, document, block, document.lines);
	}
	return marks;
}

/**
 * Han characters fill their box, so a Chinese poem needs looser leading than a
 * Latin one. The rendered view decides this from the block's text; the editor
 * reads the same lines to reach the same answer.
 */
function markCjkVerse(
	marks: Map<number, LineMark>,
	document: Text,
	block: OpenBlock,
	endLine: number,
): void {
	if (block.type !== 'poem') return;
	let text = '';
	for (let number = block.startLine; number <= endLine; number += 1) {
		text += document.line(number).text;
	}
	if (!containsCjk(text)) return;
	for (let number = block.startLine; number <= endLine; number += 1) {
		addClass(marks, document.line(number).from, 'dns-cm-block--poem-cjk');
	}
}

function markInside(marks: Map<number, LineMark>, from: number, open: OpenBlock[]): void {
	const current = open[open.length - 1];
	if (!current) return;
	addClass(marks, from, 'dns-cm-block');
	addClass(marks, from, `dns-cm-block--${current.type}`);
	if (open.length > 1) addClass(marks, from, 'dns-cm-block--nested');
}

function addClass(marks: Map<number, LineMark>, from: number, name: string): void {
	const mark = marks.get(from) ?? { classes: [] };
	if (!mark.classes.includes(name)) mark.classes.push(name);
	marks.set(from, mark);
}
