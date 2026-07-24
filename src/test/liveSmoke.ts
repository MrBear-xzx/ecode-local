import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SecretStorage } from 'vscode';
import { hashText } from '../domain/text';
import type {
  ConnectionProfile,
  StoredConflict,
  SyncManifest,
} from '../domain/types';
import type { WorkspaceStore } from '../storage/WorkspaceStore';
import { EcodeSyncService } from '../sync/EcodeSyncService';
import { FileApi } from '../sync/api/FileApi';
import { AuthManager } from '../sync/auth/AuthManager';

async function main(): Promise<void> {
  const serverUrl = requiredEnvironment('ECODE_SERVER_URL').replace(/\/+$/, '');
  const username = requiredEnvironment('ECODE_USERNAME');
  const password = requiredEnvironment('ECODE_PASSWORD');
  const verifyUpload = process.env.ECODE_VERIFY_SAME_CONTENT_UPLOAD === '1';
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ecode-live-smoke-'));

  try {
    const profile: ConnectionProfile = {
      version: 2,
      workspaceFolder: temporaryRoot,
      serverUrl,
      username,
      localDirectory: 'ecode',
    };
    const secrets = new MemorySecretStorage();
    const auth = new AuthManager({ secrets } as never);
    const login = await auth.connect(profile, password);
    if (!login.success) {
      throw new Error(`连接失败: ${login.message}`);
    }

    const store = new MemoryWorkspaceStore(profile);
    const service = new EcodeSyncService(
      store as unknown as WorkspaceStore,
      auth,
      {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never,
    );

    const pull = await service.pull(() => undefined);
    console.log(JSON.stringify({
      stage: 'pull',
      pulled: pull.pulled,
      conflicts: pull.conflicts,
      unsupported: pull.unsupported,
      failed: pull.failed,
    }));
    if (pull.failed > 0 || pull.conflicts > 0 || pull.pulled === 0) {
      if (pull.pulled === 0) {
        const client = await auth.getAuthenticatedClient(profile);
        const rawTree = client ? await client.get('/api/ecode/type/tree') : undefined;
        console.log(JSON.stringify({ stage: 'tree-shape', value: describeShape(rawTree) }, null, 2));
      }
      throw new Error(`真实拉取未通过: ${pull.errors.slice(0, 3).join('; ')}`);
    }

    const candidate = await smallestManifestFile(
      store.manifest,
      temporaryRoot,
      verifyUpload ? '.css' : undefined,
    );
    const original = await fs.readFile(candidate.localPath, 'utf8');
    await fs.writeFile(candidate.localPath, `${original}\n// ecode-local live smoke\n`, 'utf8');
    const localChanges = await service.refreshLocalChanges();
    const detected = localChanges.some(change =>
      change.path === candidate.remotePath && change.status === 'localModified',
    );
    await fs.writeFile(candidate.localPath, original, 'utf8');
    if (!detected) {
      throw new Error('未能检测临时目录中的本地修改');
    }
    console.log(JSON.stringify({ stage: 'local-diff', detected: true }));

    if (verifyUpload) {
      const client = await auth.getAuthenticatedClient(profile);
      if (!client) {
        throw new Error('上传验证前会话失效');
      }
      const api = new FileApi(client);
      const upload = await api.updateFile(candidate.remoteId, original);
      if (!upload.status) {
        throw new Error(`同内容上传失败: ${upload.msg ?? 'unknown error'}`);
      }
      const remote = await api.viewFile(candidate.remoteId);
      if (!remote.status || remote.data === undefined) {
        throw new Error(`上传后回读失败: ${remote.msg ?? 'unknown error'}`);
      }
      if (remote.data !== original || hashText(remote.data) !== hashText(original)) {
        throw new Error('上传后回读内容与上传前不一致');
      }
      console.log(JSON.stringify({ stage: 'same-content-upload', verified: true }));
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

class MemorySecretStorage {
  private values = new Map<string, string>();

  get onDidChange(): SecretStorage['onDidChange'] {
    return (() => ({ dispose: () => undefined })) as SecretStorage['onDidChange'];
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

class MemoryWorkspaceStore {
  manifest: SyncManifest = {
    schemaVersion: 1,
    serverFingerprint: '',
    syncRoot: '',
    updatedAt: new Date(0).toISOString(),
    files: {},
  };

  private snapshots = new Map<string, string>();
  private conflicts = new Map<string, StoredConflict>();

  constructor(private profile: ConnectionProfile) {}

  async getProfile(): Promise<ConnectionProfile> {
    return this.profile;
  }

  async loadManifest(fingerprint: string, syncRoot: string): Promise<SyncManifest> {
    this.manifest.serverFingerprint = fingerprint;
    this.manifest.syncRoot = syncRoot;
    return this.manifest;
  }

  async saveManifest(manifest: SyncManifest): Promise<void> {
    this.manifest = manifest;
  }

  async saveSnapshot(content: string): Promise<string> {
    const key = hashText(content);
    this.snapshots.set(key, content);
    return key;
  }

  async readSnapshot(key: string): Promise<string> {
    return this.snapshots.get(key) ?? '';
  }

  async saveConflict(conflict: StoredConflict): Promise<void> {
    this.conflicts.set(conflict.path, conflict);
  }

  async loadConflict(remotePath: string): Promise<StoredConflict | undefined> {
    return this.conflicts.get(remotePath);
  }

  async listConflicts(): Promise<StoredConflict[]> {
    return [...this.conflicts.values()];
  }

  async deleteConflict(remotePath: string): Promise<void> {
    this.conflicts.delete(remotePath);
  }

  async saveRecovery(): Promise<string> {
    return '';
  }
}

async function smallestManifestFile(
  manifest: SyncManifest,
  workspaceRoot: string,
  requiredExtension?: string,
): Promise<{ remoteId: string; remotePath: string; localPath: string }> {
  const entries = Object.values(manifest.files).filter(entry =>
    !requiredExtension || entry.path.toLowerCase().endsWith(requiredExtension),
  );
  const candidates = await Promise.all(entries.map(async entry => {
    const localPath = path.join(workspaceRoot, 'ecode', ...entry.path.split('/'));
    const stat = await fs.stat(localPath);
    return { entry, localPath, size: stat.size };
  }));
  const selected = candidates.sort((a, b) => a.size - b.size)[0];
  if (!selected) {
    throw new Error('远端没有可用于验证的文本文件');
  }
  return {
    remoteId: selected.entry.remoteId,
    remotePath: selected.entry.path,
    localPath: selected.localPath,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function describeShape(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return '[max-depth]';
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 2).map(item => describeShape(item, depth + 1)),
    };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, nested]) => [key, describeShape(nested, depth + 1)]),
    );
  }
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  return value;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
