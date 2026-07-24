import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import type {
  ConnectionProfile,
  StoredConflict,
  SyncManifest,
} from '../domain/types';
import { hashText } from '../domain/text';

const PROFILE_KEY = 'ecode.v2.profile';
const MANIFEST_FILE = 'sync-manifest.json';

export class WorkspaceStore {
  private activeFingerprint: string | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  async getProfile(): Promise<ConnectionProfile | undefined> {
    const value = this.context.workspaceState.get<ConnectionProfile>(PROFILE_KEY);
    return value?.version === 2 ? value : undefined;
  }

  async saveProfile(profile: ConnectionProfile): Promise<void> {
    await this.context.workspaceState.update(PROFILE_KEY, profile);
  }

  async loadManifest(serverFingerprint: string, syncRoot: string): Promise<SyncManifest> {
    this.activeFingerprint = serverFingerprint;
    const empty = (): SyncManifest => ({
      schemaVersion: 1,
      serverFingerprint,
      syncRoot,
      updatedAt: new Date(0).toISOString(),
      files: {},
    });

    try {
      const raw = await fs.readFile(path.join(await this.storageRoot(), MANIFEST_FILE), 'utf8');
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
    const root = await this.storageRoot();
    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(root, MANIFEST_FILE), manifest);
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

  private async storageRoot(): Promise<string> {
    const uri = this.context.storageUri;
    if (!uri) {
      throw new Error('当前窗口没有可用的工作区存储');
    }
    await fs.mkdir(uri.fsPath, { recursive: true });
    return uri.fsPath;
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
  const temporary = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}
