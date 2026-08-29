import type { DnsToolkitSettings } from './settings';

export type TypographyView = 'reading' | 'editing';

/**
 * The CSS custom properties one view's typography is expressed as. Units live
 * here alone, so the workspace and the settings preview cannot drift apart.
 */
export function typographyVariables(
	settings: DnsToolkitSettings,
	view: TypographyView,
	prefix: string,
): Record<string, string | null> {
	const editing = view === 'editing';
	const family = editing ? settings.editingFontFamily : settings.fontFamily;
	return {
		[`${prefix}font-family`]: family || null,
		[`${prefix}font-size`]: `${editing ? settings.editingFontSize : settings.fontSize}px`,
		[`${prefix}line-width`]: `${editing ? settings.editingLineWidth : settings.lineWidth}px`,
		[`${prefix}letter-spacing`]: `${editing ? settings.editingLetterSpacing : settings.letterSpacing}em`,
		[`${prefix}word-spacing`]: `${editing ? settings.editingWordSpacing : settings.wordSpacing}em`,
		[`${prefix}line-height`]: String(editing ? settings.editingLineHeight : settings.lineHeight),
		[`${prefix}paragraph-spacing`]: `${editing ? settings.editingParagraphSpacing : settings.paragraphSpacing}em`,
	};
}

export function applyVariables(
	element: HTMLElement,
	variables: Record<string, string | null>,
): void {
	for (const [property, value] of Object.entries(variables)) {
		if (value === null) element.style.removeProperty(property);
		else element.style.setProperty(property, value);
	}
}
