import { FileSystemAdapter, Notice, Platform, TFile, normalizePath } from 'obsidian';
import type DnsToolkitPlugin from '../main';
import { compareFolders, readFileDiff, type ChangeStatus } from './folder-diff';
import { loadDesktopNodeModules, type FileSystemApi, type PathApi } from './node-api';
import { ConfirmPublishingModal, PublishingFolderSuggestModal } from './modals';

export type PublishingTargetKind = 'missing' | 'folder' | 'file' | 'symlink';

// What to do with a file whose published version should not simply be the
// vault copy: keep the destination file as it is, or write a merge of both.
export type PublishDecision =
	| { path: string; status: ChangeStatus; kind: 'keep-destination' }
	| { path: string; kind: 'merge'; text: string };

// Publishing pushes the vault outwards; a pull carries a change made at the
// destination back into the note it came from.
export type VaultPull =
	| { path: string; kind: 'text'; text: string }
	| { path: string; kind: 'copy' };

export interface PublishPlan {
	decisions: PublishDecision[];
	pulls: VaultPull[];
}

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
			// Newest first: these folders are named by date, and the one just
			// written is the one about to be published.
			.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
		if (folders.length === 0) {
			new Notice('No publishable subfolders were found.');
			return;
		}

		// A destination root that is not there yet is legitimate, but it also
		// means every file will look new, so the confirmation says so.
		const targetRootMissing = await isMissingFolder(targetRoot, fileSystem);

		new PublishingFolderSuggestModal(plugin.app, folders, (folder) => {
			const source = pathModule.join(sourceRoot, folder);
			const target = pathModule.join(targetRoot, folder);
			void openConfirmation(plugin, {
				folder,
				source,
				target,
				vaultFolder: `${sourceSetting}/${folder}`,
				missingTargetRoot: targetRootMissing ? targetRoot : null,
			});
		}).open();
	} catch (error) {
		new Notice(`Could not read the publishing source: ${errorMessage(error)}`);
	}
}

interface ConfirmationRequest {
	folder: string;
	source: string;
	target: string;
	/** Vault-relative folder, so a pull can be written through the vault API. */
	vaultFolder: string;
	missingTargetRoot: string | null;
}

async function openConfirmation(
	plugin: DnsToolkitPlugin,
	{ folder, source, target, vaultFolder, missingTargetRoot }: ConfirmationRequest,
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
		missingTargetRoot,
		compare: () => compareFolders(source, target, fileSystem, pathModule),
		resolvePaths: (change) => ({
			source: change.status === 'removed' ? null : pathModule.join(source, change.path),
			destination: change.status === 'added' ? null : pathModule.join(target, change.path),
			plannedDestination: pathModule.join(target, change.path),
		}),
		loadDiff: (change) => readFileDiff(
			change.status === 'removed' ? null : pathModule.join(source, change.path),
			change.status === 'added' ? null : pathModule.join(target, change.path),
			fileSystem,
		),
		onConfirm: (plan) => void publishFolder(plugin, { folder, source, target, vaultFolder }, plan),
	}).open();
}

async function publishFolder(
	plugin: DnsToolkitPlugin,
	{ folder, source, target, vaultFolder }: Omit<ConfirmationRequest, 'missingTargetRoot'>,
	plan: PublishPlan,
): Promise<void> {
	const { decisions } = plan;
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
		await applyDecisions(staging, target, decisions, fileSystem, pathModule);
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
		new Notice(decisions.length === 0
			? `Published “${folder}” successfully.`
			: `Published “${folder}” successfully with ${decisions.length} ${decisions.length === 1 ? 'file' : 'files'} you adjusted.`);
		// Only once the destination is safely in place.
		await pullIntoVault(plugin, vaultFolder, target, plan.pulls, fileSystem, pathModule);
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

/**
 * Writes the chosen destination content back into the vault. This goes through
 * the vault API rather than the file system, so Obsidian sees the change in an
 * open note instead of overwriting it from its own buffer.
 */
async function pullIntoVault(
	plugin: DnsToolkitPlugin,
	vaultFolder: string,
	target: string,
	pulls: VaultPull[],
	fileSystem: FileSystemApi,
	pathModule: PathApi,
): Promise<void> {
	if (pulls.length === 0) return;
	let updated = 0;
	const failures: string[] = [];
	for (const pull of pulls) {
		const vaultPath = normalizePath(`${vaultFolder}/${pull.path}`);
		const file = plugin.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) {
			failures.push(pull.path);
			continue;
		}
		try {
			if (pull.kind === 'text') {
				await plugin.app.vault.modify(file, pull.text);
			} else {
				const bytes = await fileSystem.readFile(pathModule.join(target, pull.path));
				const buffer = new ArrayBuffer(bytes.byteLength);
				new Uint8Array(buffer).set(bytes.slice());
				await plugin.app.vault.modifyBinary(file, buffer);
			}
			updated += 1;
		} catch {
			failures.push(pull.path);
		}
	}

	if (updated > 0) {
		new Notice(`Updated ${updated} vault ${updated === 1 ? 'file' : 'files'} from the destination.`);
	}
	if (failures.length > 0) {
		new Notice(`Could not update ${failures.length} vault ${failures.length === 1 ? 'file' : 'files'}: ${failures.join(', ')}`);
	}
}

// Applies the user's choices to the staging copy: a skipped addition is
// dropped, a skipped modification or deletion is restored from the destination
// as it stands right now, and a partly accepted file is written as merged.
async function applyDecisions(
	staging: string,
	target: string,
	decisions: PublishDecision[],
	fileSystem: FileSystemApi,
	pathModule: PathApi,
): Promise<void> {
	for (const change of decisions) {
		const stagedPath = pathModule.join(staging, change.path);
		if (change.kind === 'merge') {
			await fileSystem.mkdir(pathModule.dirname(stagedPath), { recursive: true });
			await fileSystem.writeFile(stagedPath, change.text, 'utf8');
			continue;
		}
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
	fileSystem: FileSystemApi,
	pathModule: PathApi,
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
	fileSystem: FileSystemApi,
	pathModule: PathApi,
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
	fileSystem: FileSystemApi,
	pathModule: PathApi,
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

function isInside(parent: string, child: string, pathModule: PathApi): boolean {
	const result = pathModule.relative(parent, child);
	return result === '' || (!result.startsWith('..') && !pathModule.isAbsolute(result));
}

async function isMissingFolder(
	path: string,
	fileSystem: FileSystemApi,
): Promise<boolean> {
	try {
		return !(await fileSystem.stat(path)).isDirectory();
	} catch (error) {
		if (isMissingFileError(error)) return true;
		throw error;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
