import { FuzzySuggestModal, Modal, Setting } from 'obsidian';
import type { PublishingTargetKind } from './folder-publisher';
import type { FileDiff, FolderChange, FolderComparison } from './folder-diff';

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

const CHANGE_LABELS: Record<FolderChange['status'], string> = {
	added: 'Added',
	modified: 'Modified',
	removed: 'Removed',
};

export interface ConfirmPublishingOptions {
	folder: string;
	source: string;
	target: string;
	targetKind: PublishingTargetKind;
	compare: () => Promise<FolderComparison>;
	loadDiff: (change: FolderChange) => Promise<FileDiff>;
	onConfirm: () => void;
}

export class ConfirmPublishingModal extends Modal {
	private comparison: FolderComparison | null = null;

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private readonly options: ConfirmPublishingOptions,
	) {
		super(app);
		this.modalEl.addClass('dns-publishing-modal');
	}

	onOpen(): void {
		this.renderSummary();
		void this.runComparison();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async runComparison(): Promise<void> {
		try {
			this.comparison = await this.options.compare();
		} catch (error) {
			this.comparison = null;
			this.renderSummary(errorMessage(error));
			return;
		}
		// The user may have opened a file diff while the comparison ran.
		if (this.contentEl.hasClass('dns-publishing-content--summary')) this.renderSummary();
	}

	private renderSummary(comparisonError?: string): void {
		this.setTitle(`Publish “${this.options.folder}”?`);
		this.contentEl.empty();
		this.contentEl.removeClass('dns-publishing-content--diff');
		this.contentEl.addClass('dns-publishing-content--summary');
		this.contentEl.createEl('p', { text: DESTINATION_DESCRIPTIONS[this.options.targetKind] });

		const paths = this.contentEl.createDiv({ cls: 'dns-publishing-preview' });
		paths.createDiv({ text: `Source: ${this.options.source}` });
		paths.createDiv({ text: `Destination: ${this.options.target}` });

		this.renderChanges(comparisonError);

		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton((button) => button
				.setCta()
				.setButtonText(this.options.targetKind === 'missing' ? 'Copy' : 'Replace')
				.onClick(() => {
					this.close();
					this.options.onConfirm();
				}));
	}

	private renderChanges(comparisonError?: string): void {
		const section = this.contentEl.createDiv({ cls: 'dns-publishing-changes' });
		if (comparisonError) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: `Could not compare the folders: ${comparisonError}`,
			});
			return;
		}
		if (!this.comparison) {
			section.createDiv({ cls: 'dns-publishing-changes__note', text: 'Comparing folders…' });
			return;
		}

		const { changes, unchangedCount, truncated } = this.comparison;
		const counts = [
			['added', changes.filter((change) => change.status === 'added').length],
			['modified', changes.filter((change) => change.status === 'modified').length],
			['removed', changes.filter((change) => change.status === 'removed').length],
			['unchanged', unchangedCount],
		] as const;
		section.createDiv({
			cls: 'dns-publishing-changes__summary',
			text: counts
				.filter(([, count]) => count > 0)
				.map(([label, count]) => `${count} ${label}`)
				.join(' · ') || 'No files found.',
		});

		if (changes.length === 0) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: 'The destination already matches this folder.',
			});
			return;
		}

		const list = section.createDiv({ cls: 'dns-publishing-changes__list' });
		for (const change of changes) {
			const row = list.createEl('button', {
				cls: `dns-publishing-change dns-publishing-change--${change.status}`,
			});
			row.createSpan({
				cls: 'dns-publishing-change__badge',
				text: CHANGE_LABELS[change.status],
			});
			row.createSpan({ cls: 'dns-publishing-change__path', text: change.path });
			row.onClickEvent(() => void this.renderDiff(change));
		}

		if (truncated) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: 'Only the first 5000 files were compared.',
			});
		}
	}

	private async renderDiff(change: FolderChange): Promise<void> {
		this.setTitle(change.path);
		this.contentEl.empty();
		this.contentEl.removeClass('dns-publishing-content--summary');
		this.contentEl.addClass('dns-publishing-content--diff');
		this.contentEl.createDiv({
			cls: 'dns-publishing-diff__legend',
			text: `${CHANGE_LABELS[change.status]} — red is the current destination, green is what will be published.`,
		});
		const body = this.contentEl.createDiv({ cls: 'dns-publishing-diff' });
		body.createDiv({ cls: 'dns-publishing-diff__note', text: 'Loading…' });

		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText('Back')
				.onClick(() => this.renderSummary()));

		let diff: FileDiff;
		try {
			diff = await this.options.loadDiff(change);
		} catch (error) {
			body.empty();
			body.createDiv({
				cls: 'dns-publishing-diff__note',
				text: `Could not read the file: ${errorMessage(error)}`,
			});
			return;
		}
		// Bail out if the user went back while the file was being read.
		if (!this.contentEl.hasClass('dns-publishing-content--diff')) return;

		body.empty();
		if (diff.kind !== 'text') {
			body.createDiv({ cls: 'dns-publishing-diff__note', text: NON_TEXT_NOTES[diff.kind] });
			return;
		}
		for (const line of diff.lines) {
			const row = body.createDiv({ cls: `dns-publishing-diff__line is-${line.kind}` });
			if (line.kind === 'gap') {
				row.createSpan({ cls: 'dns-publishing-diff__gap', text: `⋯ ${line.text}` });
				continue;
			}
			row.createSpan({
				cls: 'dns-publishing-diff__gutter',
				text: line.beforeLine === undefined ? '' : String(line.beforeLine),
			});
			row.createSpan({
				cls: 'dns-publishing-diff__gutter',
				text: line.afterLine === undefined ? '' : String(line.afterLine),
			});
			row.createSpan({
				cls: 'dns-publishing-diff__sign',
				text: line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ',
			});
			row.createSpan({ cls: 'dns-publishing-diff__text', text: line.text });
		}
	}
}

const NON_TEXT_NOTES: Record<'binary' | 'too-large' | 'identical', string> = {
	binary: 'This is a binary file, so no line diff is shown.',
	'too-large': 'This file is too large to diff.',
	identical: 'The file contents are identical.',
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
