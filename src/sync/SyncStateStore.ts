import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { FileDiff } from './api/types';

interface SyncFileEntry {
  hash: string;
  remoteId?: string;
  syncedAt: string;
}

interface SyncManifest {
  version: 1;
  files: Record<string, SyncFileEntry>;
}

/**
 * 本地同步状态清单管理
 * 清单文件存放在工作区根目录，同步目录（ecode/）内只放服务器代码
 */
export class SyncStateStore {
  private manifest: SyncManifest | null = null;

  constructor(
    private syncDir: string,
    private manifestDir: string,
  ) {}

  private getManifestPath(): string {
    return path.join(this.manifestDir, '.ecode', 'sync-state.json');
  }

  /** 读取清单，不存在返回空清单 */
  load(): SyncManifest {
    if (this.manifest) { return this.manifest; }
    const p = this.getManifestPath();
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        this.manifest = JSON.parse(raw) as SyncManifest;
      } else {
        this.manifest = { version: 1, files: {} };
      }
    } catch {
      this.manifest = { version: 1, files: {} };
    }
    return this.manifest;
  }

  /** 持久化清单 */
  save(manifest?: SyncManifest): void {
    const m = manifest ?? this.manifest;
    if (!m) { return; }
    const p = this.getManifestPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf-8');
    this.manifest = m;
  }

  /** 计算文件 SHA-256 */
  computeHash(absPath: string): string {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /** 按路径查询条目 */
  getEntry(relativePath: string): SyncFileEntry | undefined {
    return this.load().files[relativePath];
  }

  /**
   * 更新/新增清单条目
   * @param relativePath 相对路径（posix 风格）
   * @param content 已读取的文件内容（可选，避免重复读盘）
   * @param remoteId 服务器端文件 ID（可选）
   */
  updateEntry(relativePath: string, content?: string, remoteId?: string): void {
    const m = this.load();
    const absPath = path.join(this.syncDir, relativePath);
    const hash = content !== undefined
      ? crypto.createHash('sha256').update(content, 'utf-8').digest('hex')
      : this.computeHash(absPath);

    const prev = m.files[relativePath];
    m.files[relativePath] = {
      hash,
      remoteId: remoteId ?? prev?.remoteId,
      syncedAt: new Date().toISOString(),
    };
    this.save(m);
  }

  /** 删除清单条目 */
  removeEntry(relativePath: string): void {
    const m = this.load();
    delete m.files[relativePath];
    this.save(m);
  }

  /**
   * 递归遍历同步目录，返回 posix 风格相对路径列表
   * 排除清单文件自身和目录
   */
  walkLocalFiles(): string[] {
    const result: string[] = [];

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 权限不足等，跳过
      }

      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(this.syncDir, absPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          walk(absPath);
        } else if (entry.isFile()) {
          result.push(relPath);
        }
      }
    };

    if (fs.existsSync(this.syncDir)) {
      walk(this.syncDir);
    }

    result.sort();
    return result;
  }

  /**
   * 比对本地文件与清单 → 返回差异列表
   */
  diff(): FileDiff[] {
    const diffs: FileDiff[] = [];
    const localFiles = this.walkLocalFiles();
    const manifest = this.load();
    const manifestFiles = new Set(Object.keys(manifest.files));

    for (const relPath of localFiles) {
      manifestFiles.delete(relPath);
      const absPath = path.join(this.syncDir, relPath);

      const entry = manifest.files[relPath];
      if (!entry) {
        // 本地有，清单无 → 新增
        let hash: string | undefined;
        try { hash = this.computeHash(absPath); } catch { /* skip */ }
        if (hash) {
          diffs.push({ path: relPath, status: 'added', localHash: hash });
        }
        continue;
      }

      // 本地有，清单也有 → 比对哈希
      let currentHash: string | undefined;
      try { currentHash = this.computeHash(absPath); } catch { /* skip */ }
      if (currentHash && currentHash !== entry.hash) {
        diffs.push({
          path: relPath,
          status: 'modified',
          localHash: currentHash,
          remoteHash: entry.hash,
        });
      }
    }

    // 清单中剩余条目 → 本地已删除
    for (const relPath of manifestFiles) {
      const entry = manifest.files[relPath];
      diffs.push({
        path: relPath,
        status: 'deleted',
        remoteHash: entry.hash,
      });
    }

    diffs.sort((a, b) => a.path.localeCompare(b.path));
    return diffs;
  }
}
