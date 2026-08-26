import { MarkdownView, Notice, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import {
	renderCustomContainers,
	restoreCustomContainers,
} from './render/custom-container';
import {
	DEFAULT_SETTINGS,
	DnsToolkitSettingTab,
	type DnsToolkitSettings,
} from './settings';

export default class DnsToolkitPlugin extends Plugin {
	settings!: DnsToolkitSettings;
	private crossSectionContainerObserver: MutationObserver | null = null;
	private readonly disabledReadingViews = new WeakSet<HTMLElement>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyTypographySettings();

		this.registerMarkdownPostProcessor((element) => {
			if (!this.shouldRenderCustomContainers(element)) return;
			renderCustomContainers(element, this.settings.defaultType);
		});

		registerCommands(this);
		this.addSettingTab(new DnsToolkitSettingTab(this.app, this));
		this.observeCrossSectionContainers();
		this.renderMountedCrossSectionContainers();
	}

	onunload(): void {
		this.crossSectionContainerObserver?.disconnect();
		this.crossSectionContainerObserver = null;
		this.clearTypographySettings();
	}

	private clearTypographySettings(): void {
		const workspace = this.app.workspace.containerEl;
		workspace.removeClasses(['dns-page-typography', 'dns-editor-typography']);
		for (const property of [
			'--dns-font-size',
			'--dns-letter-spacing',
			'--dns-word-spacing',
			'--dns-line-height',
			'--dns-paragraph-spacing',
			'--dns-editing-font-size',
			'--dns-editing-letter-spacing',
			'--dns-editing-word-spacing',
			'--dns-editing-line-height',
			'--dns-editing-paragraph-spacing',
		]) {
			workspace.style.removeProperty(property);
		}
	}

	private hasCrossSectionContainer(preview: HTMLElement): boolean {
		return Array.from(preview.querySelectorAll('p')).some((paragraph) =>
			/^:::\s*(?:poem|aside)(?:\s|$)/i.test(paragraph.textContent?.trim() ?? ''),
		);
	}

	private observeCrossSectionContainers(): void {
		this.crossSectionContainerObserver = new MutationObserver((mutations) => {
			if (!this.settings.enableCustomContainers) return;
			const previews = new Set<HTMLElement>();
			for (const mutation of mutations) {
				const mutationElement = mutation.target.instanceOf(HTMLElement)
					? mutation.target
					: mutation.target.parentElement;
				const mutationPreview = mutationElement?.closest<HTMLElement>(
					'.markdown-preview-sizer',
				);
				if (
					mutationPreview &&
					this.hasCrossSectionContainer(mutationPreview)
				) {
					previews.add(mutationPreview);
				}
				if (mutation.type === 'characterData') {
					const preview = mutation.target.parentElement?.closest<HTMLElement>(
						'.markdown-preview-sizer',
					);
					if (preview && this.hasCrossSectionContainer(preview)) {
						previews.add(preview);
					}
				}
				for (const node of Array.from(mutation.addedNodes)) {
					if (!node.instanceOf(HTMLElement)) continue;
					const preview = node.closest<HTMLElement>('.markdown-preview-sizer');
					if (preview && this.hasCrossSectionContainer(preview)) {
						previews.add(preview);
					}
				}
			}

			for (const preview of previews) {
				if (!this.shouldRenderCustomContainers(preview)) continue;
				this.renderPreviewContainers(preview);
			}
		});
		this.crossSectionContainerObserver.observe(this.app.workspace.containerEl, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	}

	private shouldRenderCustomContainers(element: HTMLElement): boolean {
		if (!this.settings.enableCustomContainers) return false;
		const readingView = element.closest<HTMLElement>('.markdown-preview-view');
		return readingView === null || !this.disabledReadingViews.has(readingView);
	}

	private renderPreviewContainers(preview: HTMLElement): void {
		for (const section of Array.from(
			preview.querySelectorAll<HTMLElement>('.markdown-preview-section'),
		)) {
			renderCustomContainers(section, this.settings.defaultType);
		}
		for (const block of Array.from(
			preview.querySelectorAll<HTMLElement>('.el-p'),
		)) {
			renderCustomContainers(block, this.settings.defaultType);
		}
		renderCustomContainers(preview, this.settings.defaultType);
	}

	toggleColonBlocksInActiveReadingView(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view === null || view.getMode() !== 'preview') {
			new Notice('Open a Markdown note in reading view first.');
			return;
		}
		if (!this.settings.enableCustomContainers) {
			new Notice('Enable colon blocks in the plugin settings first.');
			return;
		}

		const readingView = view.previewMode.containerEl;
		const preview = readingView.querySelector<HTMLElement>('.markdown-preview-sizer');
		if (this.disabledReadingViews.has(readingView)) {
			this.disabledReadingViews.delete(readingView);
			if (preview !== null) this.renderPreviewContainers(preview);
			new Notice('Colon blocks enabled in this reading view.');
			return;
		}

		this.disabledReadingViews.add(readingView);
		if (preview !== null) restoreCustomContainers(preview);
		new Notice('Colon blocks disabled in this reading view.');
	}

	private renderMountedCrossSectionContainers(): void {
		if (!this.settings.enableCustomContainers) return;
		for (const preview of Array.from(
			this.app.workspace.containerEl.querySelectorAll<HTMLElement>(
				'.markdown-preview-sizer',
			),
		)) {
			if (
				this.shouldRenderCustomContainers(preview) &&
				this.hasCrossSectionContainer(preview)
			) {
				this.renderPreviewContainers(preview);
			}
		}
	}

	refreshCustomContainers(): void {
		for (const preview of Array.from(
			this.app.workspace.containerEl.querySelectorAll<HTMLElement>(
				'.markdown-preview-sizer',
			),
		)) {
			const readingView = preview.closest<HTMLElement>('.markdown-preview-view');
			if (
				this.settings.enableCustomContainers &&
				(readingView === null || !this.disabledReadingViews.has(readingView))
			) {
				this.renderPreviewContainers(preview);
			} else {
				restoreCustomContainers(preview);
			}
		}
	}

	applyTypographySettings(): void {
		const workspace = this.app.workspace.containerEl;
		workspace.toggleClass('dns-page-typography', this.settings.enableTypography);
		workspace.toggleClass('dns-editor-typography', this.settings.enableEditingTypography);

		const values: Record<string, string | null> = {
			'--dns-font-size': this.settings.enableTypography ? `${this.settings.fontSize}px` : null,
			'--dns-letter-spacing': this.settings.enableTypography ? `${this.settings.letterSpacing}em` : null,
			'--dns-word-spacing': this.settings.enableTypography ? `${this.settings.wordSpacing}em` : null,
			'--dns-line-height': this.settings.enableTypography ? String(this.settings.lineHeight) : null,
			'--dns-paragraph-spacing': this.settings.enableTypography ? `${this.settings.paragraphSpacing}em` : null,
			'--dns-editing-font-size': this.settings.enableEditingTypography ? `${this.settings.editingFontSize}px` : null,
			'--dns-editing-letter-spacing': this.settings.enableEditingTypography ? `${this.settings.editingLetterSpacing}em` : null,
			'--dns-editing-word-spacing': this.settings.enableEditingTypography ? `${this.settings.editingWordSpacing}em` : null,
			'--dns-editing-line-height': this.settings.enableEditingTypography ? String(this.settings.editingLineHeight) : null,
			'--dns-editing-paragraph-spacing': this.settings.enableEditingTypography ? `${this.settings.editingParagraphSpacing}em` : null,
		};
		for (const [property, value] of Object.entries(values)) {
			if (value === null) workspace.style.removeProperty(property);
			else workspace.style.setProperty(property, value);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<DnsToolkitSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
