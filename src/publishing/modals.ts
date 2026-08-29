import { FuzzySuggestModal, Modal, Setting } from 'obsidian';
import type { PublishingTargetKind } from './folder-publisher';
import type { FileDiff, FolderChange, FolderComparison, ImageFile } from './folder-diff';

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
	onConfirm: (keptChanges: FolderChange[]) => void;
}

export class ConfirmPublishingModal extends Modal {
	private comparison: FolderComparison | null = null;
	// Paths the user unchecked: the destination version of each is kept.
	private readonly keptPaths = new Set<string>();
	private objectUrls: string[] = [];

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
		this.releaseObjectUrls();
		this.contentEl.empty();
	}

	private releaseObjectUrls(): void {
		for (const url of this.objectUrls) URL.revokeObjectURL(url);
		this.objectUrls = [];
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
		this.releaseObjectUrls();
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
					this.options.onConfirm(this.keptChanges());
				}));
	}

	private keptChanges(): FolderChange[] {
		return this.comparison?.changes.filter((change) => this.keptPaths.has(change.path)) ?? [];
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

		const selectedCount = changes.length - this.keptPaths.size;
		const header = section.createDiv({ cls: 'dns-publishing-changes__header' });
		const selectAll = header.createEl('input', { type: 'checkbox' });
		selectAll.checked = selectedCount > 0;
		selectAll.indeterminate = selectedCount > 0 && selectedCount < changes.length;
		selectAll.setAttribute('aria-label', 'Apply every change');
		selectAll.addEventListener('change', () => {
			if (selectAll.checked) this.keptPaths.clear();
			else for (const change of changes) this.keptPaths.add(change.path);
			this.renderSummary();
		});
		header.createSpan({
			cls: 'dns-publishing-changes__count',
			text: `${selectedCount} of ${changes.length} changes selected`,
		});

		const list = section.createDiv({ cls: 'dns-publishing-changes__list' });
		for (const change of changes) {
			const row = list.createDiv({
				cls: `dns-publishing-change dns-publishing-change--${change.status}`,
			});
			const checkbox = row.createEl('input', { type: 'checkbox' });
			checkbox.checked = !this.keptPaths.has(change.path);
			checkbox.setAttribute('aria-label', `Apply ${CHANGE_LABELS[change.status].toLowerCase()} ${change.path}`);
			checkbox.addEventListener('change', () => {
				this.setKept(change.path, !checkbox.checked);
				this.renderSummary();
			});
			const open = row.createEl('button', { cls: 'dns-publishing-change__open' });
			open.createSpan({
				cls: 'dns-publishing-change__badge',
				text: CHANGE_LABELS[change.status],
			});
			open.createSpan({ cls: 'dns-publishing-change__path', text: change.path });
			open.onClickEvent(() => void this.renderDiff(change));
		}

		if (this.keptPaths.size > 0) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: `${this.keptPaths.size} unchecked ${this.keptPaths.size === 1 ? 'file keeps' : 'files keep'} the current destination version.`,
			});
		}

		if (truncated) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: 'Only the first 5000 files were compared.',
			});
		}
	}

	private setKept(path: string, kept: boolean): void {
		if (kept) this.keptPaths.add(path);
		else this.keptPaths.delete(path);
	}

	private renderImageDiff(
		body: HTMLElement,
		before: ImageFile | null,
		after: ImageFile | null,
	): void {
		const panes = body.createDiv({ cls: 'dns-publishing-image' });
		const beforePane = this.renderImagePane(panes, 'Current destination', before);
		const afterPane = this.renderImagePane(panes, 'To be published', after);
		if (!before || !after) return;

		const delta = body.createDiv({ cls: 'dns-publishing-image__delta' });
		const difference = after.byteLength - before.byteLength;
		delta.setText(difference === 0
			? 'Same file size, different contents.'
			: `${difference > 0 ? '+' : '−'}${formatBytes(Math.abs(difference))} (${formatBytes(before.byteLength)} → ${formatBytes(after.byteLength)})`);
		// Both sizes are known only once the browser has decoded each image.
		void Promise.all([beforePane, afterPane]).then(([first, second]) => {
			if (!first || !second || !delta.isConnected) return;
			delta.setText(`${delta.getText()} · ${first.width}×${first.height} → ${second.width}×${second.height}`);
		});
	}

	private renderImagePane(
		parent: HTMLElement,
		label: string,
		image: ImageFile | null,
	): Promise<{ width: number; height: number } | null> {
		const pane = parent.createDiv({ cls: 'dns-publishing-image__pane' });
		pane.createDiv({ cls: 'dns-publishing-image__label', text: label });
		if (!image) {
			pane.createDiv({ cls: 'dns-publishing-image__missing', text: 'Not present' });
			return Promise.resolve(null);
		}

		const url = URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
		this.objectUrls.push(url);
		const element = pane.createEl('img', { cls: 'dns-publishing-image__preview' });
		element.src = url;
		const meta = pane.createDiv({ cls: 'dns-publishing-image__meta', text: formatBytes(image.byteLength) });
		return new Promise((resolve) => {
			element.addEventListener('load', () => {
				meta.setText(`${element.naturalWidth}×${element.naturalHeight} · ${formatBytes(image.byteLength)}`);
				resolve({ width: element.naturalWidth, height: element.naturalHeight });
			});
			element.addEventListener('error', () => {
				meta.setText(`${formatBytes(image.byteLength)} · preview unavailable`);
				resolve(null);
			});
		});
	}

	private async renderDiff(change: FolderChange): Promise<void> {
		this.releaseObjectUrls();
		this.setTitle(change.path);
		this.contentEl.empty();
		this.contentEl.removeClass('dns-publishing-content--summary');
		this.contentEl.addClass('dns-publishing-content--diff');
		this.contentEl.createDiv({
			cls: 'dns-publishing-diff__legend',
			text: `${CHANGE_LABELS[change.status]} — the current destination on the left or in red, what will be published on the right or in green.`,
		});
		const body = this.contentEl.createDiv({ cls: 'dns-publishing-diff' });
		body.createDiv({ cls: 'dns-publishing-diff__note', text: 'Loading…' });

		new Setting(this.contentEl)
			.setName('Apply this change')
			.setDesc(APPLY_DESCRIPTIONS[change.status])
			.addToggle((toggle) => toggle
				.setValue(!this.keptPaths.has(change.path))
				.onChange((value) => this.setKept(change.path, !value)));

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
		if (diff.kind === 'image') {
			body.addClass('dns-publishing-diff--image');
			this.renderImageDiff(body, diff.before, diff.after);
			return;
		}
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

const APPLY_DESCRIPTIONS: Record<FolderChange['status'], string> = {
	added: 'Turn off to leave this file out of the published folder.',
	modified: 'Turn off to keep the current destination version.',
	removed: 'Turn off to keep this file at the destination.',
};

const NON_TEXT_NOTES: Record<'binary' | 'too-large' | 'identical', string> = {
	binary: 'This is a binary file, so no line diff is shown.',
	'too-large': 'This file is too large to diff.',
	identical: 'The file contents are identical.',
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
