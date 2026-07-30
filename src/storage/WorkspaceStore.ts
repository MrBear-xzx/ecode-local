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

const MANIFEST_FILE = 'sync-manifest.json';
const FORM_METADATA_FILE = 'form-metadata.json';

export class WorkspaceStore {
  private workspaceFolder: string | undefined;
  private activeEnvironmentRoot: string | undefined;
  private readonly checkedGitIgnoreRoots = new Set<string>();

  constructor(workspaceFolder?: string) {
    this.workspaceFolder = workspaceFolder;
  }

  setWorkspaceFolder(workspaceFolder: string): void {
    this.workspaceFolder = path.resolve(workspaceFolder);
    this.activeEnvironmentRoot = undefined;
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
    this.activeEnvironmentRoot = undefined;
    return toEnvironmentProfile(workspaceFolder, environment);
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

  async saveSnapshot(content: string): Promise<string> {
    const key = hashText(content);
    const directory = path.join(await this.requireEnvironmentRoot(), 'snapshots');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${key}.txt`);
    try {
      await fs.access(file);
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
      await fs.writeFile(file, content, 'utf8');
    }
    return key;
  }

  async readSnapshot(key: string): Promise<string> {
    return fs.readFile(
      path.join(await this.requireEnvironmentRoot(), 'snapshots', `${key}.txt`),
      'utf8',
    );
  }

  async saveConflict(conflict: StoredConflict): Promise<void> {
    const directory = path.join(await this.requireEnvironmentRoot(), 'conflicts');
    await fs.mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, `${hashText(conflict.path)}.json`), conflict);
  }

  async loadConflict(remotePath: string): Promise<StoredConflict | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(
          await this.requireEnvironmentRoot(),
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

  async listConflicts(): Promise<StoredConflict[]> {
    const directory = path.join(await this.requireEnvironmentRoot(), 'conflicts');
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

  async deleteConflict(remotePath: string): Promise<void> {
    try {
      await fs.unlink(path.join(
        await this.requireEnvironmentRoot(),
        'conflicts',
        `${hashText(remotePath)}.json`,
      ));
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  async saveRecovery(remotePath: string, content: string): Promise<string> {
    const directory = path.join(await this.requireEnvironmentRoot(), 'recovery');
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
    this.activeEnvironmentRoot = environmentRoot;
    await this.ensureGitIgnore(workspaceFolder);
    await fs.mkdir(environmentRoot, { recursive: true });
    return environmentRoot;
  }

  private async requireEnvironmentRoot(): Promise<string> {
    if (!this.activeEnvironmentRoot) {
      throw new Error('同步清单尚未加载，无法确定环境存储目录');
    }
    await fs.mkdir(this.activeEnvironmentRoot, { recursive: true });
    return this.activeEnvironmentRoot;
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

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, file);
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
