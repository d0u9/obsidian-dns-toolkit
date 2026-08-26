const DELIMITER = /^:::\s*(?:(\S+)(?:\s+(.+))?)?\s*$/;
const TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

interface OpeningDelimiter {
	type: string;
	title?: string;
}

const ADJACENCY_CLASSES = ['dns-before-imgcap', 'dns-before-compnote'] as const;

function clearAdjacencyClasses(root: HTMLElement): void {
	root.querySelectorAll(ADJACENCY_CLASSES.map((name) => `.${name}`).join(',')).forEach(
		(element) => element.removeClasses([...ADJACENCY_CLASSES]),
	);
}

function containsCjk(text: string): boolean {
	return CJK_PATTERN.test(text);
}

function parseOpeningDelimiter(
	text: string,
	defaultType: string,
): OpeningDelimiter | null {
	const match = text.match(DELIMITER);
	if (!match) return null;
	const type = match[1] ?? defaultType;
	if (!TYPE_PATTERN.test(type)) return null;
	return { type: type.toLowerCase(), title: match[2]?.trim() };
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
	root.querySelectorAll('.dns-poem-segment, .dns-aside-segment').forEach((element) => {
		element.removeClasses([
			'dns-poem-segment',
			'dns-poem-segment--first',
			'dns-poem-segment--last',
			'dns-poem-segment--cjk',
			'dns-aside-segment',
			'dns-aside-segment--first',
			'dns-aside-segment--last',
		]);
	});
	root.querySelectorAll('.dns-poem-delimiter, .dns-aside-delimiter').forEach((element) => {
		element.removeClasses(['dns-poem-delimiter', 'dns-aside-delimiter']);
	});

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
	for (const container of Array.from(
		root.querySelectorAll<HTMLElement>('.dns-custom-container'),
	)) {
		const type = container.dataset.type ?? 'note';
		const title = container.querySelector<HTMLElement>(
			':scope > .dns-custom-container__title',
		)?.textContent;
		const content = container.querySelector<HTMLElement>(
			':scope > .dns-custom-container__content',
		);
		const opener = createEl('p', {
			text: `:::${type}${title ? ` ${title}` : ''}`,
		});
		const closer = createEl('p', { text: ':::' });
		const contentNodes = content ? Array.from(content.childNodes) : [];
		container.replaceWith(opener, ...contentNodes, closer);
	}

	root.querySelectorAll('.dns-poem-segment, .dns-aside-segment').forEach((element) => {
		element.removeClasses([
			'dns-poem-segment',
			'dns-poem-segment--first',
			'dns-poem-segment--last',
			'dns-poem-segment--cjk',
			'dns-aside-segment',
			'dns-aside-segment--first',
			'dns-aside-segment--last',
		]);
	});
	root.querySelectorAll('.dns-poem-delimiter, .dns-aside-delimiter').forEach((element) => {
		element.removeClasses(['dns-poem-delimiter', 'dns-aside-delimiter']);
	});
}
