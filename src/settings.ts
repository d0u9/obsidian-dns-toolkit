import {
	App,
	Platform,
	PluginSettingTab,
	Setting,
	debounce,
	type SettingDefinitionItem,
	type SettingGroupItem,
	type SliderComponent,
	type TextComponent,
} from 'obsidian';
import { SUPPORTED_BLOCKS, blockExample } from './blocks';
import type DnsToolkitPlugin from './main';
import { applyVariables, typographyVariables } from './typography';

export interface DnsToolkitSettings {
	enableCustomContainers: boolean;
	enableEditorColonBlocks: boolean;
	defaultType: string;
	enableTypography: boolean;
	fontFamily: string;
	fontSize: number;
	lineWidth: number;
	letterSpacing: number;
	wordSpacing: number;
	lineHeight: number;
	paragraphSpacing: number;
	enableEditingTypography: boolean;
	editingFontFamily: string;
	editingFontSize: number;
	editingLineWidth: number;
	editingLetterSpacing: number;
	editingWordSpacing: number;
	editingLineHeight: number;
	editingParagraphSpacing: number;
	enableFolderPublishing: boolean;
	publishingSourceFolder: string;
	publishingTargetFolder: string;
}

export const DEFAULT_SETTINGS: DnsToolkitSettings = {
	enableCustomContainers: true,
	enableEditorColonBlocks: true,
	defaultType: 'note',
	enableTypography: false,
	fontFamily: '',
	fontSize: 16,
	lineWidth: 700,
	letterSpacing: 0,
	wordSpacing: 0,
	lineHeight: 1.6,
	paragraphSpacing: 1,
	enableEditingTypography: false,
	editingFontFamily: '',
	editingFontSize: 16,
	editingLineWidth: 700,
	editingLetterSpacing: 0,
	editingWordSpacing: 0,
	editingLineHeight: 1.6,
	editingParagraphSpacing: 1,
	enableFolderPublishing: false,
	publishingSourceFolder: 'publish',
	publishingTargetFolder: '',
};


// The value lands in a CSS custom property, so anything that could close the
// declaration is dropped rather than trusted.
export function sanitizeFontFamily(value: string): string {
	return value.replace(/[;{}]/g, '').trim();
}

// A path copied out of a terminal arrives shell-escaped ("Doug\\ Su"), which
// resolves to a folder that does not exist and makes every file look new.
export function normalizePublishingTarget(value: string): string {
	let path = value.trim();
	const quote = path.charAt(0);
	if (path.length > 1 && (quote === '"' || quote === "'") && path.endsWith(quote)) {
		path = path.slice(1, -1);
	}
	// Backslash is a path separator on Windows, so only unescape elsewhere.
	if (!Platform.isWin) path = path.replace(/\\(?=[^A-Za-z0-9])/g, '');
	return path.replace(/[\\/]+$/, '') || path;
}

function publishingTargetPlaceholder(): string {
	return Platform.isWin
		? 'C:\\Users\\you\\Documents\\Published Site'
		: '/Users/you/Documents/Published Site';
}

export class DnsToolkitSettingTab extends PluginSettingTab {
	private activeSection: 'containers' | 'typography' | 'publishing' = 'containers';
	private activeTypographyView: 'reading' | 'editing' = 'reading';
	private typographyPreview: HTMLElement | null = null;
	// Dragging a slider repaints on every step; the settings file only needs
	// the value the user settles on.
	private readonly saveSoon = debounce(() => void this.plugin.saveSettings(), 400, true);

	constructor(app: App, private readonly plugin: DnsToolkitPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<keyof DnsToolkitSettings>[] {
		return [
			{
				type: 'page',
				name: 'Colon blocks',
				desc: 'Parse and style Markdown blocks delimited by three colons.',
				items: [
					{
						name: 'Enable',
						desc: 'Render custom containers in reading view.',
						control: {
							type: 'toggle',
							key: 'enableCustomContainers',
							defaultValue: DEFAULT_SETTINGS.enableCustomContainers,
						},
					},
					{
						name: 'Style blocks while editing',
						desc: 'Shape colon blocks in the editor as well as in reading view.',
						control: {
							type: 'toggle',
							key: 'enableEditorColonBlocks',
							defaultValue: DEFAULT_SETTINGS.enableEditorColonBlocks,
						},
					},
					{
						name: 'Default type',
						desc: 'Used when an opening delimiter does not specify a type.',
						control: {
							type: 'text',
							key: 'defaultType',
							defaultValue: DEFAULT_SETTINGS.defaultType,
							placeholder: 'Note',
							validate: (value) => value.trim() ? undefined : 'Enter a container type.',
						},
					},
					{
						type: 'page',
						name: 'Supported blocks',
						desc: 'Block types with dedicated editorial styles.',
						items: SUPPORTED_BLOCKS.map((block) => ({
							name: blockExample(block),
							desc: block.description,
						})),
					},
				],
			},
			{
				type: 'page',
				name: 'Page typography',
				desc: 'Adjust reading and editing views independently.',
				items: [
					{
						type: 'group',
						heading: 'Reading view',
						items: this.getTypographyDefinitions('reading'),
					},
					{
						type: 'group',
						heading: 'Editing view',
						items: this.getTypographyDefinitions('editing'),
					},
				],
			},
			{
				type: 'page',
				name: 'Folder publishing',
				desc: 'Copy one direct subfolder from the vault to a folder outside the vault. Desktop only.',
				items: [
					{
						name: 'Enable',
						desc: 'Enable the folder publishing command.',
						control: {
							type: 'toggle',
							key: 'enableFolderPublishing',
							defaultValue: DEFAULT_SETTINGS.enableFolderPublishing,
						},
					},
					{
						name: 'Source folder',
						desc: 'Vault-relative folder whose direct subfolders can be published, for example publish.',
						control: {
							type: 'text',
							key: 'publishingSourceFolder',
							defaultValue: DEFAULT_SETTINGS.publishingSourceFolder,
							placeholder: 'publish',
							validate: (value) => value.trim() ? undefined : 'Enter a source folder.',
						},
					},
					{
						name: 'Final publishing folder',
						desc: 'Absolute path to a folder outside this vault. The selected folder name is preserved.',
						control: {
							type: 'text',
							key: 'publishingTargetFolder',
							defaultValue: DEFAULT_SETTINGS.publishingTargetFolder,
							placeholder: publishingTargetPlaceholder(),
							validate: (value) => value.trim() ? undefined : 'Enter a destination folder.',
						},
					},
					{
						name: 'Publish a folder',
						desc: 'Run “Publish folder to final publishing folder”, choose a direct subfolder, then confirm the copy.',
					},
				],
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case 'enableCustomContainers':
			case 'enableEditorColonBlocks':
			case 'enableTypography':
			case 'enableEditingTypography':
			case 'enableFolderPublishing':
				if (typeof value !== 'boolean') return;
				this.plugin.settings[key] = value;
				break;
			case 'fontFamily':
			case 'editingFontFamily':
				if (typeof value !== 'string') return;
				this.plugin.settings[key] = sanitizeFontFamily(value);
				break;
			case 'defaultType':
				if (typeof value !== 'string' || !value.trim()) return;
				this.plugin.settings.defaultType = value.trim();
				break;
			case 'publishingSourceFolder':
				if (typeof value !== 'string') return;
				this.plugin.settings.publishingSourceFolder = value.trim();
				break;
			case 'publishingTargetFolder':
				if (typeof value !== 'string') return;
				this.plugin.settings.publishingTargetFolder = normalizePublishingTarget(value);
				break;
			case 'fontSize':
			case 'lineWidth':
			case 'editingLineWidth':
			case 'letterSpacing':
			case 'wordSpacing':
			case 'lineHeight':
			case 'paragraphSpacing':
			case 'editingFontSize':
			case 'editingLetterSpacing':
			case 'editingWordSpacing':
			case 'editingLineHeight':
			case 'editingParagraphSpacing':
				if (typeof value !== 'number' || !Number.isFinite(value)) return;
				this.plugin.settings[key] = value;
				break;
			default:
				return;
		}
		if (key === 'fontFamily' || key === 'editingFontFamily') {
			this.plugin.applyTypographySettings();
			await this.plugin.saveSettings();
			return;
		}
		if (key === 'enableCustomContainers' || key === 'enableEditorColonBlocks') {
			this.plugin.refreshCustomContainers();
		} else if (key !== 'defaultType') {
			this.plugin.applyTypographySettings();
		}
		await this.plugin.saveSettings();
	}

	private getTypographyDefinitions(
		view: 'reading' | 'editing',
	): SettingGroupItem<keyof DnsToolkitSettings>[] {
		const editing = view === 'editing';
		const key = <K extends keyof DnsToolkitSettings>(
			readingKey: K,
			editingKey: keyof DnsToolkitSettings,
		): keyof DnsToolkitSettings => editing ? editingKey : readingKey;
		return [
			{
				name: 'Enable',
				desc: `Override typography in Markdown ${editing ? 'editing' : 'reading'} view.`,
				control: {
					type: 'toggle',
					key: key('enableTypography', 'enableEditingTypography'),
					defaultValue: editing
						? DEFAULT_SETTINGS.enableEditingTypography
						: DEFAULT_SETTINGS.enableTypography,
				},
			},
			...([
				['Font size', `Base ${view} size in pixels.`, 'fontSize', 'editingFontSize', 12, 24, 0.5],
				['Line width', 'Width of the text column in pixels, when readable line length is on.', 'lineWidth', 'editingLineWidth', 400, 1400, 10],
				['Letter spacing', 'Space between characters in em.', 'letterSpacing', 'editingLetterSpacing', -0.05, 0.15, 0.005],
				['Word spacing', 'Additional space between words in em.', 'wordSpacing', 'editingWordSpacing', -0.1, 0.5, 0.01],
				['Line height', 'Vertical rhythm within paragraphs.', 'lineHeight', 'editingLineHeight', 1.2, 2.4, 0.05],
				['Paragraph spacing', 'Space after ordinary paragraphs in em.', 'paragraphSpacing', 'editingParagraphSpacing', editing ? 0 : 0.25, 2.5, 0.05],
			] as const).map(([name, desc, readingKey, editingKey, min, max, step]) => ({
				name,
				desc,
				render: (setting: Setting) => this.addTypographyControls(
					setting,
					key(readingKey, editingKey) as TypographyNumberKey,
					min,
					max,
					step,
				),
			})),
		];
	}

	display(): void {
		this.renderActiveSection();
	}

	private renderActiveSection(): void {
		this.containerEl.empty();
		this.renderSectionNavigation();

		if (this.activeSection === 'typography') {
			this.renderTypographySettings();
			return;
		}
		if (this.activeSection === 'publishing') {
			this.renderPublishingSettings();
			return;
		}

		this.renderContainerSettings();
	}

	private renderSectionNavigation(): void {
		const navigation = this.containerEl.createDiv({
			cls: 'dns-settings-navigation',
		});
		for (const section of [
			{ id: 'containers' as const, label: 'Colon blocks' },
			{ id: 'typography' as const, label: 'Page typography' },
			{ id: 'publishing' as const, label: 'Folder publishing' },
		]) {
			const button = navigation.createEl('button', {
				cls: 'dns-settings-navigation__item',
				text: section.label,
			});
			button.toggleClass('is-active', this.activeSection === section.id);
			button.setAttribute(
				'aria-pressed',
				String(this.activeSection === section.id),
			);
			button.onClickEvent(() => {
				this.activeSection = section.id;
				this.renderActiveSection();
			});
		}
	}

	private renderPublishingSettings(): void {
		new Setting(this.containerEl)
			.setName('Folder publishing')
			.setDesc('Copy one direct subfolder from the vault to a folder outside the vault. Desktop only.')
			.setHeading();

		new Setting(this.containerEl)
			.setName('Enable')
			.setDesc('Enable the folder publishing command.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableFolderPublishing)
				.onChange(async (value) => {
					this.plugin.settings.enableFolderPublishing = value;
					await this.plugin.saveSettings();
				}));

		new Setting(this.containerEl)
			.setName('Source folder')
			.setDesc('Vault-relative folder whose direct subfolders can be published, for example publish.')
			.addText((text) => text
				.setPlaceholder('Publish')
				.setValue(this.plugin.settings.publishingSourceFolder)
				.onChange(async (value) => {
					this.plugin.settings.publishingSourceFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(this.containerEl)
			.setName('Final publishing folder')
			.setDesc('Absolute path to a folder outside this vault. The selected folder name is preserved.')
			.addText((text) => {
				text.inputEl.addClass('dns-publishing-path');
				text
					.setPlaceholder(publishingTargetPlaceholder())
					.setValue(this.plugin.settings.publishingTargetFolder)
					.onChange(async (value) => {
						this.plugin.settings.publishingTargetFolder = normalizePublishingTarget(value);
						await this.plugin.saveSettings();
					});
					text.inputEl.addEventListener('blur', () => {
						text.setValue(this.plugin.settings.publishingTargetFolder);
					});
			});

		new Setting(this.containerEl)
			.setName('Publish')
			.setDesc('Choose a direct subfolder with the publishing command, then confirm. An existing folder with the same name is replaced safely.');
	}

	private renderContainerSettings(): void {
		new Setting(this.containerEl)
			.setName('Colon blocks')
			.setDesc('Parse and style Markdown blocks delimited by three colons.')
			.setHeading();

		new Setting(this.containerEl)
			.setName('Enable')
			.setDesc('Render custom containers in reading view.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableCustomContainers)
					.onChange(async (value) => {
						this.plugin.settings.enableCustomContainers = value;
						await this.plugin.saveSettings();
						this.plugin.refreshCustomContainers();
					}),
			);

		new Setting(this.containerEl)
			.setName('Style blocks while editing')
			.setDesc('Shape colon blocks in the editor as well as in reading view.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableEditorColonBlocks)
					.onChange(async (value) => {
						this.plugin.settings.enableEditorColonBlocks = value;
						await this.plugin.saveSettings();
						this.plugin.refreshCustomContainers();
					}),
			);

		new Setting(this.containerEl)
			.setName('Default type')
			.setDesc('Used when an opening delimiter does not specify a type.')
			.addText((text) =>
				text
					.setPlaceholder('Note')
					.setValue(this.plugin.settings.defaultType)
					.onChange(async (value) => {
						this.plugin.settings.defaultType = value.trim() || 'note';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(this.containerEl)
			.setName('Supported blocks')
			.setDesc('These block types include dedicated editorial styles.')
			.setHeading();

		const blockList = this.containerEl.createDiv({ cls: 'dns-colon-block-list' });
		for (const block of SUPPORTED_BLOCKS) {
			const item = blockList.createDiv({ cls: 'dns-colon-block-list__item' });
			item.createEl('code', { text: blockExample(block) });
			item.createSpan({ text: block.description });
		}
	}

	private renderTypographySettings(): void {
		new Setting(this.containerEl)
			.setName('Page typography')
			.setDesc('Adjust reading and editing views independently.')
			.setHeading();

		const viewNavigation = this.containerEl.createDiv({
			cls: 'dns-settings-navigation dns-settings-navigation--secondary',
		});
		for (const view of [
			{ id: 'reading' as const, label: 'Reading view' },
			{ id: 'editing' as const, label: 'Editing view' },
		]) {
			const button = viewNavigation.createEl('button', {
				cls: 'dns-settings-navigation__item',
				text: view.label,
			});
			button.toggleClass('is-active', this.activeTypographyView === view.id);
			button.onClickEvent(() => {
				this.activeTypographyView = view.id;
				this.renderActiveSection();
			});
		}

		this.renderTypographyPreview();

		new Setting(this.containerEl)
			.setName(this.activeTypographyView === 'reading' ? 'Reading view' : 'Editing view')
			.setHeading();

		if (this.activeTypographyView === 'editing') {
			this.renderEditingTypographySettings();
			return;
		}

		new Setting(this.containerEl)
			.setName('Enable')
			.setDesc('Override typography in Markdown reading view.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableTypography)
					.onChange(async (value) => {
						this.plugin.settings.enableTypography = value;
						this.plugin.applyTypographySettings();
						await this.plugin.saveSettings();
					}),
			);

		this.addFontFamilySetting('fontFamily');
		this.addTypographySlider('Font size', 'Base reading size in pixels.', 'fontSize', 12, 24, 0.5);
		this.addTypographySlider('Line width', 'Width of the text column in pixels, when readable line length is on.', 'lineWidth', 400, 1400, 10);
		this.addTypographySlider('Letter spacing', 'Space between characters in em.', 'letterSpacing', -0.05, 0.15, 0.005);
		this.addTypographySlider('Word spacing', 'Additional space between words in em.', 'wordSpacing', -0.1, 0.5, 0.01);
		this.addTypographySlider('Line height', 'Vertical rhythm within paragraphs.', 'lineHeight', 1.2, 2.4, 0.05);
		this.addTypographySlider('Paragraph spacing', 'Space after ordinary paragraphs in em.', 'paragraphSpacing', 0.25, 2.5, 0.05);
		this.renderTypographyResetAll(
			['fontSize', 'lineWidth', 'letterSpacing', 'wordSpacing', 'lineHeight', 'paragraphSpacing'],
			'fontFamily',
		);
	}

	// The settings modal covers the workspace, so the values are mirrored onto a
	// sample here: it is the only way to see a change while dragging a slider.
	private renderTypographyPreview(): void {
		const preview = this.containerEl.createDiv({ cls: 'dns-typography-preview' });
		preview.createDiv({
			cls: 'dns-typography-preview__label',
			text: this.activeTypographyView === 'reading' ? 'Reading view preview' : 'Editing view preview',
		});
		const sample = preview.createDiv({ cls: 'dns-typography-preview__sample' });
		sample.createDiv({ cls: 'dns-typography-preview__heading', text: PREVIEW_HEADING });
		sample.createEl('p', { text: PREVIEW_PARAGRAPHS[0] });
		sample.createEl('blockquote', { text: PREVIEW_QUOTE });
		sample.createEl('p', { text: PREVIEW_PARAGRAPHS[1] });
		this.typographyPreview = sample;
		this.applyTypographyPreview();
	}

	private applyTypographyPreview(): void {
		if (!this.typographyPreview) return;
		applyVariables(
			this.typographyPreview,
			typographyVariables(this.plugin.settings, this.activeTypographyView, '--dns-'),
		);
	}

	private addFontFamilySetting(key: 'fontFamily' | 'editingFontFamily'): void {
		new Setting(this.containerEl)
			.setName('Font family')
			.setDesc('A CSS font stack. Leave empty to follow the theme.')
			.addText((text) => {
				text.inputEl.addClass('dns-typography-font');
				text
					.setPlaceholder('"Source Han Serif SC", Georgia, serif')
					.setValue(this.plugin.settings[key])
					.onChange((value) => {
						this.plugin.settings[key] = sanitizeFontFamily(value);
						this.plugin.applyTypographySettings();
						this.applyTypographyPreview();
						this.saveSoon();
					});
			});
	}

	private renderTypographyResetAll(
		keys: TypographyNumberKey[],
		fontKey: 'fontFamily' | 'editingFontFamily',
	): void {
		new Setting(this.containerEl)
			.setName('Reset this view')
			.setDesc('Restore every value above to its default.')
			.addButton((button) => button
				.setIcon('rotate-ccw')
				.setTooltip('Reset this view')
				.onClick(async () => {
					for (const key of keys) this.plugin.settings[key] = DEFAULT_SETTINGS[key];
					this.plugin.settings[fontKey] = DEFAULT_SETTINGS[fontKey];
					this.plugin.applyTypographySettings();
					await this.plugin.saveSettings();
					this.renderActiveSection();
				}));
	}

	private renderEditingTypographySettings(): void {
		new Setting(this.containerEl)
			.setName('Enable')
			.setDesc('Override typography in Markdown editing view.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableEditingTypography)
				.onChange(async (value) => {
					this.plugin.settings.enableEditingTypography = value;
					this.plugin.applyTypographySettings();
					await this.plugin.saveSettings();
				}));

		this.addFontFamilySetting('editingFontFamily');
		this.addTypographySlider('Font size', 'Base editor size in pixels.', 'editingFontSize', 12, 24, 0.5);
		this.addTypographySlider('Line width', 'Width of the text column in pixels, when readable line length is on.', 'editingLineWidth', 400, 1400, 10);
		this.addTypographySlider('Letter spacing', 'Space between characters in em.', 'editingLetterSpacing', -0.05, 0.15, 0.005);
		this.addTypographySlider('Word spacing', 'Additional space between words in em.', 'editingWordSpacing', -0.1, 0.5, 0.01);
		this.addTypographySlider('Line height', 'Vertical rhythm within editor lines.', 'editingLineHeight', 1.2, 2.4, 0.05);
		this.addTypographySlider('Paragraph spacing', 'Space after editor paragraphs in em.', 'editingParagraphSpacing', 0, 2.5, 0.05);
		this.renderTypographyResetAll(
			['editingFontSize', 'editingLineWidth', 'editingLetterSpacing', 'editingWordSpacing',
				'editingLineHeight', 'editingParagraphSpacing'],
			'editingFontFamily',
		);
	}

	private addTypographySlider(
		name: string,
		description: string,
		key: TypographyNumberKey,
		minimum: number,
		maximum: number,
		step: number,
	): void {
		const setting = new Setting(this.containerEl)
			.setName(name)
			.setDesc(description);
		this.addTypographyControls(setting, key, minimum, maximum, step);
	}

	private addTypographyControls(
		setting: Setting,
		key: TypographyNumberKey,
		minimum: number,
		maximum: number,
		step: number,
	): void {
		let sliderComponent: SliderComponent | null = null;
		let numberComponent: TextComponent | null = null;
		const applyValue = (value: number): boolean => {
			if (!Number.isFinite(value) || value < minimum || value > maximum) return false;
			this.plugin.settings[key] = value;
			this.plugin.applyTypographySettings();
			this.applyTypographyPreview();
			this.saveSoon();
			return true;
		};

		setting.addText((text) => {
			numberComponent = text;
			text.inputEl.type = 'number';
			text.inputEl.min = String(minimum);
			text.inputEl.max = String(maximum);
			text.inputEl.step = String(step);
			text.inputEl.addClass('dns-typography-number');
			text.setValue(String(this.plugin.settings[key])).onChange((rawValue) => {
				if (rawValue.trim() === '') return;
				const value = Number(rawValue);
				if (!Number.isFinite(value)) return;
				// Out-of-range input is pulled to the nearest end rather than
				// silently ignored, which looked like a dead control.
				const clamped = Math.min(maximum, Math.max(minimum, value));
				applyValue(clamped);
				sliderComponent?.setValue(clamped);
			});
			// Correcting the text mid-typing fights the user, so it is snapped
			// back into range only once the field is left.
			text.inputEl.addEventListener('blur', () => {
				text.setValue(String(this.plugin.settings[key]));
			});
		});
		setting.addSlider((slider) => {
			sliderComponent = slider;
			// The component reports only when the drag ends, so the live value
			// is read from the input event instead (setInstant needs v1.6.6).
			slider.sliderEl.addEventListener('input', () => {
				const value = Number(slider.sliderEl.value);
				applyValue(value);
				numberComponent?.setValue(String(value));
			});
			slider
				.setLimits(minimum, maximum, step)
				.setValue(this.plugin.settings[key])
				.onChange((value) => {
					applyValue(value);
					numberComponent?.setValue(String(value));
				});
		});
		setting.addExtraButton((button) =>
			button
				.setIcon('rotate-ccw')
				.setTooltip(`Reset ${setting.nameEl.textContent?.toLowerCase() ?? 'value'}`)
				.onClick(() => {
					const defaultValue = DEFAULT_SETTINGS[key];
					applyValue(defaultValue);
					numberComponent?.setValue(String(defaultValue));
					sliderComponent?.setValue(defaultValue);
				}),
		);
	}
}

const PREVIEW_HEADING = '示例标题 · Sample heading';
const PREVIEW_QUOTE = '引用与标题跟随同一套字号与行高，便于一并判断。';
const PREVIEW_PARAGRAPHS = [
	'字体大小、字间距与行高会立刻反映在这段示例文字上，无需关闭设置面板。',
	'Drag a slider and this sample updates as you go, so the reading rhythm can be judged before it is applied to a note.',
];

type TypographyNumberKey = Exclude<keyof DnsToolkitSettings,
	'enableCustomContainers' | 'enableEditorColonBlocks' | 'defaultType'
	| 'enableTypography' | 'enableEditingTypography'
	| 'enableFolderPublishing' | 'publishingSourceFolder' | 'publishingTargetFolder'
	| 'fontFamily' | 'editingFontFamily'>;
