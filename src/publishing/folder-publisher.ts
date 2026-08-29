import { FileSystemAdapter, Notice, Platform, normalizePath } from 'obsidian';
import type DnsToolkitPlugin from '../main';
import { ConfirmPublishingModal, PublishingFolderSuggestModal } from './modals';

export async function chooseAndPublishFolder(plugin: DnsToolkitPlugin): Promise<void> {
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
	let targetExists = false;
	try {
		await fileSystem.stat(target);
		targetExists = true;
	} catch (error) {
		if (!isMissingFileError(error)) {
			new Notice(`Could not inspect the destination: ${errorMessage(error)}`);
			return;
		}
	}

	new ConfirmPublishingModal(
		plugin.app,
		folder,
		source,
		target,
		targetExists,
		() => void publishFolder(source, target, folder),
	).open();
}

async function publishFolder(source: string, target: string, folder: string): Promise<void> {
	const { fileSystem, pathModule } = loadDesktopNodeModules();
	const parent = pathModule.dirname(target);
	const suffix = `${Date.now()}-${crypto.randomUUID()}`;
	const staging = pathModule.join(parent, `.${pathModule.basename(target)}.dns-copy-${suffix}`);
	const backup = pathModule.join(parent, `.${pathModule.basename(target)}.dns-backup-${suffix}`);
	let movedExistingTarget = false;

	try {
		await assertNoSymbolicLinks(source, fileSystem, pathModule);
		await fileSystem.mkdir(parent, { recursive: true });
		await fileSystem.cp(source, staging, { recursive: true, errorOnExist: true });
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
		new Notice(`Published “${folder}” successfully.`);
	} catch (error) {
		await fileSystem.rm(staging, { recursive: true, force: true }).catch(() => undefined);
		if (movedExistingTarget) {
			await fileSystem.rename(backup, target).catch(() => undefined);
		}
		new Notice(`Could not publish “${folder}”: ${errorMessage(error)}`);
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
