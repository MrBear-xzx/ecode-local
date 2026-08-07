import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ECODE_LOCAL_DIRECTORY } from '../domain/constants';
import { writeJsonAtomic } from '../storage/AtomicFileStore';
import {
  AI_EXECUTE_ACTIONS,
  AI_INSPECT_ACTIONS,
  CLI_REQUEST_DIRECTORY,
  CLI_RESULT_DIRECTORY,
  type AiAction,
  type AiInvocation,
  type AiInvocationResult,
  type AiRequest,
  type AiResult,
  parseAiRequest,
} from './AiRequest';

const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_SCAN_INTERVAL_MS = 500;
const REQUEST_HISTORY_LIMIT = 500;
const REQUEST_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SUPPORTED_ACTIONS = new Set<string>([
  ...AI_INSPECT_ACTIONS,
  ...AI_EXECUTE_ACTIONS,
]);

interface RejectedRequestMetadata {
  action?: AiAction;
  environmentDirectory?: string;
}

class InvalidAiRequestError extends Error {
  constructor(
    message: string,
    readonly metadata: RejectedRequestMetadata,
  ) {
    super(message);
    this.name = 'InvalidAiRequestError';
  }
}

export interface AiInvocationContext {
  requestId?: string;
  environmentDirectory?: string;
}

export type ExecuteAiInvocation = (
  invocation: AiInvocation,
  context: AiInvocationContext,
) => Promise<AiInvocationResult>;

export class AiRequestController implements vscode.Disposable {
  private watcher: vscode.Disposable | undefined;
  private requestScanTimer: NodeJS.Timeout | undefined;
  private readonly processing = new Map<string, number>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private configurationGeneration = 0;
  private configuredWorkspaceFolder: string | undefined;

  constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly execute: ExecuteAiInvocation,
    private readonly historyLimit = REQUEST_HISTORY_LIMIT,
    private readonly historyRetentionMs = REQUEST_HISTORY_RETENTION_MS,
  ) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new Error('AI 请求历史保留数量必须是正整数');
    }
    if (!Number.isFinite(historyRetentionMs) || historyRetentionMs < 1) {
      throw new Error('AI 请求历史保留时间必须是正数');
    }
  }

  configure(workspaceFolder: string): void {
    const workspaceKey = path.resolve(workspaceFolder).toLocaleLowerCase('en-US');
    if (workspaceKey === this.configuredWorkspaceFolder && this.watcher) {
      return;
    }
    this.configuredWorkspaceFolder = workspaceKey;
    const generation = ++this.configurationGeneration;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.clearPendingTimers();
    this.clearRequestScanTimer();
    const requestsRoot = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      CLI_REQUEST_DIRECTORY,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(requestsRoot, '*.json'),
    );
    const schedule = (uri: vscode.Uri): void => {
      const requestFile = uri.fsPath;
      if (pathKey(path.dirname(requestFile)) !== pathKey(requestsRoot)) {
        return;
      }
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
    this.scheduleRequestScan(workspaceFolder, generation);
  }

  dispose(): void {
    this.configurationGeneration++;
    this.configuredWorkspaceFolder = undefined;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.clearPendingTimers();
    this.clearRequestScanTimer();
  }

  private clearPendingTimers(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private clearRequestScanTimer(): void {
    if (this.requestScanTimer) {
      clearTimeout(this.requestScanTimer);
      this.requestScanTimer = undefined;
    }
  }

  private scheduleRequestScan(
    workspaceFolder: string,
    generation: number,
  ): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    this.clearRequestScanTimer();
    this.requestScanTimer = setTimeout(() => {
      this.requestScanTimer = undefined;
      void this.processPendingRequests(workspaceFolder, generation)
        .finally(() => this.scheduleRequestScan(workspaceFolder, generation));
    }, REQUEST_SCAN_INTERVAL_MS);
  }

  private async processPendingRequests(
    workspaceFolder: string,
    generation: number,
  ): Promise<void> {
    const requestsRoot = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      CLI_REQUEST_DIRECTORY,
    );
    try {
      let names = await fs.promises.readdir(requestsRoot);
      if (!this.isCurrent(generation)) {
        return;
      }
      try {
        names = await this.cleanupRequestHistory(
          workspaceFolder,
          names,
          generation,
        );
      } catch (error: unknown) {
        if (this.isCurrent(generation)) {
          this.output.warn(`Unable to clean AI request history: ${errorMessage(error)}`);
        }
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
      if (this.isCurrent(generation) && !isFileSystemError(error, 'ENOENT')) {
        this.output.warn(`Unable to scan AI requests: ${errorMessage(error)}`);
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
      CLI_RESULT_DIRECTORY,
      `${fallbackId}.json`,
    );
    if (fs.existsSync(resultFile)) {
      return;
    }
    this.processing.set(requestFile, generation);
    let request: AiRequest | undefined;
    try {
      request = await this.readStableRequest(requestFile, fileName, generation);
      if (!request || !this.isCurrent(generation)) {
        return;
      }
      if (Date.parse(request.expiresAt) <= Date.now()) {
        throw new Error('AI 请求已过期，未执行操作');
      }
      const outcome = await this.execute(request, {
        requestId: request.id,
        environmentDirectory: request.environmentDirectory,
      });
      if (!this.isCurrent(generation)) {
        return;
      }
      await this.writeResult(resultFile, {
        schemaVersion: 2,
        id: request.id,
        action: request.action,
        environmentDirectory: request.environmentDirectory,
        processedAt: new Date().toISOString(),
        ...outcome,
      }, generation);
    } catch (error: unknown) {
      if (!this.isCurrent(generation) || isFileSystemError(error, 'ENOENT')) {
        return;
      }
      const message = errorMessage(error);
      const metadata = error instanceof InvalidAiRequestError
        ? error.metadata
        : undefined;
      this.output.warn(`AI request ${fallbackId} rejected: ${message}`);
      await this.writeResult(resultFile, {
        schemaVersion: 2,
        id: request?.id ?? fallbackId,
        action: request?.action ?? metadata?.action ?? 'getState',
        environmentDirectory: request?.environmentDirectory ?? metadata?.environmentDirectory,
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
  ): Promise<AiRequest | undefined> {
    let previous: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!this.isCurrent(generation)) {
        return undefined;
      }
      const stat = await fs.promises.stat(requestFile);
      if (stat.size > MAX_REQUEST_BYTES) {
        throw new Error(`AI 请求不能超过 ${MAX_REQUEST_BYTES} 字节`);
      }
      const current = await fs.promises.readFile(requestFile, 'utf8');
      if (!this.isCurrent(generation)) {
        return undefined;
      }
      if (current === previous) {
        return parseStableAiRequest(current, fileName);
      }
      previous = current;
      await delay(100);
    }
    return parseStableAiRequest(previous ?? '', fileName);
  }

  private async cleanupRequestHistory(
    workspaceFolder: string,
    requestNames: string[],
    generation: number,
  ): Promise<string[]> {
    const requestsRoot = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      CLI_REQUEST_DIRECTORY,
    );
    const resultsRoot = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      CLI_RESULT_DIRECTORY,
    );
    const resultNames = await readDirectoryIfExists(resultsRoot);
    const names = [...new Set([...requestNames, ...resultNames])]
      .filter(name => /^[A-Za-z0-9_-]{1,64}\.json$/.test(name));
    const entries = (await Promise.all(names.map(async name => {
      const requestFile = path.join(requestsRoot, name);
      const [requestStat, resultStat] = await Promise.all([
        statIfExists(requestFile),
        statIfExists(path.join(resultsRoot, name)),
      ]);
      // 只有已经产生结果的请求才属于历史记录；待处理请求不能因数量或时间限制被静默删除。
      if (!resultStat) {
        return undefined;
      }
      return {
        name,
        requestFile,
        timestamp: Math.max(
          requestStat?.mtimeMs ?? 0,
          resultStat?.mtimeMs ?? 0,
        ),
      };
    }))).filter((entry): entry is {
      name: string;
      requestFile: string;
      timestamp: number;
    } => Boolean(entry));
    if (!this.isCurrent(generation)) {
      return requestNames;
    }

    const removable = entries.filter(entry =>
      this.processing.get(entry.requestFile) !== generation);
    const removeNames = new Set(
      removable
        .filter(entry => Date.now() - entry.timestamp > this.historyRetentionMs)
        .map(entry => entry.name),
    );
    const retained = entries
      .filter(entry => !removeNames.has(entry.name))
      .sort((left, right) => right.timestamp - left.timestamp);
    for (const entry of retained.slice(this.historyLimit)) {
      if (this.processing.get(entry.requestFile) !== generation) {
        removeNames.add(entry.name);
      }
    }

    await Promise.all([...removeNames].flatMap(name => [
      unlinkIfExists(path.join(requestsRoot, name)),
      unlinkIfExists(path.join(resultsRoot, name)),
    ]));
    return requestNames.filter(name => !removeNames.has(name));
  }

  private async writeResult(
    file: string,
    result: AiResult,
    generation: number,
  ): Promise<void> {
    if (this.isCurrent(generation)) {
      await writeJsonAtomic(file, result);
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.configurationGeneration;
  }
}

function parseStableAiRequest(raw: string, fileName: string): AiRequest {
  try {
    return parseAiRequest(raw, fileName);
  } catch (error: unknown) {
    throw new InvalidAiRequestError(
      errorMessage(error),
      rejectedRequestMetadata(raw),
    );
  }
}

function rejectedRequestMetadata(raw: string): RejectedRequestMetadata {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const action = typeof record.action === 'string' && SUPPORTED_ACTIONS.has(record.action)
    ? record.action as AiAction
    : undefined;
  const environmentDirectory = typeof record.environmentDirectory === 'string'
    ? record.environmentDirectory
    : undefined;
  return { action, environmentDirectory };
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

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function readDirectoryIfExists(directory: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(directory);
  } catch (error: unknown) {
    if (isFileSystemError(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

async function statIfExists(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(file);
  } catch (error: unknown) {
    if (isFileSystemError(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

async function unlinkIfExists(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch (error: unknown) {
    if (!isFileSystemError(error, 'ENOENT')) {
      throw error;
    }
  }
}
