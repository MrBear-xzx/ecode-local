import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AuthManager } from './auth/AuthManager';
import { FileApi } from './api/FileApi';

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
  private localDir: string;
  private autoSyncEnabled: boolean;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private authManager: AuthManager,
    private output: vscode.LogOutputChannel,
  ) {
    this.localDir = vscode.workspace.getConfiguration('ecode').get<string>('localDir') || 'ecode';
    this.autoSyncEnabled = vscode.workspace.getConfiguration('ecode').get<boolean>('sync.autoPushOnSave') ?? true;
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
   */
  async pull(
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
  ): Promise<{ downloaded: number; failed: number; errors: string[] }> {
    const api = await this.getFileApi();
    if (!api) { throw new Error('Not connected'); }

    const localDir = this.getLocalDir();
    let downloaded = 0;
    let failed = 0;
    const errors: string[] = [];

    const root = await this.getFileTree();
    const systemNode = root.find(n => n.attribute === 'system');
    const types = root.filter(n => n.attribute !== 'system');

    // system 节点（工具包等）
    if (systemNode?.hasChild) {
      if (token?.isCancellationRequested) { return { downloaded, failed, errors }; }
      await this.pullType(api, systemNode.id, systemNode.name, localDir,
        (d, f, e) => { downloaded += d; failed += f; errors.push(...e); },
        onProgress, token);
    }

    // 各分类
    for (const t of types) {
      if (token?.isCancellationRequested) { break; }
      await this.pullType(api, t.id, t.name, localDir,
        (d, f, e) => { downloaded += d; failed += f; errors.push(...e); },
        onProgress, token);
    }

    this.output.info(`pull done: ${downloaded} ok, ${failed} failed`);
    return { downloaded, failed, errors };
  }

  private async pullType(
    api: FileApi,
    typeId: string,
    typePath: string,
    localDir: string,
    onResult: (d: number, f: number, e: string[]) => void,
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
  ): Promise<void> {
    const result = await this.fetchTree(api, '', typeId);
    if (!result || token?.isCancellationRequested) { return; }

    for (const file of result.childFile) {
      if (token?.isCancellationRequested) { return; }
      await this.downloadOne(file, typePath, localDir, onProgress, onResult);
    }

    for (const folder of result.childFolder) {
      if (token?.isCancellationRequested) { return; }
      await this.pullFolder(api, folder.id, `${typePath}/${folder.name}`, localDir,
        onResult, onProgress, token);
    }

    for (const sub of result.typeList) {
      if (token?.isCancellationRequested) { return; }
      await this.pullType(api, sub.id, `${typePath}/${sub.name}`, localDir,
        onResult, onProgress, token);
    }
  }

  private async pullFolder(
    api: FileApi,
    folderId: string,
    folderPath: string,
    localDir: string,
    onResult: (d: number, f: number, e: string[]) => void,
    onProgress: (msg: string) => void,
    token?: { isCancellationRequested: boolean },
  ): Promise<void> {
    const result = await this.fetchTree(api, folderId, '');
    if (!result || token?.isCancellationRequested) { return; }

    for (const file of result.childFile) {
      if (token?.isCancellationRequested) { return; }
      await this.downloadOne(file, folderPath, localDir, onProgress, onResult);
    }

    for (const folder of result.childFolder) {
      if (token?.isCancellationRequested) { return; }
      await this.pullFolder(api, folder.id, `${folderPath}/${folder.name}`, localDir,
        onResult, onProgress, token);
    }

    for (const sub of result.typeList) {
      if (token?.isCancellationRequested) { return; }
      await this.pullType(api, sub.id, `${folderPath}/${sub.name}`, localDir,
        onResult, onProgress, token);
    }
  }

  private async downloadOne(
    file: TreeNode,
    parentPath: string,
    localDir: string,
    onProgress: (msg: string) => void,
    onResult: (d: number, f: number, e: string[]) => void,
  ): Promise<void> {
    onProgress(parentPath);
    const localPath = path.join(localDir, parentPath, file.name);
    try {
      const api = await this.getFileApi();
      if (!api) { throw new Error('Not connected'); }
      const content = await api.viewFile(file.id);
      if (!content.status || content.data === undefined) {
        throw new Error(content.msg || 'Failed to get file content');
      }
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(localPath, content.data, 'utf-8');
      onResult(1, 0, []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onResult(0, 1, [`${parentPath}/${file.name}: ${msg}`]);
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

  enableAutoSync(context: vscode.ExtensionContext): void {
    if (this.disposables.length > 0) { return; }

    const watcher = vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc));
    this.disposables.push(watcher);
    context.subscriptions.push(watcher);

    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ecode.sync.autoPushOnSave')) {
        this.autoSyncEnabled = vscode.workspace.getConfiguration('ecode').get<boolean>('sync.autoPushOnSave') ?? true;
      }
      if (e.affectsConfiguration('ecode.localDir')) {
        this.localDir = vscode.workspace.getConfiguration('ecode').get<string>('localDir') || 'ecode';
      }
    });
    this.disposables.push(configWatcher);
    context.subscriptions.push(configWatcher);

    this.output.info('Auto-sync enabled');
  }

  disableAutoSync(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }

  private async onSave(doc: vscode.TextDocument): Promise<void> {
    if (!this.autoSyncEnabled) { return; }

    const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!wsFolder) { return; }

    const dir = path.join(wsFolder.uri.fsPath, this.localDir);
    if (!doc.uri.fsPath.startsWith(dir)) { return; }

    const remotePath = path.relative(dir, doc.uri.fsPath).replace(/\\/g, '/');

    try {
      const api = await this.getFileApi();
      if (!api) {
        vscode.window.showWarningMessage('Ecode: Not connected, file not synced');
        return;
      }
      await api.push(doc.uri.fsPath, remotePath);
      this.output.info(`Synced: ${remotePath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.error(`Sync failed: ${msg}`);
      vscode.window.showErrorMessage(`Ecode sync failed: ${msg}`);
    }
  }

  getLocalDir(workspaceFolder?: vscode.WorkspaceFolder): string {
    const wsFolder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) {
      return path.join(wsFolder.uri.fsPath, this.localDir);
    }
    return path.join(vscode.workspace.rootPath || '', this.localDir);
  }
}
