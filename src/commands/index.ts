import type DnsToolkitPlugin from '../main';

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
}
