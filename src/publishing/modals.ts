import { FuzzySuggestModal, Modal, Setting } from 'obsidian';
import type { PublishingTargetKind } from './folder-publisher';

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

const DESTINATION_DESCRIPTIONS: Record<PublishingTargetKind, string> = {
	missing: 'The selected folder will be copied to the final publishing folder.',
	folder: 'The existing destination folder will be replaced.',
	file: 'A file already exists at the destination and will be replaced by this folder.',
	symlink: 'A symbolic link already exists at the destination and will be replaced by this folder.',
};

export class ConfirmPublishingModal extends Modal {
	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private readonly folder: string,
		private readonly source: string,
		private readonly target: string,
		private readonly targetKind: PublishingTargetKind,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Publish “${this.folder}”?`);
		this.contentEl.createEl('p', { text: DESTINATION_DESCRIPTIONS[this.targetKind] });
		const paths = this.contentEl.createDiv({ cls: 'dns-publishing-preview' });
		paths.createDiv({ text: `Source: ${this.source}` });
		paths.createDiv({ text: `Destination: ${this.target}` });

		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton((button) => button
				.setCta()
				.setButtonText(this.targetKind === 'missing' ? 'Copy' : 'Replace')
				.onClick(() => {
					this.close();
					this.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
