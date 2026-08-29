import { FuzzySuggestModal, Modal, Setting } from 'obsidian';

export class PublishingFolderSuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: ConstructorParameters<typeof FuzzySuggestModal>[0],
		private readonly folders: string[],
		private readonly onChoose: (folder: string) => void,
	) {
		super(app);
		this.setPlaceholder('Search folders, for example 02');
	}

	getItems(): string[] {
		return this.folders;
	}

	getItemText(folder: string): string {
		return folder;
	}

	onChooseItem(folder: string): void {
		this.onChoose(folder);
	}
}

export class ConfirmPublishingModal extends Modal {
	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private readonly folder: string,
		private readonly source: string,
		private readonly target: string,
		private readonly targetExists: boolean,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Publish “${this.folder}”?`);
		this.contentEl.createEl('p', {
			text: this.targetExists
				? 'The existing destination folder will be replaced.'
				: 'The selected folder will be copied to the final publishing folder.',
		});
		const paths = this.contentEl.createDiv({ cls: 'dns-publishing-preview' });
		paths.createDiv({ text: `Source: ${this.source}` });
		paths.createDiv({ text: `Destination: ${this.target}` });

		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton((button) => button
				.setCta()
				.setButtonText(this.targetExists ? 'Replace' : 'Copy')
				.onClick(() => {
					this.close();
					this.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
