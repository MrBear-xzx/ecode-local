import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ECODE_ENVIRONMENTS_FILE,
  ECODE_LOCAL_DIRECTORY,
} from '../domain/constants';
import type {
  ConnectionProfile,
  EnvironmentConfiguration,
  EnvironmentProfile,
  StoredConflict,
  StoredEnvironmentProfile,
  SyncManifest,
} from '../domain/types';
import type {
  CachedFileFormMetadata,
  FormMetadataCache,
} from '../domain/formMetadata';
import {
  resolveEnvironmentDataRoot,
  resolveEnvironmentSourceRoot,
  validateEnvironmentDirectory,
} from '../domain/paths';
import { hashText } from '../domain/text';
import { writeJsonAtomic, writeTextAtomic } from './AtomicFileStore';

const MANIFEST_FILE = 'sync-manifest.json';
const FORM_METADATA_FILE = 'form-metadata.json';
const LIFECYCLE_SNAPSHOT_FILE = 'lifecycle-snapshot.json';

export class WorkspaceStore {
  private workspaceFolder: string | undefined;
  private readonly checkedGitIgnoreRoots = new Set<string>();

  constructor(workspaceFolder?: string) {
    this.workspaceFolder = workspaceFolder;
  }

  setWorkspaceFolder(workspaceFolder: string): void {
    this.workspaceFolder = path.resolve(workspaceFolder);
  }

  getWorkspaceFolder(): string | undefined {
    return this.workspaceFolder;
  }

  async getProfile(): Promise<ConnectionProfile | undefined> {
    const environment = await this.getActiveEnvironment();
    return environment ? toConnectionProfile(environment) : undefined;
  }

  async getEnvironments(): Promise<EnvironmentProfile[]> {
    const workspaceFolder = this.workspaceFolder;
    if (!workspaceFolder) {
      return [];
    }
    const configuration = await this.readEnvironmentConfiguration(workspaceFolder);
    return configuration?.environments.map(environment =>
      toEnvironmentProfile(workspaceFolder, environment)) ?? [];
  }

  async getActiveEnvironment(): Promise<EnvironmentProfile | undefined> {
    const workspaceFolder = this.workspaceFolder;
    if (!workspaceFolder) {
      return undefined;
    }
    const configuration = await this.readEnvironmentConfiguration(workspaceFolder);
    const environment = configuration?.environments.find(
      item => item.id === configuration.activeEnvironmentId,
    );
    return environment
      ? toEnvironmentProfile(workspaceFolder, environment)
      : undefined;
  }

  async getEnvironment(id: string): Promise<EnvironmentProfile | undefined> {
    return (await this.getEnvironments()).find(environment => environment.id === id);
  }

  async saveEnvironment(
    environment: Omit<EnvironmentProfile, 'version' | 'id'> & { id?: string },
    makeActive = true,
  ): Promise<EnvironmentProfile> {
    const workspaceFolder = this.requireWorkspaceFolder(environment.workspaceFolder);
    if (!environment.name.trim()) {
      throw new Error('环境名称不能为空');
    }
    const directoryValidation = validateEnvironmentDirectory(environment.directory);
    if (directoryValidation) {
      throw new Error(directoryValidation);
    }
    const current = await this.readEnvironmentConfiguration(workspaceFolder);
    const saved: EnvironmentProfile = {
      ...environment,
      version: 2,
      id: environment.id ?? randomUUID(),
      directory: environment.directory.trim(),
      workspaceFolder,
    };
    const existingEnvironment = current?.environments.find(item => item.id === saved.id);
    if (
      existingEnvironment
      && pathKey(existingEnvironment.directory) !== pathKey(saved.directory)
    ) {
      throw new Error('环境目录创建后不可修改；如需更换目录，请新增环境');
    }
    const duplicateName = current?.environments.find(item =>
      item.id !== saved.id
      && textKey(item.name.trim()) === textKey(saved.name.trim()));
    if (duplicateName) {
      throw new Error(`工作区中已存在名为“${duplicateName.name}”的环境`);
    }
    const duplicateDirectory = current?.environments.find(item =>
      item.id !== saved.id
      && textKey(item.directory) === textKey(saved.directory));
    if (duplicateDirectory) {
      throw new Error(
        `环境目录“${duplicateDirectory.directory}”已由环境“${duplicateDirectory.name}”使用`,
      );
    }

    resolveEnvironmentSourceRoot(workspaceFolder, saved.directory);
    const stored = toStoredEnvironment(saved);
    const environments = current?.environments.filter(item => item.id !== saved.id) ?? [];
    environments.push(stored);
    const configuration: EnvironmentConfiguration = {
      schemaVersion: 2,
      activeEnvironmentId: makeActive
        ? saved.id
        : current?.activeEnvironmentId ?? saved.id,
      environments,
    };
    await this.writeEnvironmentConfiguration(workspaceFolder, configuration);
    await fs.mkdir(resolveEnvironmentDataRoot(workspaceFolder, saved.directory), {
      recursive: true,
    });
    return saved;
  }

  async setActiveEnvironment(id: string): Promise<EnvironmentProfile> {
    const workspaceFolder = this.requireWorkspaceFolder();
    const configuration = await this.readEnvironmentConfiguration(workspaceFolder);
    const environment = configuration?.environments.find(item => item.id === id);
    if (!configuration || !environment) {
      throw new Error('未找到要切换的 Ecode 环境');
    }
    await this.writeEnvironmentConfiguration(workspaceFolder, {
      ...configuration,
      activeEnvironmentId: id,
    });
    return toEnvironmentProfile(workspaceFolder, environment);
  }

  async deleteEnvironment(id: string): Promise<{
    deletedEnvironment: EnvironmentProfile;
    activeEnvironment: EnvironmentProfile;
    cleanupPendingPath?: string;
  }> {
    const workspaceFolder = this.requireWorkspaceFolder();
    const configuration = await this.readEnvironmentConfiguration(workspaceFolder);
    const environment = configuration?.environments.find(item => item.id === id);
    if (!configuration || !environment) {
      throw new Error('未找到要删除的 Ecode 环境');
    }
    if (configuration.environments.length === 1) {
      throw new Error('不能删除最后一个 Ecode 环境；请先新增其他环境');
    }

    const remaining = configuration.environments.filter(item => item.id !== id);
    const activeEnvironmentId = configuration.activeEnvironmentId === id
      ? remaining[0].id
      : configuration.activeEnvironmentId;
    const activeEnvironment = remaining.find(item => item.id === activeEnvironmentId);
    if (!activeEnvironment) {
      throw new Error('删除环境后无法确定新的活动环境');
    }

    const stagingRoot = resolveEnvironmentDeletionStagingRoot(
      workspaceFolder,
    );
    const cleanupPendingPath = await moveEnvironmentDataAndCommit({
      sourceRoot: resolveEnvironmentSourceRoot(workspaceFolder, environment.directory),
      dataRoot: resolveEnvironmentDataRoot(workspaceFolder, environment.directory),
      stagingRoot,
      commit: () => this.writeEnvironmentConfiguration(workspaceFolder, {
        ...configuration,
        activeEnvironmentId,
        environments: remaining,
      }),
    });
    return {
      deletedEnvironment: toEnvironmentProfile(workspaceFolder, environment),
      activeEnvironment: toEnvironmentProfile(workspaceFolder, activeEnvironment),
      cleanupPendingPath,
    };
  }

  async loadManifest(serverFingerprint: string, syncRoot: string): Promise<SyncManifest> {
    const storageRoot = await this.environmentStorageRoot(syncRoot);
    const empty = (): SyncManifest => ({
      schemaVersion: 1,
      serverFingerprint,
      syncRoot,
      updatedAt: new Date(0).toISOString(),
      files: {},
    });
    try {
      const raw = await fs.readFile(path.join(storageRoot, MANIFEST_FILE), 'utf8');
      const parsed = JSON.parse(raw) as SyncManifest;
      if (
        parsed.schemaVersion !== 1
        || parsed.serverFingerprint !== serverFingerprint
        || path.resolve(parsed.syncRoot) !== path.resolve(syncRoot)
      ) {
        return empty();
      }
      return parsed;
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw new Error(`同步清单读取失败: ${errorMessage(error)}`);
      }
      return empty();
    }
  }

  async saveManifest(manifest: SyncManifest): Promise<void> {
    const root = await this.environmentStorageRoot(manifest.syncRoot);
    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(root, MANIFEST_FILE), manifest);
  }

  async loadFormMetadataCache(
    serverFingerprint: string,
    syncRoot: string,
  ): Promise<FormMetadataCache> {
    const empty = (): FormMetadataCache => ({
      schemaVersion: 1,
      serverFingerprint,
      syncRoot,
      updatedAt: new Date(0).toISOString(),
      files: {},
    });
    try {
      const storageRoot = await this.environmentStorageRoot(syncRoot);
      const raw = await fs.readFile(path.join(storageRoot, FORM_METADATA_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<FormMetadataCache>;
      if (
        parsed.schemaVersion !== 1
        || parsed.serverFingerprint !== serverFingerprint
        || typeof parsed.syncRoot !== 'string'
        || path.resolve(parsed.syncRoot) !== path.resolve(syncRoot)
        || !parsed.files
        || typeof parsed.files !== 'object'
        || Array.isArray(parsed.files)
      ) {
        return empty();
      }
      return {
        ...(parsed as FormMetadataCache),
        files: Object.fromEntries(
          Object.entries(parsed.files)
            .filter((entry): entry is [string, CachedFileFormMetadata] =>
              isCachedFileFormMetadata(entry[1])),
        ),
      };
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw new Error(`表单字段缓存读取失败: ${errorMessage(error)}`);
      }
      return empty();
    }
  }

  async saveFormMetadataCache(cache: FormMetadataCache): Promise<void> {
    cache.updatedAt = new Date().toISOString();
    await writeJsonAtomic(
      path.join(await this.environmentStorageRoot(cache.syncRoot), FORM_METADATA_FILE),
      cache,
    );
  }

  async loadLifecycleSnapshotCache(syncRoot: string): Promise<unknown | undefined> {
    try {
      const storageRoot = await this.environmentStorageRoot(syncRoot);
      const raw = await fs.readFile(
        path.join(storageRoot, LIFECYCLE_SNAPSHOT_FILE),
        'utf8',
      );
      return JSON.parse(raw) as unknown;
    } catch (error: unknown) {
      if (isFileSystemError(error, 'ENOENT')) {
        return undefined;
      }
      throw new Error(`生命周期快照缓存读取失败: ${errorMessage(error)}`);
    }
  }

  async saveLifecycleSnapshotCache(
    syncRoot: string,
    cache: unknown,
  ): Promise<void> {
    await writeJsonAtomic(
      path.join(
        await this.environmentStorageRoot(syncRoot),
        LIFECYCLE_SNAPSHOT_FILE,
      ),
      cache,
    );
  }

  async saveSnapshot(syncRoot: string, content: string): Promise<string> {
    const key = hashText(content);
    const directory = path.join(await this.environmentStorageRoot(syncRoot), 'snapshots');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${key}.txt`);
    try {
      await fs.access(file);
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
      await writeTextAtomic(file, content);
    }
    return key;
  }

  async readSnapshot(syncRoot: string, key: string): Promise<string> {
    return fs.readFile(
      path.join(await this.environmentStorageRoot(syncRoot), 'snapshots', `${key}.txt`),
      'utf8',
    );
  }

  async saveConflict(syncRoot: string, conflict: StoredConflict): Promise<void> {
    const directory = path.join(await this.environmentStorageRoot(syncRoot), 'conflicts');
    await fs.mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, `${hashText(conflict.path)}.json`), conflict);
  }

  async loadConflict(
    syncRoot: string,
    remotePath: string,
  ): Promise<StoredConflict | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(
          await this.environmentStorageRoot(syncRoot),
          'conflicts',
          `${hashText(remotePath)}.json`,
        ),
        'utf8',
      );
      return JSON.parse(raw) as StoredConflict;
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
      return undefined;
    }
  }

  async listConflicts(syncRoot: string): Promise<StoredConflict[]> {
    const directory = path.join(await this.environmentStorageRoot(syncRoot), 'conflicts');
    try {
      const names = await fs.readdir(directory);
      const values = await Promise.all(names
        .filter(name => name.endsWith('.json'))
        .map(async name => {
          try {
            return JSON.parse(
              await fs.readFile(path.join(directory, name), 'utf8'),
            ) as StoredConflict;
          } catch {
            return undefined;
          }
        }));
      return values.filter((value): value is StoredConflict => Boolean(value));
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
      return [];
    }
  }

  async deleteConflict(syncRoot: string, remotePath: string): Promise<void> {
    try {
      await fs.unlink(path.join(
        await this.environmentStorageRoot(syncRoot),
        'conflicts',
        `${hashText(remotePath)}.json`,
      ));
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  async saveRecovery(
    syncRoot: string,
    remotePath: string,
    content: string,
  ): Promise<string> {
    const directory = path.join(await this.environmentStorageRoot(syncRoot), 'recovery');
    await fs.mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `${stamp}-${hashText(remotePath).slice(0, 12)}`;
    for (let suffix = 0; ; suffix++) {
      const file = path.join(
        directory,
        `${baseName}${suffix === 0 ? '' : `-${suffix}`}.txt`,
      );
      try {
        await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
        return file;
      } catch (error: unknown) {
        if (!isFileSystemError(error, 'EEXIST')) {
          throw error;
        }
      }
    }
  }

  private async readEnvironmentConfiguration(
    workspaceFolder: string,
  ): Promise<EnvironmentConfiguration | undefined> {
    const file = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      ECODE_ENVIRONMENTS_FILE,
    );
    try {
      const raw = await fs.readFile(file, 'utf8');
      const value = JSON.parse(raw) as unknown;
      if (!isEnvironmentConfiguration(value)) {
        throw new Error('配置格式或版本无效');
      }
      return value;
    } catch (error: unknown) {
      if (isFileSystemError(error, 'ENOENT')) {
        return undefined;
      }
      throw new Error(`环境配置读取失败: ${errorMessage(error)}`);
    }
  }

  private async writeEnvironmentConfiguration(
    workspaceFolder: string,
    configuration: EnvironmentConfiguration,
  ): Promise<void> {
    await this.ensureGitIgnore(workspaceFolder);
    await writeJsonAtomic(
      path.join(workspaceFolder, ECODE_LOCAL_DIRECTORY, ECODE_ENVIRONMENTS_FILE),
      configuration,
    );
  }

  private async environmentStorageRoot(syncRoot: string): Promise<string> {
    const resolvedSyncRoot = path.resolve(syncRoot);
    const workspaceFolder = path.dirname(resolvedSyncRoot);
    const environmentDirectory = path.basename(resolvedSyncRoot);
    const validation = validateEnvironmentDirectory(environmentDirectory);
    if (validation) {
      throw new Error(`无法确定环境存储目录: ${validation}`);
    }
    this.requireWorkspaceFolder(workspaceFolder);
    const environmentRoot = resolveEnvironmentDataRoot(
      workspaceFolder,
      environmentDirectory,
    );
    await this.ensureGitIgnore(workspaceFolder);
    await fs.mkdir(environmentRoot, { recursive: true });
    return environmentRoot;
  }

  private requireWorkspaceFolder(candidate?: string): string {
    if (candidate) {
      const resolved = path.resolve(candidate);
      if (
        this.workspaceFolder
        && pathKey(this.workspaceFolder) !== pathKey(resolved)
      ) {
        throw new Error('环境不属于当前工作区');
      }
      this.workspaceFolder = resolved;
    }
    if (!this.workspaceFolder) {
      throw new Error('尚未选择工作区文件夹');
    }
    return this.workspaceFolder;
  }

  private async ensureGitIgnore(workspaceFolder: string): Promise<void> {
    const normalizedRoot = path.resolve(workspaceFolder);
    if (this.checkedGitIgnoreRoots.has(normalizedRoot)) {
      return;
    }
    this.checkedGitIgnoreRoots.add(normalizedRoot);
    try {
      if (!await isInsideGitRepository(normalizedRoot)) {
        return;
      }
      const file = path.join(normalizedRoot, '.gitignore');
      let current = '';
      try {
        current = await fs.readFile(file, 'utf8');
      } catch (error: unknown) {
        if (!isFileSystemError(error, 'ENOENT')) {
          throw error;
        }
      }
      const next = updateGitIgnoreForEcodeLocal(current);
      if (next !== current) {
        await writeTextAtomic(file, next);
      }
    } catch {
      // Git 忽略规则是辅助保护，失败不阻断同步。
    }
  }
}

export function updateGitIgnoreForEcodeLocal(current: string): string {
  const alreadyIgnored = current.split(/\r?\n/).some(rawLine => {
    const line = rawLine.trim();
    return !line.startsWith('!')
      && [
        '.ecode-local',
        '.ecode-local/',
        '/.ecode-local',
        '/.ecode-local/',
        '.ecode-local/**',
        '/.ecode-local/**',
      ].includes(line);
  });
  if (alreadyIgnored) {
    return current;
  }
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  let prefix = current;
  if (prefix && !/\r?\n$/.test(prefix)) {
    prefix += eol;
  }
  if (prefix && !prefix.endsWith(`${eol}${eol}`)) {
    prefix += eol;
  }
  return `${prefix}# Ecode Local generated files${eol}/.ecode-local/${eol}`;
}

interface EnvironmentDeletionTransaction {
  sourceRoot: string;
  dataRoot: string;
  stagingRoot: string;
  commit: () => Promise<void>;
}

export async function moveEnvironmentDataAndCommit(
  transaction: EnvironmentDeletionTransaction,
): Promise<string | undefined> {
  const staged = [
    {
      original: transaction.sourceRoot,
      staged: path.join(transaction.stagingRoot, 'source'),
    },
    {
      original: transaction.dataRoot,
      staged: path.join(transaction.stagingRoot, 'data'),
    },
  ];
  const moved: typeof staged = [];
  await fs.mkdir(transaction.stagingRoot, { recursive: true });
  try {
    for (const item of staged) {
      if (await moveIfExists(item.original, item.staged)) {
        moved.push(item);
      }
    }
  } catch (error: unknown) {
    await restoreMovedEnvironmentData(moved, transaction.stagingRoot, error);
    throw error;
  }

  try {
    await transaction.commit();
  } catch (error: unknown) {
    await restoreMovedEnvironmentData(moved, transaction.stagingRoot, error);
    throw error;
  }

  try {
    await fs.rm(transaction.stagingRoot, { recursive: true, force: true });
  } catch {
    // 配置已经提交；保留隔离数据并让调用方提示用户手工清理。
    return transaction.stagingRoot;
  }
  try {
    await removeEmptyDirectory(path.dirname(transaction.stagingRoot));
  } catch {
    // 空的父级隔离目录不包含环境数据，清理失败不影响删除结果。
  }
  return undefined;
}

async function moveIfExists(source: string, destination: string): Promise<boolean> {
  try {
    await fs.rename(source, destination);
    return true;
  } catch (error: unknown) {
    if (isFileSystemError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function restoreMovedEnvironmentData(
  moved: Array<{ original: string; staged: string }>,
  stagingRoot: string,
  originalError: unknown,
): Promise<void> {
  const restoreErrors: string[] = [];
  for (const item of [...moved].reverse()) {
    try {
      await fs.mkdir(path.dirname(item.original), { recursive: true });
      await fs.rename(item.staged, item.original);
    } catch (error: unknown) {
      restoreErrors.push(`${item.original}: ${errorMessage(error)}`);
    }
  }
  if (restoreErrors.length > 0) {
    throw new Error(
      `环境删除失败，且隔离数据恢复不完整: ${errorMessage(originalError)}；`
      + `${restoreErrors.join('；')}；剩余数据位于 ${stagingRoot}`,
    );
  }
  await removeEmptyDirectory(stagingRoot);
  await removeEmptyDirectory(path.dirname(stagingRoot));
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory);
  } catch (error: unknown) {
    if (
      !isFileSystemError(error, 'ENOENT')
      && !isFileSystemError(error, 'ENOTEMPTY')
      && !isFileSystemError(error, 'EEXIST')
    ) {
      throw error;
    }
  }
}

function resolveEnvironmentDeletionStagingRoot(
  workspaceFolder: string,
): string {
  return path.join(
    workspaceFolder,
    ECODE_LOCAL_DIRECTORY,
    'deletion-staging',
    `delete-${randomUUID()}`,
  );
}

async function isInsideGitRepository(directory: string): Promise<boolean> {
  let current = path.resolve(directory);
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return true;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
    }
  }
}

function toStoredEnvironment(environment: EnvironmentProfile): StoredEnvironmentProfile {
  return {
    version: 2,
    id: environment.id,
    name: environment.name,
    directory: environment.directory,
    serverUrl: environment.serverUrl,
    username: environment.username,
  };
}

function toEnvironmentProfile(
  workspaceFolder: string,
  environment: StoredEnvironmentProfile,
): EnvironmentProfile {
  return {
    ...environment,
    workspaceFolder,
  };
}

function toConnectionProfile(environment: EnvironmentProfile): ConnectionProfile {
  return {
    version: 4,
    environmentId: environment.id,
    environmentDirectory: environment.directory,
    workspaceFolder: environment.workspaceFolder,
    serverUrl: environment.serverUrl,
    username: environment.username,
  };
}

function isEnvironmentConfiguration(
  value: unknown,
): value is EnvironmentConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const configuration = value as Partial<EnvironmentConfiguration>;
  if (
    configuration.schemaVersion !== 2
    || typeof configuration.activeEnvironmentId !== 'string'
    || !Array.isArray(configuration.environments)
    || configuration.environments.length === 0
    || !configuration.environments.every(environment =>
      environment?.version === 2
      && typeof environment.id === 'string'
      && typeof environment.name === 'string'
      && Boolean(environment.name.trim())
      && typeof environment.directory === 'string'
      && !validateEnvironmentDirectory(environment.directory)
      && typeof environment.serverUrl === 'string'
      && typeof environment.username === 'string')
    || !configuration.environments.some(
      environment => environment.id === configuration.activeEnvironmentId,
    )
  ) {
    return false;
  }
  const ids = new Set(configuration.environments.map(environment => environment.id));
  const names = new Set(configuration.environments.map(environment =>
    textKey(environment.name.trim())));
  const directories = new Set(configuration.environments.map(environment =>
    textKey(environment.directory)));
  return ids.size === configuration.environments.length
    && names.size === configuration.environments.length
    && directories.size === configuration.environments.length;
}

function isCachedFileFormMetadata(value: unknown): value is CachedFileFormMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const file = value as Record<string, unknown>;
  if (
    typeof file.remoteId !== 'string'
    || typeof file.path !== 'string'
    || typeof file.updatedAt !== 'string'
    || !Array.isArray(file.contexts)
  ) {
    return false;
  }
  return file.contexts.every(contextValue => {
    if (!contextValue || typeof contextValue !== 'object' || Array.isArray(contextValue)) {
      return false;
    }
    const context = contextValue as Record<string, unknown>;
    if (
      !['workflow', 'mode', 'shared'].includes(String(context.kind))
      || !Array.isArray(context.tables)
    ) {
      return false;
    }
    return context.tables.every(tableValue => {
      if (!tableValue || typeof tableValue !== 'object' || Array.isArray(tableValue)) {
        return false;
      }
      const table = tableValue as Record<string, unknown>;
      return (
        typeof table.mark === 'string'
        && (table.mark === 'main' || /^detail_\d+$/.test(table.mark))
        && Array.isArray(table.fields)
        && table.fields.every(fieldValue => {
          if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
            return false;
          }
          const field = fieldValue as Record<string, unknown>;
          return typeof field.id === 'string' && typeof field.label === 'string';
        })
      );
    });
  });
}

function pathKey(value: string): string {
  return path.resolve(value).toLocaleLowerCase('en-US');
}

function textKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
