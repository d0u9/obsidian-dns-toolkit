import {
	EditorSuggest,
	type App,
	type Editor,
	type EditorPosition,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type TFile,
} from 'obsidian';
import { SUPPORTED_BLOCKS, type BlockType } from '../blocks';

const OPENING_LINE = /^(:{3,})\s*([a-zA-Z][a-zA-Z0-9_-]*)?$/;

/** Completes the type name while an opening delimiter is being typed. */
export class ColonBlockSuggest extends EditorSuggest<BlockType> {
	constructor(app: App) {
		super(app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const match = before.match(OPENING_LINE);
		if (!match) return null;
		const query = match[2] ?? '';
		return {
			start: { line: cursor.line, ch: before.length - query.length },
			end: cursor,
			query,
		};
	}

	getSuggestions(context: EditorSuggestContext): BlockType[] {
		const query = context.query.toLowerCase();
		return SUPPORTED_BLOCKS.filter((block) => block.type.startsWith(query));
	}

	renderSuggestion(block: BlockType, element: HTMLElement): void {
		element.addClass('dns-block-suggestion');
		element.createDiv({ cls: 'dns-block-suggestion__type', text: block.type });
		element.createDiv({ cls: 'dns-block-suggestion__desc', text: block.description });
	}

	selectSuggestion(block: BlockType): void {
		const context = this.context;
		if (!context) return;
		const text = block.snippet ?? block.type;
		context.editor.replaceRange(text, context.start, context.end);
		context.editor.setCursor({ line: context.start.line, ch: context.start.ch + text.length });
	}
}
