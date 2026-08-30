const DELIMITER = /^(:{3,})\s*(?:([a-zA-Z][a-zA-Z0-9_-]*)(?:\{([^}]*)\})?(?:\s+(.+))?)?\s*$/;
const CLOSING_DELIMITER = /^(:{3,})\s*$/;
const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);
const LENGTH_ATTRIBUTES = new Set(['height', 'width', 'max-width', 'min-height']);
const TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const HEIGHT_PATTERN = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|vh|vw|vmin|vmax|%))$/i;
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

interface OpeningDelimiter {
	fence: number;
	type: string;
	title?: string;
	attributes: Map<string, string>;
	classes: string[];
	raw?: string;
}

const ADJACENCY_CLASSES = ['dns-before-imgcap', 'dns-before-compnote'] as const;
const PREVIEW_CHROME = '.markdown-preview-pusher, .mod-header, .mod-footer';
const LIST_DELIMITER_CLASS = 'dns-list-delimiter';

/** Elements that end the line of rendered text they hold. */
const LINE_TAGS = new Set([
	'P', 'DIV', 'LI', 'OL', 'UL', 'HR', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR',
	'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** Block types whose cross-section marker fully owns their rendering. */
const SEGMENT_ONLY_TYPES = ['poem', 'aside', 'epigraph', 'lead'] as const;

/** Block types Obsidian may split across several rendering sections. */
const SEGMENT_TYPES = [...SEGMENT_ONLY_TYPES, 'imgcap'] as const;

const CROSS_SECTION_DELIMITER = new RegExp(`:::\\s*(?:${SEGMENT_TYPES.join('|')})`, 'i');

/** Whether rendered text holds a delimiter the cross-section marker owns. */
export function containsCrossSectionDelimiter(text: string): boolean {
	return CROSS_SECTION_DELIMITER.test(text);
}

/** Carried by every segment so one rule can style all of their bodies. */
const SEGMENT_CLASS = 'dns-segment';
const SEGMENT_CLASSES = [
	...SEGMENT_TYPES.flatMap((type) => [
		`dns-${type}-segment`,
		`dns-${type}-segment--first`,
		`dns-${type}-segment--last`,
		`dns-${type}-delimiter`,
	]),
	'dns-poem-segment--cjk',
	SEGMENT_CLASS,
];
const SEGMENT_SELECTOR = SEGMENT_CLASSES.map((name) => `.${name}`).join(',');

function clearAdjacencyClasses(root: HTMLElement): void {
	root.querySelectorAll(ADJACENCY_CLASSES.map((name) => `.${name}`).join(',')).forEach(
		(element) => element.removeClasses([...ADJACENCY_CLASSES]),
	);
}

export function containsCjk(text: string): boolean {
	return CJK_PATTERN.test(text);
}

function clearSegmentClasses(root: HTMLElement): void {
	root.querySelectorAll(SEGMENT_SELECTOR).forEach((element) =>
		element.removeClasses(SEGMENT_CLASSES),
	);
}

function isBlankNode(node: ChildNode | undefined): boolean {
	return (
		node !== undefined &&
		node.nodeType === Node.TEXT_NODE &&
		!(node.textContent ?? '').trim()
	);
}

function lastMeaningfulIndex(nodes: ChildNode[]): number {
	let index = nodes.length - 1;
	while (index >= 0 && isBlankNode(nodes[index])) index -= 1;
	return index;
}

/** Rendered text with a newline wherever the layout starts a new line. */
function linedText(node: Node): string {
	if (node.instanceOf(Text)) return node.data;
	if (!node.instanceOf(HTMLElement)) return '';
	if (node.instanceOf(HTMLBRElement)) return '\n';
	const inner = Array.from(node.childNodes).map(linedText).join('');
	return LINE_TAGS.has(node.tagName) ? `\n${inner}\n` : inner;
}

/**
 * The one line an element shows, or null when it shows several. A compact block
 * keeps its lines inside a single element — as `<br>`s, or as the paragraphs
 * the compact split leaves behind — and `textContent` joins them with nothing
 * in between. `:::poem` followed by an English line then reads as the type
 * `poemA` with a title, while a CJK line only stops the pattern from matching.
 */
function singleLine(element: HTMLElement): string | null {
	const lines = linedText(element)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.length === 1 ? (lines[0] ?? null) : null;
}

/** Reads an element that holds nothing but a delimiter line. */
function delimiterRole(element: HTMLElement): string | null {
	const text = singleLine(element);
	if (text === null) return null;
	if (CLOSING_DELIMITER.test(text)) return 'close';
	// Group 2 is the type; group 1 is the fence itself.
	return text.match(DELIMITER)?.[2]?.toLowerCase() ?? null;
}

/** The ancestor of `element` that sits directly inside the preview section. */
function topLevelBlockOf(element: HTMLElement, root: HTMLElement): HTMLElement | null {
	let current: HTMLElement | null = element;
	while (current?.parentElement && current.parentElement !== root) {
		current = current.parentElement;
	}
	return current?.parentElement === root ? current : null;
}

/**
 * CommonMark folds a delimiter line that directly follows a list item into that
 * item, so `:::` never becomes a sibling block. Wrap it in a marker span the
 * cross-section matcher can locate — and hide once the block is matched.
 */
function markListDelimiters(root: HTMLElement): void {
	for (const item of Array.from(root.querySelectorAll<HTMLElement>('li'))) {
		const children = Array.from(item.childNodes);
		const tail = children[lastMeaningfulIndex(children)];
		const host = tail?.instanceOf(HTMLParagraphElement) ? tail : item;
		if (host.querySelector(`:scope > .${LIST_DELIMITER_CLASS}`)) continue;

		const nodes = Array.from(host.childNodes);
		const end = lastMeaningfulIndex(nodes);
		const last = nodes[end];
		if (!last?.instanceOf(Text)) continue;

		const text = last.data;
		const newline = text.lastIndexOf('\n');
		const line = (newline >= 0 ? text.slice(newline + 1) : text).trim();
		if (!line.startsWith(':::')) continue;
		const type = CLOSING_DELIMITER.test(line) ? 'close' : line.match(DELIMITER)?.[2]?.toLowerCase();
		const known = SEGMENT_TYPES.some((name) => name === type);
		if (type !== 'close' && !known) continue;

		let start: ChildNode = last;
		if (newline >= 0) {
			start = last.splitText(newline);
		} else {
			const previous = nodes[lastMeaningfulIndex(nodes.slice(0, end))];
			if (previous?.instanceOf(HTMLBRElement)) start = previous;
		}

		const marker = createSpan({ cls: LIST_DELIMITER_CLASS });
		host.insertBefore(marker, start);
		while (marker.nextSibling) marker.appendChild(marker.nextSibling);
	}
}

function unwrapListDelimiters(root: HTMLElement): void {
	for (const marker of Array.from(
		root.querySelectorAll<HTMLElement>(`.${LIST_DELIMITER_CLASS}`),
	)) {
		const host = marker.parentElement;
		if (!host) continue;
		while (marker.firstChild) host.insertBefore(marker.firstChild, marker);
		marker.remove();
		host.normalize();
	}
}

/**
 * Reads `{height=5rem width=60% .wide #note align=center}` into named values and
 * classes. Anything malformed is dropped rather than passed on to the DOM.
 */
function parseAttributes(text: string | undefined): {
	attributes: Map<string, string>;
	classes: string[];
} {
	const attributes = new Map<string, string>();
	const classes: string[] = [];
	for (const token of (text ?? '').match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? []) {
		if (token.startsWith('.')) {
			const name = token.slice(1);
			if (ATTRIBUTE_NAME.test(name)) classes.push(name.toLowerCase());
			continue;
		}
		const separator = token.indexOf('=');
		if (separator < 0) {
			if (ATTRIBUTE_NAME.test(token)) attributes.set(token.toLowerCase(), '');
			continue;
		}
		const name = token.slice(0, separator).trim().toLowerCase();
		if (!ATTRIBUTE_NAME.test(name)) continue;
		let value = token.slice(separator + 1).trim();
		const quote = value.charAt(0);
		if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
			value = value.slice(1, -1);
		}
		attributes.set(name, value.replace(/[;{}]/g, '').trim());
	}
	return { attributes, classes };
}

function parseOpeningDelimiter(
	text: string,
	defaultType: string,
): OpeningDelimiter | null {
	const match = text.match(DELIMITER);
	if (!match) return null;
	const type = match[2] ?? defaultType;
	if (!TYPE_PATTERN.test(type)) return null;
	const { attributes, classes } = parseAttributes(match[3]);
	return {
		fence: (match[1] ?? ':::').length,
		type: type.toLowerCase(),
		title: match[4]?.trim(),
		attributes,
		classes,
		raw: match[3]?.trim(),
	};
}

/** Turns parsed attributes into styles, classes and data hooks for CSS. */
function applyAttributes(container: HTMLElement, opening: OpeningDelimiter): void {
	for (const name of opening.classes) container.addClass(`dns-x-${name}`);
	for (const [name, value] of opening.attributes) {
		if (LENGTH_ATTRIBUTES.has(name)) {
			if (!HEIGHT_PATTERN.test(value)) continue;
			container.style.setProperty(name, value);
			if (name === 'height') container.dataset.height = value;
			continue;
		}
		if (name === 'align') {
			if (!ALIGNMENTS.has(value)) continue;
			container.style.setProperty('text-align', value);
			continue;
		}
		// Everything else becomes a data hook, so new styles need no new code.
		container.setAttribute(`data-${name}`, value);
	}
	if (opening.raw) container.dataset.attributes = opening.raw;
}

/** A closing fence must be at least as long as the one that opened the block. */
function isClosingDelimiter(element: HTMLElement | undefined, fence: number): boolean {
	if (element === undefined) return false;
	const line = singleLine(element);
	const match = line?.match(CLOSING_DELIMITER);
	return !!match && (match[1] ?? '').length >= fence;
}

function boundaryAt(root: Node, offset: number): [Node, number] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let remaining = offset;
	let textNode = walker.nextNode();

	while (textNode) {
		const length = textNode.textContent?.length ?? 0;
		if (remaining <= length) return [textNode, remaining];
		remaining -= length;
		textNode = walker.nextNode();
	}

	return [root, root.childNodes.length];
}

/**
 * CommonMark treats consecutive plain lines as one paragraph. Split paragraphs
 * containing delimiter lines so compact `:::` blocks can use the same renderer.
 */
function splitCompactDelimiterParagraphs(root: HTMLElement): void {
	for (const paragraph of Array.from(root.querySelectorAll('p'))) {
		let text = paragraph.textContent ?? '';
		if (!text.includes(':::')) continue;
		if (paragraph.closest('li')) continue;

		for (const breakElement of Array.from(paragraph.querySelectorAll('br'))) {
			breakElement.replaceWith(document.createTextNode('\n'));
		}
		text = paragraph.textContent ?? '';
		const lines = Array.from(text.matchAll(/(^|\n)([^\n]*)(?=\n|$)/g));
		if (
			lines.length <= 1 ||
			!lines.some((match) => DELIMITER.test(match[2]?.trim() ?? ''))
		) {
			continue;
		}

		const replacements: HTMLElement[] = [];
		for (const match of lines) {
			const rawLine = match[2] ?? '';
			if (!rawLine.trim()) continue;

			const startOffset = (match.index ?? 0) + (match[1]?.length ?? 0);
			const endOffset = startOffset + rawLine.length;
			const [startNode, start] = boundaryAt(paragraph, startOffset);
			const [endNode, end] = boundaryAt(paragraph, endOffset);
			const range = document.createRange();
			range.setStart(startNode, start);
			range.setEnd(endNode, end);

			const line = createEl('p');
			line.append(range.cloneContents());
			replacements.push(line);
		}

		const paragraphWrapper = paragraph.parentElement;
		if (
			paragraphWrapper &&
			paragraphWrapper !== root &&
			paragraphWrapper.tagName === 'DIV' &&
			paragraphWrapper.childNodes.length === 1
		) {
			paragraphWrapper.replaceWith(...replacements);
		} else {
			paragraph.replaceWith(...replacements);
		}
	}
}

/** A delimiter line may itself be the block when paragraphs were split apart. */
function findDelimiterParagraph(
	block: HTMLElement | undefined,
	matches: (text: string) => boolean,
): HTMLElement | undefined {
	if (!block) return undefined;
	const candidates = block.matches('p')
		? [block, ...Array.from(block.querySelectorAll<HTMLElement>('p'))]
		: Array.from(block.querySelectorAll<HTMLElement>('p'));
	return candidates.find((candidate) => matches(candidate.textContent?.trim() ?? ''));
}

/**
 * A block that runs past the end of a rendering section has no closing sibling,
 * so `buildContainers` calls it unclosed before the cross-section pass gets to
 * it. Claiming the delimiter takes that back: the block is closed, elsewhere.
 */
function claimDelimiter(element: HTMLElement, delimiterClass: string): void {
	element.addClass(delimiterClass);
	element.removeClass('dns-unclosed-delimiter');
	element.removeAttribute('aria-label');
	element.removeAttribute('title');
}

function markCrossSectionBlocks(root: HTMLElement): void {
	splitCompactDelimiterParagraphs(root);
	clearSegmentClasses(root);

	const blocks = Array.from(root.children) as HTMLElement[];
	for (const type of SEGMENT_ONLY_TYPES) {
		for (let index = 0; index < blocks.length; index += 1) {
			const opener = findDelimiterParagraph(
				blocks[index],
				(text) => text.toLowerCase() === `:::${type}`,
			);
			if (!opener) continue;

			let closingIndex = index;
			let closer: HTMLElement | undefined;
			while (closingIndex < blocks.length && !closer) {
				closer = findDelimiterParagraph(
					blocks[closingIndex],
					(text) => text === ':::',
				);
				if (!closer) closingIndex += 1;
			}
			if (!closer || closingIndex >= blocks.length) continue;

			const blockSegments = blocks.slice(index, closingIndex + 1);
			const segmentClass = `dns-${type}-segment`;
			const delimiterClass = `dns-${type}-delimiter`;
			const isCjk = containsCjk(
				blockSegments.map((block) => block.textContent ?? '').join(''),
			);
			for (const block of blockSegments) {
				block.addClasses([SEGMENT_CLASS, segmentClass]);
				if (type === 'poem' && isCjk) block.addClass('dns-poem-segment--cjk');
			}
			claimDelimiter(opener, delimiterClass);
			claimDelimiter(closer, delimiterClass);

			// A delimiter on its own line leaves an empty block behind; hide it so
			// the outer spacing lands on the first and last blocks that show text.
			const visible = blockSegments.filter((block) => {
				if (delimiterRole(block) === null) return true;
				claimDelimiter(block, delimiterClass);
				return false;
			});
			const bounds = visible.length > 0 ? visible : blockSegments;
			bounds[0]?.addClass(`${segmentClass}--first`);
			bounds[bounds.length - 1]?.addClass(`${segmentClass}--last`);
			index = closingIndex;
		}
	}

	markCrossSectionImgcaps(root);
}

function markCrossSectionImgcaps(root: HTMLElement): void {
	markListDelimiters(root);

	const blocks = Array.from(root.children) as HTMLElement[];
	const markers = Array.from(
		root.querySelectorAll<HTMLElement>(`p, .${LIST_DELIMITER_CLASS}`),
	).filter((element) => delimiterRole(element) !== null);

	for (let index = 0; index < markers.length; index += 1) {
		const opener = markers[index];
		if (!opener || delimiterRole(opener) !== 'imgcap') continue;

		const closingIndex = markers.findIndex(
			(marker, candidateIndex) =>
				candidateIndex > index && delimiterRole(marker) === 'close',
		);
		if (closingIndex < 0) continue;

		const closer = markers[closingIndex];
		if (!closer) continue;
		const openerBlock = topLevelBlockOf(opener, root);
		const closerBlock = topLevelBlockOf(closer, root);
		const first = openerBlock ? blocks.indexOf(openerBlock) : -1;
		const last = closerBlock ? blocks.indexOf(closerBlock) : -1;
		if (first < 0 || last < first) continue;

		const segments = blocks.slice(first, last + 1);
		for (const segment of segments) {
			segment.addClasses([SEGMENT_CLASS, 'dns-imgcap-segment']);
		}
		claimDelimiter(opener, 'dns-imgcap-delimiter');
		claimDelimiter(closer, 'dns-imgcap-delimiter');

		// A compact block makes the delimiter its own segment; those stay hidden,
		// so the caption's outer spacing belongs to the first visible segment.
		const visible = segments.filter(
			(segment) => segment !== opener && segment !== closer,
		);
		const bounds = visible.length > 0 ? visible : segments;
		bounds[0]?.addClass('dns-imgcap-segment--first');
		bounds[bounds.length - 1]?.addClass('dns-imgcap-segment--last');
		const preceding = blocks[first - 1];
		if (preceding && !preceding.matches(PREVIEW_CHROME)) {
			preceding.addClass('dns-before-imgcap');
		}
		index = closingIndex;
	}
}

/** Converts top-level rendered Markdown between ::: delimiters into containers. */
export function renderCustomContainers(root: HTMLElement, defaultType: string): void {
	clearAdjacencyClasses(root);
	splitCompactDelimiterParagraphs(root);
	buildContainers(root, defaultType);

	const preview = root.closest<HTMLElement>('.markdown-preview-sizer');
	if (preview) markCrossSectionBlocks(preview);
}

function buildContainers(root: HTMLElement, defaultType: string): void {
	const children = Array.from(root.children) as HTMLElement[];
	for (let index = 0; index < children.length; index += 1) {
		const opener = children[index];
		if (!opener) continue;
		const opening = parseOpeningDelimiter(singleLine(opener) ?? '', defaultType);
		if (!opening) continue;

		let closingIndex = index + 1;
		while (
			closingIndex < children.length &&
			!isClosingDelimiter(children[closingIndex], opening.fence)
		) {
			closingIndex += 1;
		}
		const closer = children[closingIndex];
		if (!closer) {
			// Say so rather than rendering the rest of the note as plain text.
			opener.addClass('dns-unclosed-delimiter');
			const message = `This ${':'.repeat(opening.fence)} block is never closed.`;
			opener.setAttribute('aria-label', message);
			opener.setAttribute('title', message);
			continue;
		}
		opener.removeClass('dns-unclosed-delimiter');

		// These types are marked in place so Obsidian keeps owning their sections.
		// Skip past the closer too, or it would read as the next block's opener.
		const segmentOnly = SEGMENT_ONLY_TYPES.some((type) => type === opening.type);
		if (segmentOnly && !opening.title && opening.attributes.size === 0 && opening.classes.length === 0) {
			index = closingIndex;
			continue;
		}

		const container = createDiv({ cls: 'dns-custom-container' });
		container.dataset.type = opening.type;
		container.dataset.fence = String(opening.fence);
		applyAttributes(container, opening);

		if (opening.title) {
			const title = container.createDiv({ cls: 'dns-custom-container__title' });
			title.textContent = opening.title;
		}

		const content = container.createDiv({ cls: 'dns-custom-container__content' });
		for (let cursor = index + 1; cursor < closingIndex; cursor += 1) {
			const child = children[cursor];
			if (child) content.append(child);
		}
		if (containsCjk(content.textContent ?? '')) {
			container.classList.add('dns-custom-container--cjk');
		}
		// A longer fence may wrap blocks of its own.
		if (opening.fence > 3) buildContainers(content, defaultType);
		const precedingBlock = opener.previousElementSibling;
		if (opening.type === 'imgcap') {
			precedingBlock?.addClass('dns-before-imgcap');
		} else if (opening.type === 'compnote' && precedingBlock?.tagName === 'HR') {
			precedingBlock.addClass('dns-before-compnote');
		}
		opener.replaceWith(container);
		closer.remove();
		index = closingIndex;
	}
}

export function restoreCustomContainers(root: HTMLElement): void {
	clearAdjacencyClasses(root);
	unwrapListDelimiters(root);
	for (const container of Array.from(
		root.querySelectorAll<HTMLElement>('.dns-custom-container'),
	)) {
		const type = container.dataset.type ?? 'note';
		const attributes = container.dataset.attributes;
		const fence = ':'.repeat(Number(container.dataset.fence) || 3);
		const title = container.querySelector<HTMLElement>(
			':scope > .dns-custom-container__title',
		)?.textContent;
		const content = container.querySelector<HTMLElement>(
			':scope > .dns-custom-container__content',
		);
		const opener = createEl('p', {
			text: `${fence}${type}${attributes ? `{${attributes}}` : ''}${title ? ` ${title}` : ''}`,
		});
		const closer = createEl('p', { text: fence });
		const contentNodes = content ? Array.from(content.childNodes) : [];
		container.replaceWith(opener, ...contentNodes, closer);
	}

	clearSegmentClasses(root);
}
