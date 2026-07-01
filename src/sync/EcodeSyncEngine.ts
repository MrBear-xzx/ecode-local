import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AuthManager } from './auth/AuthManager';
import { FileApi } from './api/FileApi';
import { SyncStateStore } from './SyncStateStore';
import { LOCAL_SYNC_DIR } from '../constants';
import type { FileDiff, SyncResult } from './api/types';

interface TreeNode {
  id: string;
  name: string;
  attribute: string;
  hasChild: boolean;
  parentId: string;
}

/**
 * Ecode 同步引擎
 */
export class EcodeSyncEngine {
  private fileApi: FileApi | null = null;
  private stateStore: SyncStateStore | null = null;

  constructor(
    private authManager: AuthManager,
    private output: vscode.LogOutputChannel,
  ) {}

  private async getFileApi(): Promise<FileApi | null> {
    if (this.fileApi) { return this.fileApi; }
    const client = await this.authManager.getClient();
    if (!client) { return null; }
    this.fileApi = new FileApi(client);
    return this.fileApi;
  }

  private getStateStore(): SyncStateStore {
    if (!this.stateStore) {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      const manifestDir = wsFolder?.uri.fsPath ?? vscode.workspace.rootPath ?? '';
      this.stateStore = new SyncStateStore(this.getLocalDir(), manifestDir);
    }
    return this.stateStore;
  }

  // ==================== PULL ====================

  /**
   * 获取根文件树（system + typeList 分类列表）
   */
  async getFileTree(): Promise<TreeNode[]> {
    const api = await this.getFileApi();
    if (!api) { throw new Error('Not connected'); }

    const result = await api.listTree();
    if (!result.status) {
      throw new Error(result.msg || 'Failed to get file tree');
    }

    let raw: Record<string, unknown> = {};
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      const d = result.data as Record<string, unknown>;
      if (d.data && typeof d.data === 'object') {
        raw = d.data as Record<string, unknown>;
      } else {
        raw = d;
      }
    } else {
      raw = result as unknown as Record<string, unknown>;
    }

    const nodes: TreeNode[] = [];
    if (raw.system) { nodes.push(raw.system as TreeNode); }
    if (raw.typeList) { nodes.push(...(raw.typeList as TreeNode[])); }
    if (raw.childFolder) { nodes.push(...(raw.childFolder as TreeNode[])); }
    if (raw.childFile) { nodes.push(...(raw.childFile as TreeNode[])); }

    this.output.info(`Tree: ${nodes.length} nodes`);
    return nodes;
  }

  /**
   * pull — 全量递归下载所有文件到本地
   * 拉取前检查本地是否有未推送的修改，有则跳过并记录冲突
   */
  async pull(
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
  ): Promise<SyncResult> {
    const api = await this.getFileApi();
    if (!api) { throw new Error('Not connected'); }

    const localDir = this.getLocalDir();
    const result: SyncResult = { success: true, pulled: 0, pushed: 0, failed: 0, conflicts: [], errors: [] };

    const root = await this.getFileTree();
    const systemNode = root.find(n => n.attribute === 'system');
    const types = root.filter(n => n.attribute !== 'system');

    // system 节点（工具包等）
    if (systemNode?.hasChild) {
      if (token?.isCancellationRequested) { return result; }
      await this.pullType(api, systemNode.id, systemNode.name, localDir, result, onProgress, token);
    }

    // 各分类
    for (const t of types) {
      if (token?.isCancellationRequested) { break; }
      await this.pullType(api, t.id, t.name, localDir, result, onProgress, token);
    }

    result.success = result.failed === 0;
    this.output.info(`pull done: ${result.pulled} ok, ${result.failed} failed, ${result.conflicts.length} conflicts`);
    return result;
  }

  private async pullType(
    api: FileApi,
    typeId: string,
    typePath: string,
    localDir: string,
    syncResult: SyncResult,
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
  ): Promise<void> {
    const result = await this.fetchTree(api, '', typeId);
    if (!result || token?.isCancellationRequested) { return; }

    for (const file of result.childFile) {
      if (token?.isCancellationRequested) { return; }
      await this.downloadOne(file, typePath, localDir, syncResult, onProgress);
    }

    for (const folder of result.childFolder) {
      if (token?.isCancellationRequested) { return; }
      await this.pullFolder(api, folder.id, `${typePath}/${folder.name}`, localDir, syncResult, onProgress, token);
    }

    for (const sub of result.typeList) {
      if (token?.isCancellationRequested) { return; }
      await this.pullType(api, sub.id, `${typePath}/${sub.name}`, localDir, syncResult, onProgress, token);
    }
  }

  private async pullFolder(
    api: FileApi,
    folderId: string,
    folderPath: string,
    localDir: string,
    syncResult: SyncResult,
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
  ): Promise<void> {
    const result = await this.fetchTree(api, folderId, '');
    if (!result || token?.isCancellationRequested) { return; }

    for (const file of result.childFile) {
      if (token?.isCancellationRequested) { return; }
      await this.downloadOne(file, folderPath, localDir, syncResult, onProgress);
    }

    for (const folder of result.childFolder) {
      if (token?.isCancellationRequested) { return; }
      await this.pullFolder(api, folder.id, `${folderPath}/${folder.name}`, localDir, syncResult, onProgress, token);
    }

    for (const sub of result.typeList) {
      if (token?.isCancellationRequested) { return; }
      await this.pullType(api, sub.id, `${folderPath}/${sub.name}`, localDir, syncResult, onProgress, token);
    }
  }

  private async downloadOne(
    file: TreeNode,
    parentPath: string,
    localDir: string,
    syncResult: SyncResult,
    onProgress: (msg: string) => void,
  ): Promise<void> {
    onProgress(parentPath);
    const localPath = path.join(localDir, parentPath, file.name);
    const remotePath = parentPath ? `${parentPath}/${file.name}` : file.name;

    try {
      const api = await this.getFileApi();
      if (!api) { throw new Error('Not connected'); }
      const content = await api.viewFile(file.id);
      if (!content.status || content.data === undefined) {
        throw new Error(content.msg || 'Failed to get file content');
      }

      const store = this.getStateStore();

      // 保护拉取：检查本地是否有未推送的修改
      if (fs.existsSync(localPath)) {
        let localHash: string;
        try {
          localHash = store.computeHash(localPath);
        } catch {
          localHash = '';
        }

        const storedEntry = store.getEntry(remotePath);
        if (storedEntry && localHash && localHash !== storedEntry.hash) {
          // 本地有未推送的修改 → 跳过，记录冲突
          this.output.warn(`Conflict: ${remotePath} — local modifications would be overwritten`);
          syncResult.conflicts.push(remotePath);
          return;
        }
      }

      // 正常写入
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(localPath, content.data, 'utf-8');

      // 更新清单基线
      store.updateEntry(remotePath, content.data, file.id);

      syncResult.pulled++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      syncResult.failed++;
      syncResult.errors.push(`${parentPath}/${file.name}: ${msg}`);
      this.output.error(`FAIL: ${parentPath}/${file.name} — ${msg}`);
    }
  }

  /**
   * 安全调用 listTree，提取 childFolder / childFile / typeList
   */
  private async fetchTree(
    api: FileApi,
    folderId: string,
    typeId: string,
  ): Promise<{ childFolder: TreeNode[]; childFile: TreeNode[]; typeList: TreeNode[] } | null> {
    const result = folderId
      ? await api.listTree(folderId, '')
      : await api.listTree('', typeId);

    if (!result.status) {
      this.output.warn(`fetchTree failed: folderId=${folderId} typeId=${typeId}`);
      return null;
    }

    let data: Record<string, unknown> | undefined;
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      const d = result.data as Record<string, unknown>;
      data = (d.data && typeof d.data === 'object') ? d.data as Record<string, unknown> : d;
    } else if (typeof result.data !== 'string') {
      data = result as unknown as Record<string, unknown>;
    }

    return {
      childFolder: (data?.childFolder as TreeNode[]) || [],
      childFile: (data?.childFile as TreeNode[]) || [],
      typeList: (data?.typeList as TreeNode[]) || [],
    };
  }

  // ==================== PUSH ====================

  /**
   * 获取本地变更状态（added / modified / deleted）
   */
  async getStatus(): Promise<FileDiff[]> {
    const store = this.getStateStore();
    const diffs = store.diff();
    const counts: Record<string, number> = { added: 0, modified: 0, deleted: 0 };
    for (const d of diffs) { counts[d.status]++; }
    this.output.info(`Status: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted`);
    return diffs;
  }

  /**
   * 增量推送 — 仅推送有变更的文件
   * @param files 可选，不传则自动 getStatus() 获取差异
   */
  async pushChanged(files?: FileDiff[]): Promise<SyncResult> {
    const api = await this.getFileApi();
    if (!api) { throw new Error('Not connected'); }

    const store = this.getStateStore();
    const diffs = files ?? await this.getStatus();
    const toPush = diffs.filter(d => d.status === 'added' || d.status === 'modified');

    const result: SyncResult = { success: true, pulled: 0, pushed: 0, failed: 0, conflicts: [], errors: [] };
    const localDir = this.getLocalDir();

    for (const diff of toPush) {
      const localPath = path.join(localDir, diff.path);
      const remotePath = diff.path; // posix 风格

      if (!fs.existsSync(localPath)) {
        // 文件在 diff 后、push 前被删除
        result.failed++;
        result.errors.push(`${diff.path}: file deleted before push`);
        continue;
      }

      try {
        await api.push(localPath, remotePath);
        store.updateEntry(diff.path);
        result.pushed++;
        this.output.info(`Pushed: ${diff.path}`);
      } catch (err: unknown) {
        result.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${diff.path}: ${msg}`);
        this.output.error(`Push failed: ${diff.path} — ${msg}`);
      }
    }

    // 已删除的文件从清单中清理（服务器无删除 API）
    const deleted = diffs.filter(d => d.status === 'deleted');
    for (const d of deleted) {
      store.removeEntry(d.path);
      this.output.info(`Removed from manifest (deleted locally): ${d.path}`);
    }

    result.success = result.failed === 0;
    this.output.info(`Push done: ${result.pushed} pushed, ${result.failed} failed`);
    return result;
  }

  // ==================== UTIL ====================

  getLocalDir(workspaceFolder?: vscode.WorkspaceFolder): string {
    const wsFolder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) {
      return path.join(wsFolder.uri.fsPath, LOCAL_SYNC_DIR);
    }
    return path.join(vscode.workspace.rootPath || '', LOCAL_SYNC_DIR);
  }
}
