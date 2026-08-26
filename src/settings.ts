import {
	App,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingGroupItem,
	type SliderComponent,
	type TextComponent,
} from 'obsidian';
import type DnsToolkitPlugin from './main';

export interface DnsToolkitSettings {
	enableCustomContainers: boolean;
	defaultType: string;
	enableTypography: boolean;
	fontSize: number;
	letterSpacing: number;
	wordSpacing: number;
	lineHeight: number;
	paragraphSpacing: number;
	enableEditingTypography: boolean;
	editingFontSize: number;
	editingLetterSpacing: number;
	editingWordSpacing: number;
	editingLineHeight: number;
	editingParagraphSpacing: number;
}

export const DEFAULT_SETTINGS: DnsToolkitSettings = {
	enableCustomContainers: true,
	defaultType: 'note',
	enableTypography: false,
	fontSize: 16,
	letterSpacing: 0,
	wordSpacing: 0,
	lineHeight: 1.6,
	paragraphSpacing: 1,
	enableEditingTypography: false,
	editingFontSize: 16,
	editingLetterSpacing: 0,
	editingWordSpacing: 0,
	editingLineHeight: 1.6,
	editingParagraphSpacing: 1,
};

const SUPPORTED_BLOCKS = [
	{ type: 'lead', description: 'Opening introduction' },
	{ type: 'epigraph', description: 'Quotation or epigraph' },
	{ type: 'poem', description: 'Verse with stanza spacing' },
	{ type: 'aside', description: 'Supporting note or context' },
	{ type: 'imgcap', description: 'Image caption' },
	{ type: 'compnote', description: 'Closing composition note' },
] as const;

export class DnsToolkitSettingTab extends PluginSettingTab {
	private activeSection: 'containers' | 'typography' = 'containers';
	private activeTypographyView: 'reading' | 'editing' = 'reading';

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
							name: `:::${block.type}`,
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
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case 'enableCustomContainers':
			case 'enableTypography':
			case 'enableEditingTypography':
				if (typeof value !== 'boolean') return;
				this.plugin.settings[key] = value;
				break;
			case 'defaultType':
				if (typeof value !== 'string' || !value.trim()) return;
				this.plugin.settings.defaultType = value.trim();
				break;
			case 'fontSize':
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
		if (key === 'enableCustomContainers') {
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

		this.renderContainerSettings();
	}

	private renderSectionNavigation(): void {
		const navigation = this.containerEl.createDiv({
			cls: 'dns-settings-navigation',
		});
		for (const section of [
			{ id: 'containers' as const, label: 'Colon blocks' },
			{ id: 'typography' as const, label: 'Page typography' },
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
			item.createEl('code', { text: `:::${block.type}` });
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

		this.addTypographySlider('Font size', 'Base reading size in pixels.', 'fontSize', 12, 24, 0.5);
		this.addTypographySlider('Letter spacing', 'Space between characters in em.', 'letterSpacing', -0.05, 0.15, 0.005);
		this.addTypographySlider('Word spacing', 'Additional space between words in em.', 'wordSpacing', -0.1, 0.5, 0.01);
		this.addTypographySlider('Line height', 'Vertical rhythm within paragraphs.', 'lineHeight', 1.2, 2.4, 0.05);
		this.addTypographySlider('Paragraph spacing', 'Space after ordinary paragraphs in em.', 'paragraphSpacing', 0.25, 2.5, 0.05);
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

		this.addTypographySlider('Font size', 'Base editor size in pixels.', 'editingFontSize', 12, 24, 0.5);
		this.addTypographySlider('Letter spacing', 'Space between characters in em.', 'editingLetterSpacing', -0.05, 0.15, 0.005);
		this.addTypographySlider('Word spacing', 'Additional space between words in em.', 'editingWordSpacing', -0.1, 0.5, 0.01);
		this.addTypographySlider('Line height', 'Vertical rhythm within editor lines.', 'editingLineHeight', 1.2, 2.4, 0.05);
		this.addTypographySlider('Paragraph spacing', 'Space after editor paragraphs in em.', 'editingParagraphSpacing', 0, 2.5, 0.05);
	}

	private addTypographySlider(
		name: string,
		description: string,
		key: 'fontSize' | 'letterSpacing' | 'wordSpacing' | 'lineHeight' | 'paragraphSpacing'
			| 'editingFontSize' | 'editingLetterSpacing' | 'editingWordSpacing'
			| 'editingLineHeight' | 'editingParagraphSpacing',
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
	): () => void {
		let sliderComponent: SliderComponent | null = null;
		let numberComponent: TextComponent | null = null;
		let removeSliderListener = (): void => {};
		const applyValue = (value: number): void => {
			if (!Number.isFinite(value) || value < minimum || value > maximum) return;
			this.plugin.settings[key] = value;
			this.plugin.applyTypographySettings();
		};
		setting.addText((text) => {
			numberComponent = text;
			text.inputEl.type = 'number';
			text.inputEl.min = String(minimum);
			text.inputEl.max = String(maximum);
			text.inputEl.step = String(step);
			text.inputEl.addClass('dns-typography-number');
			text.setValue(String(this.plugin.settings[key])).onChange(async (rawValue) => {
				const value = Number(rawValue);
				applyValue(value);
				sliderComponent?.setValue(value);
				await this.plugin.saveSettings();
			});
		});
		const onSliderInput = (event: Event): void => {
			if (!(event.currentTarget instanceof HTMLInputElement)) return;
			const value = Number(event.currentTarget.value);
			applyValue(value);
			numberComponent?.setValue(String(value));
		};
		setting.addSlider((slider) => {
			sliderComponent = slider;
			slider.sliderEl.addEventListener('input', onSliderInput);
			removeSliderListener = () => slider.sliderEl.removeEventListener('input', onSliderInput);
			slider
					.setLimits(minimum, maximum, step)
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value;
						numberComponent?.setValue(String(value));
						this.plugin.applyTypographySettings();
						await this.plugin.saveSettings();
					});
		});
		setting.addExtraButton((button) =>
			button
				.setIcon('rotate-ccw')
				.setTooltip(`Reset ${setting.nameEl.textContent?.toLowerCase() ?? 'value'}`)
				.onClick(async () => {
					const defaultValue = DEFAULT_SETTINGS[key];
					this.plugin.settings[key] = defaultValue;
					numberComponent?.setValue(String(defaultValue));
					sliderComponent?.setValue(defaultValue);
					this.plugin.applyTypographySettings();
					await this.plugin.saveSettings();
				}),
		);
		return () => {
			removeSliderListener();
		};
	}
}

type TypographyNumberKey = Exclude<keyof DnsToolkitSettings,
	'enableCustomContainers' | 'defaultType' | 'enableTypography' | 'enableEditingTypography'>;
