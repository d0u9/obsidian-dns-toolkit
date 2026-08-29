import { FuzzySuggestModal, Modal, Setting, type ToggleComponent } from 'obsidian';
import type { PublishPlan, PublishDecision, PublishingTargetKind, VaultPull } from './folder-publisher';
import {
	mergeRows,
	type DiffCell,
	type DiffRow,
	type FileDiff,
	type FolderChange,
	type FolderComparison,
	type ImageFile,
} from './folder-diff';

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
	missingTargetRoot: string | null;
	compare: () => Promise<FolderComparison>;
	resolvePaths: (change: FolderChange) => {
		source: string | null;
		destination: string | null;
		plannedDestination: string;
	};
	loadDiff: (change: FolderChange) => Promise<FileDiff>;
	onConfirm: (plan: PublishPlan) => void;
}

export class ConfirmPublishingModal extends Modal {
	private comparison: FolderComparison | null = null;
	// Paths the user unchecked: the destination version of each is kept.
	private readonly keptPaths = new Set<string>();
	// Per file, the runs of changed lines to take from the destination instead.
	private readonly keptHunks = new Map<string, Set<number>>();
	// Files whose chosen result is also written back into the vault.
	private readonly pulledPaths = new Set<string>();
	private readonly loadedDiffs = new Map<string, { rows: DiffRow[]; hunkCount: number; trailingNewline: boolean }>();
	private objectUrls: string[] = [];

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private readonly options: ConfirmPublishingOptions,
	) {
		super(app);
		this.modalEl.addClass('dns-publishing-modal');
		// Registered after the modal's own handler, so this one runs first and
		// keeps Escape inside the dialog while a file diff is open.
		this.scope.register([], 'Escape', () => {
			if (this.contentEl.hasClass('dns-publishing-content--diff')) {
				this.renderSummary();
				return false;
			}
			this.close();
			return false;
		});
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

		if (this.options.missingTargetRoot) {
			this.contentEl.createDiv({
				cls: 'dns-publishing-warning',
				text: `The final publishing folder ${this.options.missingTargetRoot} does not exist yet, so every file counts as new. Check the path in settings if that is unexpected.`,
			});
		}

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
					this.options.onConfirm({ decisions: this.decisions(), pulls: this.pulls() });
				}));
	}

	private decisions(): PublishDecision[] {
		const decisions: PublishDecision[] = [];
		for (const change of this.comparison?.changes ?? []) {
			if (this.keptPaths.has(change.path)) {
				decisions.push({ path: change.path, status: change.status, kind: 'keep-destination' });
				continue;
			}
			const hunks = this.keptHunks.get(change.path);
			const diff = this.loadedDiffs.get(change.path);
			if (!hunks || hunks.size === 0 || !diff) continue;
			decisions.push({
				path: change.path,
				kind: 'merge',
				text: mergeRows(diff.rows, hunks, diff.trailingNewline),
			});
		}
		return decisions;
	}

	/** The content this file ends up with, or null when it stays as it is. */
	private mergedText(path: string): string | null {
		const diff = this.loadedDiffs.get(path);
		if (!diff) return null;
		const hunks = this.keptHunks.get(path) ?? new Set<number>();
		if (hunks.size === 0) return null;
		const merged = mergeRows(diff.rows, hunks, diff.trailingNewline);
		// An all-vault selection reproduces the note, so there is nothing to pull.
		return merged === mergeRows(diff.rows, new Set(), diff.trailingNewline) ? null : merged;
	}

	private canPull(change: FolderChange): boolean {
		if (change.status !== 'modified') return false;
		if (this.loadedDiffs.has(change.path)) return this.mergedText(change.path) !== null;
		// A file without a line diff can only be taken from the destination whole.
		return this.keptPaths.has(change.path);
	}

	private pulls(): VaultPull[] {
		const pulls: VaultPull[] = [];
		for (const change of this.comparison?.changes ?? []) {
			if (!this.pulledPaths.has(change.path) || !this.canPull(change)) continue;
			const text = this.mergedText(change.path);
			pulls.push(text === null
				? { path: change.path, kind: 'copy' }
				: { path: change.path, kind: 'text', text });
		}
		return pulls;
	}

	// A file counts as kept whole when every one of its runs was taken from the
	// destination, which is also what the file-level buttons set.
	private isWhollyKept(path: string): boolean {
		if (this.keptPaths.has(path)) return true;
		const diff = this.loadedDiffs.get(path);
		const hunks = this.keptHunks.get(path);
		return !!diff && diff.hunkCount > 0 && hunks?.size === diff.hunkCount;
	}

	private pullCount(): number {
		let count = 0;
		for (const change of this.comparison?.changes ?? []) {
			if (this.pulledPaths.has(change.path) && this.canPull(change)) count += 1;
		}
		return count;
	}

	private partialCount(): number {
		let count = 0;
		for (const [path, hunks] of this.keptHunks) {
			if (hunks.size > 0 && !this.isWhollyKept(path)) count += 1;
		}
		return count;
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

		const keptCount = changes.filter((change) => this.isWhollyKept(change.path)).length;
		const selectedCount = changes.length - keptCount;
		const partialCount = this.partialCount();
		const header = section.createDiv({ cls: 'dns-publishing-changes__header' });
		const selectAll = header.createEl('input', { type: 'checkbox' });
		selectAll.checked = selectedCount > 0;
		selectAll.indeterminate = selectedCount > 0 && selectedCount < changes.length;
		selectAll.setAttribute('aria-label', 'Apply every change');
		selectAll.addEventListener('change', () => {
			for (const change of changes) this.setKept(change.path, !selectAll.checked);
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
			checkbox.checked = !this.isWhollyKept(change.path);
			checkbox.indeterminate = (this.keptHunks.get(change.path)?.size ?? 0) > 0
				&& !this.isWhollyKept(change.path);
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
			if (this.pulledPaths.has(change.path) && this.canPull(change)) {
				open.createSpan({
					cls: 'dns-publishing-change__pull',
					text: '↩ vault',
					attr: { 'aria-label': 'Also written back to the vault' },
				});
			}
			open.onClickEvent(() => void this.renderDiff(change));
		}

		if (keptCount > 0) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: `${keptCount} unchecked ${keptCount === 1 ? 'file keeps' : 'files keep'} the current destination version.`,
			});
		}
		const pullCount = this.pullCount();
		if (pullCount > 0) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: `${pullCount} ${pullCount === 1 ? 'note is' : 'notes are'} also updated in the vault from the destination.`,
			});
		}
		if (partialCount > 0) {
			section.createDiv({
				cls: 'dns-publishing-changes__note',
				text: `${partialCount} ${partialCount === 1 ? 'file is' : 'files are'} published as a merge of both versions.`,
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
		const diff = this.loadedDiffs.get(path);
		if (kept) {
			this.keptPaths.add(path);
			if (diff) {
				this.keptHunks.set(path, new Set(Array.from({ length: diff.hunkCount }, (_, index) => index)));
			}
			return;
		}
		this.keptPaths.delete(path);
		this.keptHunks.delete(path);
	}

	private setHunkKept(path: string, hunk: number, kept: boolean): void {
		const hunks = this.keptHunks.get(path) ?? new Set<number>();
		if (kept) hunks.add(hunk);
		else hunks.delete(hunk);
		this.keptHunks.set(path, hunks);
		const diff = this.loadedDiffs.get(path);
		if (diff && diff.hunkCount > 0 && hunks.size === diff.hunkCount) this.keptPaths.add(path);
		else this.keptPaths.delete(path);
	}

	private renderDiffPaths(change: FolderChange): void {
		const paths = this.options.resolvePaths(change);
		const block = this.contentEl.createDiv({ cls: 'dns-publishing-preview' });
		block.createDiv({
			text: paths.destination
				? `Destination: ${paths.destination}`
				: `Destination: ${paths.plannedDestination} (not there yet)`,
		});
		if (paths.source) block.createDiv({ text: `Source: ${paths.source}` });
	}

	// The two buttons sit above the two columns: picking one decides which
	// version of this file the publish keeps.
	private renderSideChooser(change: FolderChange, onPick: () => void): () => void {
		const chooser = this.contentEl.createDiv({ cls: 'dns-publishing-choice' });
		const options = SIDE_CHOICES[change.status];
		const buttons = ([
			['destination', options.destination],
			['source', options.source],
		] as const).map(([side, option]) => {
			const button = chooser.createEl('button', { cls: `dns-publishing-choice__side is-${side}` });
			button.createDiv({ cls: 'dns-publishing-choice__title', text: option.title });
			button.createDiv({ cls: 'dns-publishing-choice__desc', text: option.description });
			return { side, button };
		});

		const refresh = (): void => {
			const kept = this.isWhollyKept(change.path);
			for (const { side, button } of buttons) {
				const selected = kept === (side === 'destination');
				button.toggleClass('is-selected', selected);
				button.setAttribute('aria-pressed', String(selected));
			}
		};
		for (const { side, button } of buttons) {
			button.onClickEvent(() => {
				this.setKept(change.path, side === 'destination');
				refresh();
				onPick();
			});
		}
		refresh();
		return refresh;
	}

	/**
	 * Publishing sends the choice outwards; this sends the same choice back into
	 * the note, so a change made at the destination stops reappearing as a diff.
	 */
	private renderPullSetting(change: FolderChange): () => void {
		if (change.status !== 'modified') return () => {};
		const setting = new Setting(this.contentEl)
			.setName('Also update the vault file')
			.setDesc('Write the result back to the note, so the two sides stop differing.');
		let toggleComponent: ToggleComponent | null = null;
		setting.addToggle((toggle) => {
			toggleComponent = toggle;
			toggle
				.setValue(this.pulledPaths.has(change.path))
				.onChange((value) => {
					if (value) this.pulledPaths.add(change.path);
					else this.pulledPaths.delete(change.path);
				});
		});

		return () => {
			const available = this.canPull(change);
			setting.settingEl.toggleClass('is-disabled', !available);
			setting.setDesc(available
				? 'Write the result back to the note, so the two sides stop differing.'
				: 'Nothing to pull: every line here already matches the vault.');
			toggleComponent?.setDisabled(!available);
			if (!available) toggleComponent?.setValue(false);
		};
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
		this.renderDiffPaths(change);
		let repaint = (): void => {};
		let refreshPull = (): void => {};
		const refreshChooser = this.renderSideChooser(change, () => {
			repaint();
			refreshPull();
		});
		refreshPull = this.renderPullSetting(change);
		refreshPull();
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
		if (diff.kind === 'image') {
			body.addClass('dns-publishing-diff--image');
			this.renderImageDiff(body, diff.before, diff.after);
			return;
		}
		if (diff.kind !== 'text') {
			body.createDiv({ cls: 'dns-publishing-diff__note', text: NON_TEXT_NOTES[diff.kind] });
			return;
		}
		body.addClass('dns-publishing-diff--text');
		const text = diff;
		this.loadedDiffs.set(change.path, {
			rows: text.rows,
			hunkCount: text.hunkCount,
			trailingNewline: text.trailingNewline,
		});
		repaint = () => this.paintTextDiff(body, text, change, () => {
			refreshChooser();
			repaint();
		});
		repaint();
	}

	private paintTextDiff(
		body: HTMLElement,
		diff: { rows: DiffRow[]; hunkCount: number },
		change: FolderChange,
		onPick: () => void,
	): void {
		body.empty();
		const header = body.createDiv({ cls: 'dns-publishing-diff__header' });
		header.createSpan({ text: 'Current destination' });
		header.createSpan({ text: 'To be published' });

		const kept = this.keptHunks.get(change.path) ?? new Set<number>();
		let renderedHunk = -1;
		for (const row of diff.rows) {
			if (row.kind === 'gap') {
				body.createDiv({ cls: 'dns-publishing-diff__gap', text: `⋯ ${row.text ?? ''}` });
				continue;
			}
			if (row.kind === 'change' && row.hunk !== undefined && row.hunk !== renderedHunk) {
				renderedHunk = row.hunk;
				this.renderHunkChooser(body, change, row.hunk, diff.hunkCount, kept.has(row.hunk), onPick);
			}
			const side = row.kind === 'change'
				? (kept.has(row.hunk ?? -1) ? ' is-from-destination' : ' is-from-source')
				: '';
			const element = body.createDiv({ cls: `dns-publishing-diff__row is-${row.kind}${side}` });
			renderDiffCell(element, row.before, row.kind === 'change' ? 'remove' : 'context');
			renderDiffCell(element, row.after, row.kind === 'change' ? 'add' : 'context');
		}
	}

	// One picker per run of changed lines, so a file can take its frontmatter
	// from one side and its body from the other.
	private renderHunkChooser(
		body: HTMLElement,
		change: FolderChange,
		hunk: number,
		hunkCount: number,
		kept: boolean,
		onPick: () => void,
	): void {
		const bar = body.createDiv({ cls: 'dns-publishing-hunk' });
		bar.createSpan({
			cls: 'dns-publishing-hunk__label',
			text: `Change ${hunk + 1} of ${hunkCount}`,
		});
		const actions = bar.createDiv({ cls: 'dns-publishing-hunk__actions' });
		for (const [side, label] of [['destination', 'Use left'], ['source', 'Use right']] as const) {
			const button = actions.createEl('button', {
				cls: 'dns-publishing-hunk__button',
				text: label,
			});
			const selected = kept === (side === 'destination');
			button.toggleClass('is-selected', selected);
			button.setAttribute('aria-pressed', String(selected));
			button.onClickEvent(() => {
				this.setHunkKept(change.path, hunk, side === 'destination');
				onPick();
			});
		}
	}
}

interface SideChoice {
	title: string;
	description: string;
}

const SIDE_CHOICES: Record<FolderChange['status'], { destination: SideChoice; source: SideChoice }> = {
	added: {
		destination: { title: 'Keep the destination', description: 'Not present there — leave the file out.' },
		source: { title: 'Publish this file', description: 'Add it to the destination.' },
	},
	modified: {
		destination: { title: 'Keep the destination version', description: 'Leave the published file untouched.' },
		source: { title: 'Publish this version', description: 'Replace the file, or pick a side per change below.' },
	},
	removed: {
		destination: { title: 'Keep the destination file', description: 'It is gone from the vault, but stays published.' },
		source: { title: 'Delete from the destination', description: 'Remove the published file too.' },
	},
};

const NON_TEXT_NOTES: Record<'binary' | 'too-large' | 'identical', string> = {
	binary: 'This is a binary file, so no line diff is shown.',
	'too-large': 'This file is too large to diff.',
	identical: 'The file contents are identical.',
};

function renderDiffCell(
	row: HTMLElement,
	cell: DiffCell | null,
	tone: 'context' | 'add' | 'remove',
): void {
	const side = row.createDiv({ cls: `dns-publishing-diff__cell is-${cell ? tone : 'empty'}` });
	side.createSpan({ cls: 'dns-publishing-diff__gutter', text: cell ? String(cell.line) : '' });
	side.createSpan({ cls: 'dns-publishing-diff__text', text: cell?.text ?? '' });
}

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
