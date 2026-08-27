const DELIMITER = /^:::\s*(?:([a-zA-Z][a-zA-Z0-9_-]*)(?:\{([^}]*)\})?(?:\s+(.+))?)?\s*$/;
const TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const HEIGHT_PATTERN = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|vh|vw|vmin|vmax|%))$/i;
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

interface OpeningDelimiter {
	type: string;
	title?: string;
	height?: string;
}

const ADJACENCY_CLASSES = ['dns-before-imgcap', 'dns-before-compnote'] as const;
const PREVIEW_CHROME = '.markdown-preview-pusher, .mod-header, .mod-footer';
const LIST_DELIMITER_CLASS = 'dns-list-delimiter';

/** Block types Obsidian may split across several rendering sections. */
const SEGMENT_TYPES = ['poem', 'aside', 'imgcap'] as const;
const SEGMENT_CLASSES = [
	...SEGMENT_TYPES.flatMap((type) => [
		`dns-${type}-segment`,
		`dns-${type}-segment--first`,
		`dns-${type}-segment--last`,
		`dns-${type}-delimiter`,
	]),
	'dns-poem-segment--cjk',
];
const SEGMENT_SELECTOR = SEGMENT_CLASSES.map((name) => `.${name}`).join(',');

function clearAdjacencyClasses(root: HTMLElement): void {
	root.querySelectorAll(ADJACENCY_CLASSES.map((name) => `.${name}`).join(',')).forEach(
		(element) => element.removeClasses([...ADJACENCY_CLASSES]),
	);
}

function containsCjk(text: string): boolean {
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

/** Reads an element that holds nothing but a delimiter line. */
function delimiterRole(element: HTMLElement): string | null {
	const text = element.textContent?.trim() ?? '';
	if (text === ':::') return 'close';
	return text.match(DELIMITER)?.[1]?.toLowerCase() ?? null;
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
		const type = line === ':::' ? 'close' : line.match(DELIMITER)?.[1]?.toLowerCase();
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

function parseOpeningDelimiter(
	text: string,
	defaultType: string,
): OpeningDelimiter | null {
	const match = text.match(DELIMITER);
	if (!match) return null;
	const type = match[1] ?? defaultType;
	if (!TYPE_PATTERN.test(type)) return null;
	const attributes = match[2]?.trim();
	const heightMatch = attributes?.match(/^height\s*=\s*(\S+)$/i);
	const height = heightMatch?.[1];
	return {
		type: type.toLowerCase(),
		title: match[3]?.trim(),
		height: height && HEIGHT_PATTERN.test(height) ? height : undefined,
	};
}

function isClosingDelimiter(element: Element | undefined): boolean {
	return element?.textContent?.trim() === ':::';
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

function markCrossSectionBlocks(root: HTMLElement): void {
	splitCompactDelimiterParagraphs(root);
	clearSegmentClasses(root);

	const blocks = Array.from(root.children) as HTMLElement[];
	for (const type of ['poem', 'aside'] as const) {
		for (let index = 0; index < blocks.length; index += 1) {
			const opener = Array.from(blocks[index]?.querySelectorAll('p') ?? []).find(
				(paragraph) => paragraph.textContent?.trim().toLowerCase() === `:::${type}`,
			);
			if (!opener) continue;

			let closingIndex = index;
			let closer: HTMLParagraphElement | undefined;
			while (closingIndex < blocks.length && !closer) {
				closer = Array.from(blocks[closingIndex]?.querySelectorAll('p') ?? []).find(
					(paragraph) => paragraph.textContent?.trim() === ':::',
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
				block.addClass(segmentClass);
				if (type === 'poem' && isCjk) block.addClass('dns-poem-segment--cjk');
			}
			blockSegments[0]?.addClass(`${segmentClass}--first`);
			blockSegments[blockSegments.length - 1]?.addClass(`${segmentClass}--last`);
			opener.addClass(delimiterClass);
			closer.addClass(delimiterClass);
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
		for (const segment of segments) segment.addClass('dns-imgcap-segment');
		opener.addClass('dns-imgcap-delimiter');
		closer.addClass('dns-imgcap-delimiter');

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

	const children = Array.from(root.children);
	for (let index = 0; index < children.length; index += 1) {
		const opener = children[index];
		if (!opener) continue;
		const opening = parseOpeningDelimiter(opener.textContent?.trim() ?? '', defaultType);
		if (!opening) continue;
		if (opening.type === 'poem' || opening.type === 'aside') continue;

		let closingIndex = index + 1;
		while (
			closingIndex < children.length &&
			!isClosingDelimiter(children[closingIndex])
		) {
			closingIndex += 1;
		}
		const closer = children[closingIndex];
		if (!closer) continue;

		const container = createDiv({ cls: 'dns-custom-container' });
		container.dataset.type = opening.type;
		if (opening.height) {
			container.dataset.height = opening.height;
			container.style.height = opening.height;
		}

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

	const preview = root.closest<HTMLElement>('.markdown-preview-sizer');
	if (preview) markCrossSectionBlocks(preview);
}

export function restoreCustomContainers(root: HTMLElement): void {
	clearAdjacencyClasses(root);
	unwrapListDelimiters(root);
	for (const container of Array.from(
		root.querySelectorAll<HTMLElement>('.dns-custom-container'),
	)) {
		const type = container.dataset.type ?? 'note';
		const height = container.dataset.height;
		const title = container.querySelector<HTMLElement>(
			':scope > .dns-custom-container__title',
		)?.textContent;
		const content = container.querySelector<HTMLElement>(
			':scope > .dns-custom-container__content',
		);
		const opener = createEl('p', {
			text: `:::${type}${height ? `{height=${height}}` : ''}${title ? ` ${title}` : ''}`,
		});
		const closer = createEl('p', { text: ':::' });
		const contentNodes = content ? Array.from(content.childNodes) : [];
		container.replaceWith(opener, ...contentNodes, closer);
	}

	clearSegmentClasses(root);
}
