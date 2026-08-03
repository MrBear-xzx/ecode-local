import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ECODE_LOCAL_DIRECTORY } from '../domain/constants';
import type {
  ConnectionProfile,
  EnvironmentProfile,
  PromotionCandidate,
  PushRecord,
  SyncChange,
  SyncOperationResult,
} from '../domain/types';
import { writeJsonAtomic } from '../storage/AtomicFileStore';
import type { WorkspaceStore } from '../storage/WorkspaceStore';
import type { EcodeSyncService } from '../sync/EcodeSyncService';
import {
  AI_PUSH_REQUEST_DIRECTORY,
  AI_PUSH_RESULT_DIRECTORY,
  type AiPushRequest,
  type AiPushResult,
  parseAiPushRequest,
} from './AiPushRequest';

export interface PushExecution {
  result: SyncOperationResult;
  record?: PushRecord;
}

type ExecutePush = (
  profile: ConnectionProfile,
  environment: EnvironmentProfile,
  selectedPaths: string[],
  promotionCandidates: PromotionCandidate[],
) => Promise<PushExecution | undefined>;

export class AiPushRequestController implements vscode.Disposable {
  private watcher: vscode.Disposable | undefined;
  private readonly processing = new Map<string, number>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private configurationGeneration = 0;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly service: EcodeSyncService,
    private readonly output: vscode.LogOutputChannel,
    private readonly isBusy: () => boolean,
    private readonly setChanges: (changes: SyncChange[]) => void,
    private readonly isPushable: (change: SyncChange) => boolean,
    private readonly executePush: ExecutePush,
    private readonly showResult: (
      operation: string,
      result: SyncOperationResult,
    ) => void,
  ) {}

  configure(workspaceFolder: string): void {
    const generation = ++this.configurationGeneration;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.clearPendingTimers();
    const requestsRoot = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      AI_PUSH_REQUEST_DIRECTORY,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(requestsRoot, '*.json'),
    );
    const schedule = (uri: vscode.Uri): void => {
      const requestFile = uri.fsPath;
      const existing = this.pendingTimers.get(requestFile);
      if (existing) {
        clearTimeout(existing);
      }
      this.pendingTimers.set(requestFile, setTimeout(() => {
        this.pendingTimers.delete(requestFile);
        void this.processRequestFile(workspaceFolder, requestFile, generation);
      }, 200));
    };
    this.watcher = vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
    );
    void this.processPendingRequests(workspaceFolder, generation);
  }

  dispose(): void {
    this.configurationGeneration++;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.clearPendingTimers();
  }

  private clearPendingTimers(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private async processPendingRequests(
    workspaceFolder: string,
    generation: number,
  ): Promise<void> {
    const requestsRoot = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      AI_PUSH_REQUEST_DIRECTORY,
    );
    try {
      const names = await fs.promises.readdir(requestsRoot);
      if (!this.isCurrent(generation)) {
        return;
      }
      for (const name of names.filter(item => item.endsWith('.json'))) {
        if (!this.isCurrent(generation)) {
          return;
        }
        await this.processRequestFile(
          workspaceFolder,
          path.join(requestsRoot, name),
          generation,
        );
      }
    } catch (error: unknown) {
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!isFileSystemError(error, 'ENOENT')) {
        this.output.warn(`Unable to scan AI push requests: ${errorMessage(error)}`);
      }
    }
  }

  private async processRequestFile(
    workspaceFolder: string,
    requestFile: string,
    generation: number,
  ): Promise<void> {
    const fileName = path.basename(requestFile);
    const fallbackId = path.basename(fileName, '.json');
    if (
      !this.isCurrent(generation)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(fallbackId)
      || this.processing.get(requestFile) === generation
    ) {
      return;
    }
    const resultFile = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      AI_PUSH_RESULT_DIRECTORY,
      `${fallbackId}.json`,
    );
    if (fs.existsSync(resultFile)) {
      return;
    }
    this.processing.set(requestFile, generation);
    let request: AiPushRequest | undefined;
    try {
      request = await this.readStableRequest(requestFile, fileName, generation);
      if (!request || !this.isCurrent(generation)) {
        return;
      }
      const environment = await this.store.getActiveEnvironment();
      if (!this.isCurrent(generation)) {
        return;
      }
      const profile = await this.store.getProfile();
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!environment || !profile) {
        throw new Error('当前没有活动环境');
      }
      if (request.environmentDirectory !== environment.directory) {
        await this.writeResult(resultFile, {
          schemaVersion: 1,
          id: request.id,
          action: 'push',
          environmentDirectory: request.environmentDirectory,
          processedAt: new Date().toISOString(),
          status: 'rejected',
          message: `当前活动环境目录为 ${environment.directory}，请先人工切换环境`,
        }, generation);
        return;
      }
      if (this.isBusy()) {
        await this.writeResult(resultFile, {
          schemaVersion: 1,
          id: request.id,
          action: 'push',
          environmentDirectory: request.environmentDirectory,
          processedAt: new Date().toISOString(),
          status: 'failed',
          message: '已有同步操作正在执行，请使用新的请求 id 重试',
        }, generation);
        return;
      }
      if (!await this.service.hasSyncBaseline()) {
        throw new Error('当前环境尚未建立同步基线，请先人工执行全量拉取');
      }
      if (!this.isCurrent(generation)) {
        return;
      }
      const changes = await this.service.refreshLocalChanges();
      if (!this.isCurrent(generation)) {
        return;
      }
      this.setChanges(changes);
      const pushable = new Set(changes.filter(this.isPushable).map(change => change.path));
      const unavailable = request.paths.filter(item => !pushable.has(item));
      if (unavailable.length > 0) {
        throw new Error(`以下路径不是当前可推送的本地变更：${unavailable.join('、')}`);
      }
      const candidates = await this.service.preparePromotionCandidates(request.paths);
      if (!this.isCurrent(generation)) {
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        `AI 请求向“${environment.name}”（${profile.serverUrl}）推送 `
          + `${request.paths.length} 个文件。请求 ${request.id}。`
          + '扩展仍会执行远端冲突检查和推送后回读校验。',
        { modal: true },
        '确认 AI 推送',
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      if (confirmation !== '确认 AI 推送') {
        await this.writeResult(resultFile, {
          schemaVersion: 1,
          id: request.id,
          action: 'push',
          environmentDirectory: request.environmentDirectory,
          processedAt: new Date().toISOString(),
          status: 'cancelled',
          message: '用户未确认推送',
        }, generation);
        return;
      }
      const execution = await this.executePush(
        profile,
        environment,
        request.paths,
        candidates,
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!execution) {
        await this.writeResult(resultFile, {
          schemaVersion: 1,
          id: request.id,
          action: 'push',
          environmentDirectory: request.environmentDirectory,
          processedAt: new Date().toISOString(),
          status: 'failed',
          message: '推送未完成，详情见 Ecode Output',
        }, generation);
        return;
      }
      this.showResult('AI 推送', execution.result);
      await this.writeResult(resultFile, {
        schemaVersion: 1,
        id: request.id,
        action: 'push',
        environmentDirectory: request.environmentDirectory,
        processedAt: new Date().toISOString(),
        status: execution.result.success && execution.record?.status === 'succeeded'
          ? 'succeeded'
          : execution.record ? 'partial' : 'failed',
        pushRecordId: execution.record?.id,
        result: execution.result,
        message: execution.record
          ? `已保存推送记录“${execution.record.name}”（${execution.record.id}）`
          : '没有文件通过推送后回读验证',
      }, generation);
    } catch (error: unknown) {
      if (!this.isCurrent(generation) || isFileSystemError(error, 'ENOENT')) {
        return;
      }
      const message = errorMessage(error);
      this.output.warn(`AI push request ${fallbackId} rejected: ${message}`);
      await this.writeResult(resultFile, {
        schemaVersion: 1,
        id: request?.id ?? fallbackId,
        action: 'push',
        environmentDirectory: request?.environmentDirectory,
        processedAt: new Date().toISOString(),
        status: 'rejected',
        message,
      }, generation);
    } finally {
      if (this.processing.get(requestFile) === generation) {
        this.processing.delete(requestFile);
      }
    }
  }

  private async readStableRequest(
    requestFile: string,
    fileName: string,
    generation: number,
  ): Promise<AiPushRequest | undefined> {
    let previous: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!this.isCurrent(generation)) {
        return undefined;
      }
      const current = await fs.promises.readFile(requestFile, 'utf8');
      if (!this.isCurrent(generation)) {
        return undefined;
      }
      if (current === previous) {
        return parseAiPushRequest(current, fileName);
      }
      previous = current;
      await delay(100);
    }
    return parseAiPushRequest(previous ?? '', fileName);
  }

  private async writeResult(
    file: string,
    result: AiPushResult,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }
    await writeJsonAtomic(file, result);
  }

  private isCurrent(generation: number): boolean {
    return generation === this.configurationGeneration;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
