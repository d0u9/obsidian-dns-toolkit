import { FuzzySuggestModal, type App, type Editor } from 'obsidian';
import { SUPPORTED_BLOCKS, type BlockType } from '../blocks';
import type DnsToolkitPlugin from '../main';
import { chooseAndPublishFolder } from '../publishing/folder-publisher';

class BlockTypeSuggestModal extends FuzzySuggestModal<BlockType> {
	constructor(app: App, private readonly onChoose: (block: BlockType) => void) {
		super(app);
		this.setPlaceholder('Choose a colon block type');
	}

	getItems(): BlockType[] {
		return [...SUPPORTED_BLOCKS];
	}

	getItemText(block: BlockType): string {
		return `${block.type} — ${block.description}`;
	}

	onChooseItem(block: BlockType): void {
		this.onChoose(block);
	}
}

function insertBlock(editor: Editor, opening: string): void {
	const body = editor.getSelection() || 'Add content here';
	editor.replaceSelection(`::: ${opening}\n\n${body}\n\n:::`);
}

export function registerCommands(plugin: DnsToolkitPlugin): void {
	plugin.addCommand({
		id: 'insert-custom-container',
		name: 'Insert colon block',
		editorCallback: (editor) => insertBlock(editor, plugin.settings.defaultType),
	});

	plugin.addCommand({
		id: 'insert-colon-block-of-type',
		name: 'Insert colon block of type…',
		editorCallback: (editor) => {
			new BlockTypeSuggestModal(plugin.app, (block) => {
				insertBlock(editor, block.snippet ?? block.type);
			}).open();
		},
	});

	plugin.addCommand({
		id: 'toggle-colon-blocks-current-reading-view',
		name: 'Toggle colon blocks in current reading view',
		callback: () => plugin.toggleColonBlocksInActiveReadingView(),
	});

	plugin.addCommand({
		id: 'publish-folder-to-final-publishing-folder',
		name: 'Publish folder to final publishing folder',
		callback: () => void chooseAndPublishFolder(plugin),
	});
}
