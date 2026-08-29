import type DnsToolkitPlugin from '../main';
import { chooseAndPublishFolder } from '../publishing/folder-publisher';

export function registerCommands(plugin: DnsToolkitPlugin): void {
	plugin.addCommand({
		id: 'insert-custom-container',
		name: 'Insert colon block',
		editorCallback: (editor) => {
			const body = editor.getSelection() || 'Add content here';
			editor.replaceSelection(
				`::: ${plugin.settings.defaultType}\n\n${body}\n\n:::`,
			);
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
