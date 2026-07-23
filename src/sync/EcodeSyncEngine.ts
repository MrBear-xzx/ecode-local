import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AuthManager } from './auth/AuthManager';
import { FileApi } from './api/FileApi';
import { GitManager } from './GitManager';
import { LOCAL_SYNC_DIR, MAIN_BRANCH } from '../constants';
import type { FileDiff, FileLineDiff, PushSummary, SyncResult } from './api/types';

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
  private gitManager: GitManager | null = null;

  constructor(
    private authManager: AuthManager,
    private output: vscode.LogOutputChannel,
  ) {}

  // ==================== 初始化 ====================

  /**
   * 首次启动初始化：检查 git 环境、初始化仓库、确保 main 分支存在
   * 不执行拉取操作（拉取由上层 pullCode 负责，含 UI 交互）
   * @returns true 表示初始化/就绪成功，false 表示用户需要手动处理
   */
  async initialize(): Promise<boolean> {
    // 1. 检查 git 是否安装
    if (!(await GitManager.isGitInstalled())) {
      vscode.window.showErrorMessage(
        'Ecode: 未检测到 Git，请先安装 Git 并添加到 PATH 环境变量',
      );
      this.output.error('Git not installed');
      return false;
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage('Ecode: 请先打开一个工作区文件夹');
      return false;
    }

    this.gitManager = new GitManager(wsFolder.uri.fsPath);

    // 2. 检查是否已 git init
    const isRepo = await this.gitManager.isGitRepo();

    if (!isRepo) {
      // 3.1 未初始化：git init → 重命名为 main
      try {
        await this.gitManager.initRepo();
        this.output.info('git init + branch main created');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ecode 初始化失败: ${msg}`);
        this.output.error(`Init failed: ${err}`);
        return false;
      }
    } else {
      // 3.2 已初始化：确保 main 分支存在（master → main 自动迁移）
      await this.gitManager.ensureMainBranch();
      this.output.info('main branch ensured');
    }

    return true;
  }

  /** 检查 git 环境是否就绪 */
  async isGitReady(): Promise<boolean> {
    return this.gitManager !== null && (await this.gitManager.isGitRepo());
  }

  /** 获取 GitManager 实例 */
  getGitManager(): GitManager | null {
    return this.gitManager;
  }

  private async getFileApi(): Promise<FileApi | null> {
    if (this.fileApi) { return this.fileApi; }
    const client = await this.authManager.getClient();
    if (!client) { return null; }
    this.fileApi = new FileApi(client);
    return this.fileApi;
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

    // 一次性获取所有本地有变更的文件列表（供每个 downloadOne 复用，避免每文件调一次 git diff）
    const dirtyFiles = await this.getDirtyFileSet();

    const localDir = this.getLocalDir();
    const result: SyncResult = { success: true, pulled: 0, pushed: 0, failed: 0, conflicts: [], errors: [] };

    const root = await this.getFileTree();
    const systemNode = root.find(n => n.attribute === 'system');
    const types = root.filter(n => n.attribute !== 'system');

    // system 节点（工具包等）
    if (systemNode?.hasChild) {
      if (token?.isCancellationRequested) { return result; }
      await this.pullType(api, systemNode.id, systemNode.name, localDir, result, onProgress, token, dirtyFiles);
    }

    // 各分类
    for (const t of types) {
      if (token?.isCancellationRequested) { break; }
      await this.pullType(api, t.id, t.name, localDir, result, onProgress, token, dirtyFiles);
    }

    result.success = result.failed === 0;
    this.output.info(`pull done: ${result.pulled} ok, ${result.failed} failed, ${result.conflicts.length} conflicts`);
    return result;
  }

  /** 获取本地有变更的文件路径集合（用于 pull 冲突检测） */
  private async getDirtyFileSet(): Promise<Set<string>> {
    if (!this.gitManager) { return new Set(); }
    try {
      const [changed, untracked] = await Promise.all([
        this.gitManager.getChangedFiles(),
        this.gitManager.getUntrackedFiles(),
      ]);
      return new Set([...changed, ...untracked]);
    } catch {
      return new Set();
    }
  }

  private async pullType(
    api: FileApi,
    typeId: string,
    typePath: string,
    localDir: string,
    syncResult: SyncResult,
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
    dirtyFiles?: Set<string>,
  ): Promise<void> {
    const result = await this.fetchTree(api, '', typeId);
    if (!result || token?.isCancellationRequested) { return; }

    for (const file of result.childFile) {
      if (token?.isCancellationRequested) { return; }
      await this.downloadOne(file, typePath, localDir, syncResult, onProgress, dirtyFiles);
    }

    for (const folder of result.childFolder) {
      if (token?.isCancellationRequested) { return; }
      await this.pullFolder(api, folder.id, `${typePath}/${folder.name}`, localDir, syncResult, onProgress, token, dirtyFiles);
    }

    for (const sub of result.typeList) {
      if (token?.isCancellationRequested) { return; }
      await this.pullType(api, sub.id, `${typePath}/${sub.name}`, localDir, syncResult, onProgress, token, dirtyFiles);
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
    dirtyFiles?: Set<string>,
  ): Promise<void> {
    const result = await this.fetchTree(api, folderId, '');
    if (!result || token?.isCancellationRequested) { return; }

    for (const file of result.childFile) {
      if (token?.isCancellationRequested) { return; }
      await this.downloadOne(file, folderPath, localDir, syncResult, onProgress, dirtyFiles);
    }

    for (const folder of result.childFolder) {
      if (token?.isCancellationRequested) { return; }
      await this.pullFolder(api, folder.id, `${folderPath}/${folder.name}`, localDir, syncResult, onProgress, token, dirtyFiles);
    }

    for (const sub of result.typeList) {
      if (token?.isCancellationRequested) { return; }
      await this.pullType(api, sub.id, `${folderPath}/${sub.name}`, localDir, syncResult, onProgress, token, dirtyFiles);
    }
  }

  private async downloadOne(
    file: TreeNode,
    parentPath: string,
    localDir: string,
    syncResult: SyncResult,
    onProgress: (msg: string) => void,
    dirtyFiles?: Set<string>,
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

      // 保护拉取：检查本地是否有未提交的修改（使用预计算的 dirtyFiles 集合）
      if (dirtyFiles) {
        const relPath = path.relative(this.getLocalDir(), localPath).replace(/\\/g, '/');
        if (dirtyFiles.has(relPath)) {
          this.output.warn(`Conflict: ${remotePath} — local modifications would be overwritten`);
          syncResult.conflicts.push(remotePath);
          return;
        }
      }

      // 正常写入
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(localPath, content.data, 'utf-8');

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

  // ==================== 分支 ====================

  /** 从 main 分支创建开发分支 */
  async startDevBranch(branchName: string): Promise<void> {
    if (!this.gitManager) {
      throw new Error('Git 环境未初始化');
    }
    await this.gitManager.createBranch(branchName);
    this.output.info(`Branch created: ${branchName}`);
  }

  // ==================== PUSH ====================

  /**
   * 获取推送摘要（含行级别差异）
   */
  async getPushSummary(): Promise<PushSummary> {
    if (!this.gitManager) {
      throw new Error('Git 环境未初始化');
    }

    const currentBranch = await this.gitManager.getCurrentBranch();
    const serverUrl = vscode.workspace.getConfiguration('ecode').get<string>('server.url') || '';

    const changes = await this.getAllChanges();

    const totalAdditions = changes.reduce((s, d) => s + d.additions, 0);
    const totalDeletions = changes.reduce((s, d) => s + d.deletions, 0);

    return {
      baseBranch: MAIN_BRANCH,
      currentBranch,
      serverUrl,
      changes,
      totalAdditions,
      totalDeletions,
    };
  }

  /**
   * 检查 main 分支是否有未提交更改（dirty 检查）
   */
  async isMainDirty(): Promise<boolean> {
    if (!this.gitManager) { return false; }
    const branch = await this.gitManager.getCurrentBranch();
    if (branch !== MAIN_BRANCH) { return false; }
    return this.gitManager.isDirty();
  }

  /**
   * 获取本地变更状态（基于 main 与当前工作区的差异）
   * 向后兼容 pushChanged()
   */
  async getStatus(): Promise<FileDiff[]> {
    if (!this.gitManager) {
      // 降级：无 git 环境时返回空
      return [];
    }

    const diffs: FileDiff[] = (await this.getAllChanges()).map(change => ({
      path: change.path,
      status: change.status,
    }));

    const counts: Record<string, number> = { added: 0, modified: 0, deleted: 0 };
    for (const d of diffs) { counts[d.status] = (counts[d.status] || 0) + 1; }
    this.output.info(`Status: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted`);
    return diffs;
  }

  /** 合并已跟踪差异与真正的未跟踪文件。 */
  private async getAllChanges(): Promise<FileLineDiff[]> {
    if (!this.gitManager) { return []; }

    const changes = await this.gitManager.getDiffSummary();
    const untracked = await this.getUntrackedChanges();
    for (const change of untracked) {
      if (!changes.some(existing => existing.path === change.path)) {
        changes.push(change);
      }
    }
    return changes;
  }

  /** 检查本地是否有未跟踪的新增文件 */
  private async getUntrackedChanges(): Promise<FileLineDiff[]> {
    const localDir = this.getLocalDir();
    const result: FileLineDiff[] = [];
    if (!this.gitManager || !fs.existsSync(localDir)) { return result; }

    const files = await this.gitManager.getUntrackedFiles();
    for (const relPath of files) {
      const absPath = path.join(localDir, relPath);
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
        result.push({
          path: relPath,
          status: 'added',
          additions: lineCount,
          deletions: 0,
          hunks: [],
          truncated: false,
        });
      } catch { /* skip unreadable files */ }
    }

    return result;
  }

  /**
   * 增量推送 — 仅推送有变更的文件
   * @param files 可选，不传则自动 getStatus() 获取差异
   */
  async pushChanged(files?: FileDiff[]): Promise<SyncResult> {
    const api = await this.getFileApi();
    if (!api) { throw new Error('Not connected'); }

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
        result.pushed++;
        this.output.info(`Pushed: ${diff.path}`);
      } catch (err: unknown) {
        result.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${diff.path}: ${msg}`);
        this.output.error(`Push failed: ${diff.path} — ${msg}`);
      }
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
