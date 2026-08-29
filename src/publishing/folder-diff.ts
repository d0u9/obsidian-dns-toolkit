type FileSystem = typeof import('node:fs/promises');
type PathModule = typeof import('node:path');

export type ChangeStatus = 'added' | 'modified' | 'removed';

export interface FolderChange {
	path: string;
	status: ChangeStatus;
}

export interface FolderComparison {
	changes: FolderChange[];
	unchangedCount: number;
	truncated: boolean;
}

export type FileDiff =
	| { kind: 'text'; rows: DiffRow[]; hunkCount: number; trailingNewline: boolean }
	| { kind: 'image'; before: ImageFile | null; after: ImageFile | null }
	| { kind: 'binary' }
	| { kind: 'too-large' }
	| { kind: 'identical' };

export interface ImageFile {
	bytes: Uint8Array<ArrayBuffer>;
	byteLength: number;
	mime: string;
}

interface DiffLine {
	kind: 'context' | 'add' | 'remove' | 'gap';
	text: string;
	beforeLine?: number;
	afterLine?: number;
	// Set on gap rows: the collapsed lines, needed to rebuild a merged file.
	hidden?: string[];
}

export interface DiffCell {
	line: number;
	text: string;
}

// One row of the side-by-side view. A changed row may hold a cell on only one
// side when an edit adds or deletes lines.
export interface DiffRow {
	kind: 'context' | 'change' | 'gap';
	before: DiffCell | null;
	after: DiffCell | null;
	text?: string;
	// Index of the run of changed lines this row belongs to, so a single file
	// can be published with some runs taken from either side.
	hunk?: number;
	hidden?: string[];
}

// Publishing folders hold prose, so these ceilings only guard against a stray
// build output or media folder freezing the confirmation dialog.
const MAX_COMPARED_FILES = 5000;
const MAX_COMPARED_BYTES = 32 * 1024 * 1024;
const MAX_DIFFED_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEWED_IMAGE_BYTES = 24 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
	avif: 'image/avif',
	bmp: 'image/bmp',
	gif: 'image/gif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	svg: 'image/svg+xml',
	webp: 'image/webp',
};
const MAX_DIFF_MATRIX_CELLS = 4_000_000;
const DIFF_CONTEXT_LINES = 3;

export async function compareFolders(
	source: string,
	target: string,
	fileSystem: FileSystem,
	pathModule: PathModule,
): Promise<FolderComparison> {
	const sourceFiles = await listFiles(source, fileSystem, pathModule);
	const targetFiles = await listFiles(target, fileSystem, pathModule);
	const paths = [...new Set([...sourceFiles.keys(), ...targetFiles.keys()])]
		.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

	const changes: FolderChange[] = [];
	let unchangedCount = 0;
	for (const path of paths) {
		const sourceSize = sourceFiles.get(path);
		const targetSize = targetFiles.get(path);
		if (sourceSize === undefined) {
			changes.push({ path, status: 'removed' });
			continue;
		}
		if (targetSize === undefined) {
			changes.push({ path, status: 'added' });
			continue;
		}
		const identical = sourceSize === targetSize && await hasSameContent(
			pathModule.join(source, path),
			pathModule.join(target, path),
			sourceSize,
			fileSystem,
		);
		if (identical) unchangedCount += 1;
		else changes.push({ path, status: 'modified' });
	}

	return {
		changes,
		unchangedCount,
		truncated: sourceFiles.size >= MAX_COMPARED_FILES || targetFiles.size >= MAX_COMPARED_FILES,
	};
}

export async function readFileDiff(
	sourceFile: string | null,
	targetFile: string | null,
	fileSystem: FileSystem,
): Promise<FileDiff> {
	const mime = imageMimeType(sourceFile ?? targetFile ?? '');
	if (mime) return readImageDiff(sourceFile, targetFile, mime, fileSystem);

	const before = targetFile ? await readTextFile(targetFile, fileSystem) : { kind: 'text' as const, text: '' };
	if (before.kind !== 'text') return before;
	const after = sourceFile ? await readTextFile(sourceFile, fileSystem) : { kind: 'text' as const, text: '' };
	if (after.kind !== 'text') return after;
	if (before.text === after.text) return { kind: 'identical' };

	const beforeLines = splitLines(before.text);
	const afterLines = splitLines(after.text);
	const rows = pairRows(buildHunks(beforeLines, afterLines));
	return {
		kind: 'text',
		rows,
		hunkCount: rows.reduce((total, row) => Math.max(total, (row.hunk ?? -1) + 1), 0),
		trailingNewline: after.text === '' || after.text.endsWith('\n'),
	};
}

function imageMimeType(path: string): string | null {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return IMAGE_MIME_TYPES[extension] ?? null;
}

async function readImageDiff(
	sourceFile: string | null,
	targetFile: string | null,
	mime: string,
	fileSystem: FileSystem,
): Promise<FileDiff> {
	const before = targetFile ? await readImageFile(targetFile, mime, fileSystem) : null;
	const after = sourceFile ? await readImageFile(sourceFile, mime, fileSystem) : null;
	if (before === 'too-large' || after === 'too-large') return { kind: 'too-large' };
	return { kind: 'image', before, after };
}

async function readImageFile(
	path: string,
	mime: string,
	fileSystem: FileSystem,
): Promise<ImageFile | 'too-large'> {
	const buffer = await fileSystem.readFile(path);
	if (buffer.byteLength > MAX_PREVIEWED_IMAGE_BYTES) return 'too-large';
	// Copy out of Node's shared pool: the Blob below must own a plain ArrayBuffer.
	const bytes = new Uint8Array(buffer.byteLength);
	bytes.set(buffer);
	return { bytes, byteLength: bytes.byteLength, mime };
}

async function listFiles(
	root: string,
	fileSystem: FileSystem,
	pathModule: PathModule,
): Promise<Map<string, number>> {
	const files = new Map<string, number>();
	const walk = async (directory: string, prefix: string): Promise<void> => {
		if (files.size >= MAX_COMPARED_FILES) return;
		let entries;
		try {
			entries = await fileSystem.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isMissingFileError(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (files.size >= MAX_COMPARED_FILES) return;
			const absolute = pathModule.join(directory, entry.name);
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(absolute, relative);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				files.set(relative, (await fileSystem.stat(absolute)).size);
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
		}
	};
	await walk(root, '');
	return files;
}

async function hasSameContent(
	left: string,
	right: string,
	size: number,
	fileSystem: FileSystem,
): Promise<boolean> {
	// Equal sizes above the ceiling are reported as a change rather than read
	// into memory; a false "modified" is safer than a missed one.
	if (size > MAX_COMPARED_BYTES) return false;
	try {
		const [leftBuffer, rightBuffer] = await Promise.all([
			fileSystem.readFile(left),
			fileSystem.readFile(right),
		]);
		return leftBuffer.equals(rightBuffer);
	} catch {
		return false;
	}
}

async function readTextFile(
	path: string,
	fileSystem: FileSystem,
): Promise<{ kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'too-large' }> {
	const buffer = await fileSystem.readFile(path);
	if (buffer.byteLength > MAX_DIFFED_BYTES) return { kind: 'too-large' };
	if (buffer.subarray(0, 8000).includes(0)) return { kind: 'binary' };
	return { kind: 'text', text: buffer.toString('utf8') };
}

function splitLines(text: string): string[] {
	if (text === '') return [];
	const normalized = text.replace(/\r\n?/g, '\n');
	const lines = normalized.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

function buildHunks(before: string[], after: string[]): DiffLine[] {
	const rows = diffLines(before, after);
	const interesting = rows.map((row) => row.kind !== 'context');
	const keep = rows.map((_, index) => interesting
		.slice(Math.max(0, index - DIFF_CONTEXT_LINES), index + DIFF_CONTEXT_LINES + 1)
		.some(Boolean));

	const lines: DiffLine[] = [];
	let skipped: DiffLine[] = [];
	const flush = (): void => {
		if (skipped.length === 0) return;
		// Collapsing a single line would take more room than showing it.
		if (skipped.length === 1) lines.push(...skipped);
		else lines.push({
			kind: 'gap',
			text: `${skipped.length} unchanged lines`,
			hidden: skipped.map((line) => line.text),
		});
		skipped = [];
	};
	rows.forEach((row, index) => {
		if (keep[index]) {
			flush();
			lines.push(row);
			return;
		}
		skipped.push(row);
	});
	flush();
	return lines;
}

// Zips each run of removed and added lines into rows so both versions can be
// read across from one another.
function pairRows(lines: DiffLine[]): DiffRow[] {
	const rows: DiffRow[] = [];
	let index = 0;
	let hunk = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line.kind === 'gap') {
			rows.push({ kind: 'gap', before: null, after: null, text: line.text, hidden: line.hidden });
			index += 1;
			continue;
		}
		if (line.kind === 'context') {
			rows.push({
				kind: 'context',
				before: { line: line.beforeLine ?? 0, text: line.text },
				after: { line: line.afterLine ?? 0, text: line.text },
			});
			index += 1;
			continue;
		}

		const removed: DiffCell[] = [];
		const added: DiffCell[] = [];
		while (index < lines.length) {
			const run = lines[index]!;
			if (run.kind === 'remove') removed.push({ line: run.beforeLine ?? 0, text: run.text });
			else if (run.kind === 'add') added.push({ line: run.afterLine ?? 0, text: run.text });
			else break;
			index += 1;
		}
		for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
			rows.push({
				kind: 'change',
				before: removed[offset] ?? null,
				after: added[offset] ?? null,
				hunk,
			});
		}
		hunk += 1;
	}
	return rows;
}

// Rebuilds the file from the rows, taking the runs named in `destinationHunks`
// from the destination and every other run from the vault.
export function mergeRows(
	rows: DiffRow[],
	destinationHunks: Set<number>,
	trailingNewline: boolean,
): string {
	const merged: string[] = [];
	for (const row of rows) {
		if (row.kind === 'gap') {
			merged.push(...(row.hidden ?? []));
			continue;
		}
		if (row.kind === 'context') {
			if (row.after) merged.push(row.after.text);
			continue;
		}
		const cell = destinationHunks.has(row.hunk ?? -1) ? row.before : row.after;
		if (cell) merged.push(cell.text);
	}
	const text = merged.join('\n');
	return text === '' || !trailingNewline ? text : `${text}\n`;
}

function diffLines(before: string[], after: string[]): DiffLine[] {
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	) tail += 1;

	const beforeMiddle = before.slice(head, before.length - tail);
	const afterMiddle = after.slice(head, after.length - tail);
	const middle = (beforeMiddle.length + 1) * (afterMiddle.length + 1) > MAX_DIFF_MATRIX_CELLS
		? replaceWholeBlock(beforeMiddle, afterMiddle)
		: alignLines(beforeMiddle, afterMiddle);

	const rows: DiffLine[] = [];
	let beforeLine = 1;
	let afterLine = 1;
	for (let index = 0; index < head; index += 1) {
		rows.push({ kind: 'context', text: before[index] ?? '', beforeLine: beforeLine++, afterLine: afterLine++ });
	}
	for (const row of middle) {
		if (row.kind === 'remove') rows.push({ ...row, beforeLine: beforeLine++ });
		else if (row.kind === 'add') rows.push({ ...row, afterLine: afterLine++ });
		else rows.push({ ...row, beforeLine: beforeLine++, afterLine: afterLine++ });
	}
	for (let index = before.length - tail; index < before.length; index += 1) {
		rows.push({ kind: 'context', text: before[index] ?? '', beforeLine: beforeLine++, afterLine: afterLine++ });
	}
	return rows;
}

function replaceWholeBlock(before: string[], after: string[]): DiffLine[] {
	return [
		...before.map((text): DiffLine => ({ kind: 'remove', text })),
		...after.map((text): DiffLine => ({ kind: 'add', text })),
	];
}

// Longest common subsequence over lines. The matrix is bounded by the caller,
// so the quadratic table is sized only for the differing middle section.
function alignLines(before: string[], after: string[]): DiffLine[] {
	const rows = before.length;
	const columns = after.length;
	const width = columns + 1;
	const table = new Int32Array((rows + 1) * width);
	for (let row = rows - 1; row >= 0; row -= 1) {
		const beforeLine = before[row] ?? '';
		for (let column = columns - 1; column >= 0; column -= 1) {
			table[row * width + column] = beforeLine === (after[column] ?? '')
				? table[(row + 1) * width + column + 1]! + 1
				: Math.max(table[(row + 1) * width + column]!, table[row * width + column + 1]!);
		}
	}

	const result: DiffLine[] = [];
	let row = 0;
	let column = 0;
	while (row < rows && column < columns) {
		const beforeLine = before[row] ?? '';
		const afterLine = after[column] ?? '';
		if (beforeLine === afterLine) {
			result.push({ kind: 'context', text: beforeLine });
			row += 1;
			column += 1;
		} else if (table[(row + 1) * width + column]! >= table[row * width + column + 1]!) {
			result.push({ kind: 'remove', text: beforeLine });
			row += 1;
		} else {
			result.push({ kind: 'add', text: afterLine });
			column += 1;
		}
	}
	while (row < rows) result.push({ kind: 'remove', text: before[row++] ?? '' });
	while (column < columns) result.push({ kind: 'add', text: after[column++] ?? '' });
	return result;
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
