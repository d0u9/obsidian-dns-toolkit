import { Platform } from 'obsidian';

/**
 * The slice of Node's file system and path modules this plugin uses, described
 * here rather than imported as types. Obsidian's scanner lints plugins without
 * Node's type definitions, where `typeof import('node:fs/promises')` degrades
 * to `any` and every call through it reads as unsafe.
 */

export interface FileStats {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	size: number;
	mtimeMs: number;
}

export interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

/** A Node buffer, limited to the reading this plugin does. */
export interface FileBytes {
	readonly byteLength: number;
	equals(other: FileBytes): boolean;
	includes(value: number): boolean;
	subarray(start?: number, end?: number): FileBytes;
	toString(encoding: 'utf8'): string;
	/** Copies the bytes out, so callers own plain memory of their own. */
	slice(start?: number, end?: number): Uint8Array<ArrayBufferLike>;
}

export interface FileSystemApi {
	stat(path: string): Promise<FileStats>;
	lstat(path: string): Promise<FileStats>;
	readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
	readFile(path: string): Promise<FileBytes>;
	writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
	mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
	rmdir(path: string): Promise<void>;
	cp(
		from: string,
		to: string,
		options: { recursive?: boolean; force?: boolean; errorOnExist?: boolean },
	): Promise<void>;
}

export interface PathApi {
	join(...parts: string[]): string;
	resolve(...parts: string[]): string;
	relative(from: string, to: string): string;
	dirname(path: string): string;
	basename(path: string): string;
	isAbsolute(path: string): boolean;
	parse(path: string): { root: string };
}

/**
 * Loads the modules behind that surface. These do not exist on mobile, so the
 * guard is repeated here even though every caller reaches this through a
 * desktop-only command. Obsidian plugins run as CommonJS, where a dynamic
 * import() would be treated as a fetch.
 */
export function loadDesktopNodeModules(): {
	fileSystem: FileSystemApi;
	pathModule: PathApi;
} {
	if (!Platform.isDesktopApp) {
		throw new Error('Folder publishing is available only in the desktop app.');
	}
	return {
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Loaded only after the desktop guard.
		fileSystem: require('node:fs/promises') as FileSystemApi,
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Loaded only after the desktop guard.
		pathModule: require('node:path') as PathApi,
	};
}
