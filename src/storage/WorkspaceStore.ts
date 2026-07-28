import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import type {
  ConnectionProfile,
  LegacyConnectionProfile,
  StoredConflict,
  SyncManifest,
} from '../domain/types';
import type {
  CachedFileFormMetadata,
  FormMetadataCache,
} from '../domain/formMetadata';
import {
  ECODE_LOCAL_DIRECTORY,
  ECODE_STORAGE_DIRECTORY,
} from '../domain/constants';
import { hashText } from '../domain/text';

const PROFILE_KEY = 'ecode.v3.profile';
const LEGACY_PROFILE_KEY = 'ecode.v2.profile';
const MANIFEST_FILE = 'sync-manifest.json';
const FORM_METADATA_FILE = 'form-metadata.json';

export class WorkspaceStore {
  private activeFingerprint: string | undefined;
  private activeStorageRoot: string | undefined;
  private readonly migratedStorageRoots = new Set<string>();
  private readonly checkedGitIgnoreRoots = new Set<string>();

  constructor(private context: vscode.ExtensionContext) {}

  async getProfile(): Promise<ConnectionProfile | undefined> {
    const value = this.context.workspaceState.get<ConnectionProfile>(PROFILE_KEY);
    return value?.version === 3 ? value : undefined;
  }

  async getLegacyProfile(): Promise<LegacyConnectionProfile | undefined> {
    const value = this.context.workspaceState
      .get<LegacyConnectionProfile>(LEGACY_PROFILE_KEY);
    return value?.version === 2 ? value : undefined;
  }

  async saveProfile(profile: ConnectionProfile): Promise<void> {
    await this.context.workspaceState.update(PROFILE_KEY, profile);
  }

  async clearLegacyProfile(): Promise<void> {
    await this.context.workspaceState.update(LEGACY_PROFILE_KEY, undefined);
  }

  async loadManifest(serverFingerprint: string, syncRoot: string): Promise<SyncManifest> {
    this.activeFingerprint = serverFingerprint;
    const storageRoot = await this.storageRoot(syncRoot);
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
    } catch {
      return empty();
    }
  }

  async saveManifest(manifest: SyncManifest): Promise<void> {
    const root = await this.storageRoot(manifest.syncRoot);
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
      const storageRoot = await this.storageRoot(syncRoot);
      const raw = await fs.readFile(
        path.join(storageRoot, FORM_METADATA_FILE),
        'utf8',
      );
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
    } catch {
      return empty();
    }
  }

  async saveFormMetadataCache(cache: FormMetadataCache): Promise<void> {
    cache.updatedAt = new Date().toISOString();
    await writeJsonAtomic(
      path.join(await this.storageRoot(cache.syncRoot), FORM_METADATA_FILE),
      cache,
    );
  }

  async saveSnapshot(content: string): Promise<string> {
    const key = hashText(content);
    const directory = path.join(await this.storageRoot(), 'snapshots');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${key}.txt`);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, content, 'utf8');
    }
    return key;
  }

  async readSnapshot(key: string): Promise<string> {
    return fs.readFile(path.join(await this.storageRoot(), 'snapshots', `${key}.txt`), 'utf8');
  }

  async saveConflict(conflict: StoredConflict): Promise<void> {
    const directory = await this.conflictDirectory();
    await fs.mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, `${hashText(conflict.path)}.json`), conflict);
  }

  async loadConflict(remotePath: string): Promise<StoredConflict | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(await this.conflictDirectory(), `${hashText(remotePath)}.json`),
        'utf8',
      );
      return JSON.parse(raw) as StoredConflict;
    } catch {
      return undefined;
    }
  }

  async listConflicts(): Promise<StoredConflict[]> {
    const directory = await this.conflictDirectory();
    try {
      const names = await fs.readdir(directory);
      const conflicts = await Promise.all(names
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
      return conflicts.filter((item): item is StoredConflict => Boolean(item));
    } catch {
      return [];
    }
  }

  async deleteConflict(remotePath: string): Promise<void> {
    try {
      await fs.unlink(
        path.join(await this.conflictDirectory(), `${hashText(remotePath)}.json`),
      );
    } catch {
      // 冲突文件不存在时无需处理。
    }
  }

  async saveRecovery(remotePath: string, content: string): Promise<string> {
    const directory = path.join(await this.storageRoot(), 'recovery');
    await fs.mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `${stamp}-${hashText(remotePath).slice(0, 12)}.txt`);
    await fs.writeFile(file, content, 'utf8');
    return file;
  }

  private async storageRoot(syncRoot?: string): Promise<string> {
    if (syncRoot) {
      const workspaceFolder = path.dirname(path.resolve(syncRoot));
      this.activeStorageRoot = path.join(
        workspaceFolder,
        ECODE_LOCAL_DIRECTORY,
        ECODE_STORAGE_DIRECTORY,
      );
    }
    if (!this.activeStorageRoot) {
      throw new Error('同步清单尚未加载，无法确定工作区存储目录');
    }
    const workspaceFolder = path.dirname(path.dirname(this.activeStorageRoot));
    await this.ensureGitIgnore(workspaceFolder);
    await fs.mkdir(this.activeStorageRoot, { recursive: true });
    await this.migrateLegacyStorage(this.activeStorageRoot);
    return this.activeStorageRoot;
  }

  private async migrateLegacyStorage(targetRoot: string): Promise<void> {
    const normalizedTarget = path.resolve(targetRoot);
    if (this.migratedStorageRoots.has(normalizedTarget)) {
      return;
    }
    this.migratedStorageRoots.add(normalizedTarget);
    const legacyRoot = this.context.storageUri?.fsPath;
    if (!legacyRoot || path.resolve(legacyRoot) === normalizedTarget) {
      return;
    }
    for (const name of [
      MANIFEST_FILE,
      FORM_METADATA_FILE,
      'snapshots',
      'conflicts',
      'recovery',
    ]) {
      const source = path.join(legacyRoot, name);
      const target = path.join(targetRoot, name);
      try {
        await fs.cp(source, target, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      } catch (error: unknown) {
        if (!isFileSystemError(error, 'ENOENT')) {
          throw error;
        }
      }
    }
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
      // Git 忽略规则属于辅助保护，写入失败不能阻断源码同步。
    }
  }

  private async conflictDirectory(): Promise<string> {
    if (!this.activeFingerprint) {
      throw new Error('同步清单尚未加载，无法访问冲突存储');
    }
    return path.join(
      await this.storageRoot(),
      'conflicts',
      hashText(this.activeFingerprint).slice(0, 24),
    );
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

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}
