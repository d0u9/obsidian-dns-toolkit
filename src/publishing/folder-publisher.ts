import { FileSystemAdapter, Notice, Platform, normalizePath } from 'obsidian';
import type DnsToolkitPlugin from '../main';
import { compareFolders, readFileDiff, type FolderChange } from './folder-diff';
import { ConfirmPublishingModal, PublishingFolderSuggestModal } from './modals';

export type PublishingTargetKind = 'missing' | 'folder' | 'file' | 'symlink';

const STALE_WORK_FOLDER_AGE_MS = 60 * 60 * 1000;

let publishInProgress = false;

export async function chooseAndPublishFolder(plugin: DnsToolkitPlugin): Promise<void> {
	if (publishInProgress) {
		new Notice('A folder is already being published.');
		return;
	}
	if (!plugin.settings.enableFolderPublishing) {
		new Notice('Enable folder publishing in DNS toolkit settings first.');
		return;
	}
	if (!Platform.isDesktopApp || !(plugin.app.vault.adapter instanceof FileSystemAdapter)) {
		new Notice('Folder publishing is available only in the desktop app.');
		return;
	}

	const sourceSetting = normalizeVaultFolder(plugin.settings.publishingSourceFolder);
	const targetSetting = plugin.settings.publishingTargetFolder.trim();
	if (!sourceSetting || !targetSetting) {
		new Notice('Set both publishing folders in DNS toolkit settings first.');
		return;
	}

	// Node APIs are loaded only after the desktop guard above. Obsidian plugins
	// run as CommonJS; dynamic import() is treated as a browser fetch here.
	const { pathModule, fileSystem } = loadDesktopNodeModules();
	const vaultRoot = pathModule.resolve(plugin.app.vault.adapter.getBasePath());
	const sourceRoot = pathModule.resolve(vaultRoot, sourceSetting);
	const targetRoot = pathModule.resolve(targetSetting);
	if (!isInside(vaultRoot, sourceRoot, pathModule) || !pathModule.isAbsolute(targetSetting)) {
		new Notice('The source must be inside the vault and the destination must be an absolute path.');
		return;
	}
	if (targetRoot === pathModule.parse(targetRoot).root) {
		new Notice('The final publishing folder cannot be the file system root.');
		return;
	}
	if (isInside(vaultRoot, targetRoot, pathModule) || isInside(targetRoot, vaultRoot, pathModule)) {
		new Notice('The final publishing folder must be outside the vault.');
		return;
	}

	try {
		const sourceStats = await fileSystem.stat(sourceRoot);
		if (!sourceStats.isDirectory()) throw new Error('The configured source is not a folder.');
		const entries = await fileSystem.readdir(sourceRoot, { withFileTypes: true });
		const folders = entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
		if (folders.length === 0) {
			new Notice('No publishable subfolders were found.');
			return;
		}

		new PublishingFolderSuggestModal(plugin.app, folders, (folder) => {
			const source = pathModule.join(sourceRoot, folder);
			const target = pathModule.join(targetRoot, folder);
			void openConfirmation(plugin, folder, source, target);
		}).open();
	} catch (error) {
		new Notice(`Could not read the publishing source: ${errorMessage(error)}`);
	}
}

async function openConfirmation(
	plugin: DnsToolkitPlugin,
	folder: string,
	source: string,
	target: string,
): Promise<void> {
	const { fileSystem } = loadDesktopNodeModules();
	let targetKind: PublishingTargetKind = 'missing';
	try {
		// lstat, not stat: a symbolic link at the destination is replaced as a
		// link, so the confirmation must say so rather than describe its target.
		const stats = await fileSystem.lstat(target);
		if (stats.isSymbolicLink()) targetKind = 'symlink';
		else if (stats.isDirectory()) targetKind = 'folder';
		else targetKind = 'file';
	} catch (error) {
		if (!isMissingFileError(error)) {
			new Notice(`Could not inspect the destination: ${errorMessage(error)}`);
			return;
		}
	}

	const { pathModule } = loadDesktopNodeModules();
	new ConfirmPublishingModal(plugin.app, {
		folder,
		source,
		target,
		targetKind,
		compare: () => compareFolders(source, target, fileSystem, pathModule),
		loadDiff: (change) => readFileDiff(
			change.status === 'removed' ? null : pathModule.join(source, change.path),
			change.status === 'added' ? null : pathModule.join(target, change.path),
			fileSystem,
		),
		onConfirm: (keptChanges) => void publishFolder(source, target, folder, keptChanges),
	}).open();
}

async function publishFolder(
	source: string,
	target: string,
	folder: string,
	keptChanges: FolderChange[],
): Promise<void> {
	const { fileSystem, pathModule } = loadDesktopNodeModules();
	const parent = pathModule.dirname(target);
	const suffix = `${Date.now()}-${crypto.randomUUID()}`;
	const staging = pathModule.join(parent, `.${pathModule.basename(target)}.dns-copy-${suffix}`);
	const backup = pathModule.join(parent, `.${pathModule.basename(target)}.dns-backup-${suffix}`);
	let movedExistingTarget = false;

	publishInProgress = true;
	try {
		await removeStaleWorkFolders(parent, pathModule.basename(target), fileSystem, pathModule);
		if ((await fileSystem.lstat(source)).isSymbolicLink()) {
			throw new Error('Symbolic links are not supported.');
		}
		await assertNoSymbolicLinks(source, fileSystem, pathModule);
		await fileSystem.mkdir(parent, { recursive: true });
		await fileSystem.cp(source, staging, { recursive: true, force: false, errorOnExist: true });
		// The destination is still in place here, so the files the user chose to
		// keep are backfilled into the staging copy before anything is moved.
		await keepDestinationFiles(staging, target, keptChanges, fileSystem, pathModule);
		try {
			await fileSystem.rename(target, backup);
			movedExistingTarget = true;
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		await fileSystem.rename(staging, target);
		if (movedExistingTarget) {
			void fileSystem.rm(backup, { recursive: true, force: true }).catch(() => undefined);
		}
		new Notice(keptChanges.length === 0
			? `Published “${folder}” successfully.`
			: `Published “${folder}” successfully, keeping ${keptChanges.length} destination ${keptChanges.length === 1 ? 'file' : 'files'}.`);
	} catch (error) {
		await fileSystem.rm(staging, { recursive: true, force: true }).catch(() => undefined);
		if (movedExistingTarget) {
			await fileSystem.rename(backup, target).catch(() => undefined);
		}
		new Notice(`Could not publish “${folder}”: ${errorMessage(error)}`);
	} finally {
		publishInProgress = false;
	}
}

// Applies the user's per-file choices to the staging copy: a skipped addition
// is dropped, and a skipped modification or deletion is restored from the
// destination as it stands right now.
async function keepDestinationFiles(
	staging: string,
	target: string,
	keptChanges: FolderChange[],
	fileSystem: typeof import('node:fs/promises'),
	pathModule: typeof import('node:path'),
): Promise<void> {
	for (const change of keptChanges) {
		const stagedPath = pathModule.join(staging, change.path);
		if (change.status === 'added') {
			await fileSystem.rm(stagedPath, { force: true });
			await removeEmptyParents(stagedPath, staging, fileSystem, pathModule);
			continue;
		}
		const destinationPath = pathModule.join(target, change.path);
		if ((await fileSystem.lstat(destinationPath)).isSymbolicLink()) {
			throw new Error(`Symbolic links are not supported (${change.path}).`);
		}
		await fileSystem.mkdir(pathModule.dirname(stagedPath), { recursive: true });
		await fileSystem.cp(destinationPath, stagedPath, { force: true });
	}
}

async function removeEmptyParents(
	path: string,
	root: string,
	fileSystem: typeof import('node:fs/promises'),
	pathModule: typeof import('node:path'),
): Promise<void> {
	let directory = pathModule.dirname(path);
	while (directory !== root && isInside(root, directory, pathModule)) {
		try {
			await fileSystem.rmdir(directory);
		} catch {
			return;
		}
		directory = pathModule.dirname(directory);
	}
}

// A crash between the renames below leaves a hidden staging or backup folder
// next to the destination. Sweep the leftovers of earlier runs, keeping recent
// ones in case another window is publishing right now.
async function removeStaleWorkFolders(
	parent: string,
	basename: string,
	fileSystem: typeof import('node:fs/promises'),
	pathModule: typeof import('node:path'),
): Promise<void> {
	const prefixes = [`.${basename}.dns-copy-`, `.${basename}.dns-backup-`];
	let entries;
	try {
		entries = await fileSystem.readdir(parent, { withFileTypes: true });
	} catch (error) {
		if (isMissingFileError(error)) return;
		throw error;
	}
	const cutoff = Date.now() - STALE_WORK_FOLDER_AGE_MS;
	for (const entry of entries) {
		if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = pathModule.join(parent, entry.name);
		try {
			const stats = await fileSystem.lstat(path);
			if (stats.mtimeMs > cutoff) continue;
			await fileSystem.rm(path, { recursive: true, force: true });
		} catch {
			// A leftover we cannot inspect or delete must not block publishing.
		}
	}
}

async function assertNoSymbolicLinks(
	root: string,
	fileSystem: typeof import('node:fs/promises'),
	pathModule: typeof import('node:path'),
): Promise<void> {
	const entries = await fileSystem.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = pathModule.join(root, entry.name);
		if ((await fileSystem.lstat(path)).isSymbolicLink()) {
			throw new Error(`Symbolic links are not supported (${entry.name}).`);
		}
		if (entry.isDirectory()) await assertNoSymbolicLinks(path, fileSystem, pathModule);
	}
}

function normalizeVaultFolder(value: string): string {
	return normalizePath(value.trim()).replace(/^\/+|\/+$/g, '');
}

function loadDesktopNodeModules(): {
	fileSystem: typeof import('node:fs/promises');
	pathModule: typeof import('node:path');
} {
	return {
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Loaded only after the desktop guard.
		fileSystem: require('node:fs/promises') as typeof import('node:fs/promises'),
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Loaded only after the desktop guard.
		pathModule: require('node:path') as typeof import('node:path'),
	};
}

function isInside(parent: string, child: string, pathModule: typeof import('node:path')): boolean {
	const result = pathModule.relative(parent, child);
	return result === '' || (!result.startsWith('..') && !pathModule.isAbsolute(result));
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
