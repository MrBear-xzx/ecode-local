import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ECODE_LOCAL_DIRECTORY,
  ECODE_PROMOTION_DIRECTORY,
} from '../domain/constants';
import { hashFileBytes, hashText } from '../domain/text';
import type {
  ChangeSet,
  ChangeSetFile,
  DeploymentRecord,
  LifecycleChange,
  LifecycleChangeRecord,
  PromotionCandidate,
  PushRecord,
  ReleaseArtifact,
} from '../domain/types';
import {
  copyFileAtomic,
  writeJsonAtomic,
  writeTextAtomic,
} from './AtomicFileStore';

export class PromotionStore {
  private readonly root: string;

  constructor(workspaceFolder: string) {
    this.root = path.join(
      workspaceFolder,
      ECODE_LOCAL_DIRECTORY,
      ECODE_PROMOTION_DIRECTORY,
    );
  }

  async createChangeSet(
    name: string,
    sourceEnvironmentId: string,
  ): Promise<ChangeSet> {
    const now = new Date().toISOString();
    const changeSet: ChangeSet = {
      schemaVersion: 3,
      id: `CS-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`,
      name: name.trim(),
      sourceEnvironmentId,
      createdAt: now,
      updatedAt: now,
      files: {},
      lifecycleChanges: {},
    };
    await this.writeEntity('change-sets', changeSet.id, changeSet);
    return changeSet;
  }

  async getChangeSet(id: string): Promise<ChangeSet | undefined> {
    const stored = await this.readEntity<ChangeSet>('change-sets', id);
    return stored ? normalizeStoredChangeSet(stored) : undefined;
  }

  async listChangeSets(): Promise<ChangeSet[]> {
    return (await this.listEntities<ChangeSet>('change-sets'))
      .map(normalizeStoredChangeSet);
  }

  async deleteChangeSet(id: string): Promise<void> {
    if (!isEntityId(id)) {
      throw new Error('变更集标识无效');
    }
    try {
      await fs.unlink(path.join(this.root, 'change-sets', `${id}.json`));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('变更集不存在或已取消');
      }
      throw error;
    }
  }

  async recordVerifiedCandidates(
    changeSetId: string,
    candidates: PromotionCandidate[],
  ): Promise<ChangeSet> {
    const changeSet = await this.getChangeSet(changeSetId);
    if (!changeSet) {
      throw new Error('变更集不存在');
    }
    for (const candidate of candidates) {
      const existing = changeSet.files[candidate.path];
      const baseHash = existing ? existing.baseHash : candidate.baseHash;
      const baseSnapshotKey = existing
        ? existing.baseSnapshotKey
        : await this.saveCandidateObject(
          candidate.kind ?? 'text',
          candidate.baseContent,
          candidate.baseResourcePath,
        );
      const resultSnapshotKey = await this.saveCandidateObject(
        candidate.kind ?? 'text',
        candidate.resultContent,
        candidate.resultResourcePath,
      );

      if (
        candidate.operation === 'delete'
        && (existing?.operation === 'add' || (!existing && baseHash === undefined))
      ) {
        delete changeSet.files[candidate.path];
        continue;
      }

      const operation = baseHash === undefined
        ? 'add'
        : candidate.resultHash === undefined ? 'delete' : 'modify';
      const file: ChangeSetFile = {
        path: candidate.path,
        operation,
        kind: candidate.kind ?? 'text',
        size: candidate.size,
        baseHash,
        baseSnapshotKey,
        resultHash: candidate.resultHash,
        resultSnapshotKey,
        verifiedAt: new Date().toISOString(),
      };
      changeSet.files[candidate.path] = file;
    }
    changeSet.updatedAt = new Date().toISOString();
    validateChangeSet(changeSet);
    await this.writeEntity('change-sets', changeSet.id, changeSet);
    return changeSet;
  }

  async recordLifecycleChange(
    environmentId: string,
    change: LifecycleChange,
  ): Promise<LifecycleChangeRecord> {
    const now = new Date().toISOString();
    const record: LifecycleChangeRecord = {
      schemaVersion: 1,
      id: `LIFECYCLE-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`,
      environmentId,
      createdAt: now,
      change: { ...change, verifiedAt: now },
    };
    await this.writeEntity('lifecycle-records', record.id, record);
    return record;
  }

  async listLifecycleRecords(
    environmentId?: string,
  ): Promise<LifecycleChangeRecord[]> {
    return (await this.listEntities<LifecycleChangeRecord>('lifecycle-records'))
      .filter(isLifecycleChangeRecord)
      .filter(record => !environmentId || record.environmentId === environmentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async deleteLifecycleRecord(id: string): Promise<void> {
    if (!isEntityId(id)) {
      throw new Error('生命周期记录标识无效');
    }
    try {
      await fs.unlink(path.join(this.root, 'lifecycle-records', `${id}.json`));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('生命周期记录不存在或已删除');
      }
      throw error;
    }
  }

  async recordLifecycleChanges(
    changeSetId: string,
    changes: LifecycleChange[],
  ): Promise<ChangeSet> {
    const changeSet = await this.getChangeSet(changeSetId);
    if (!changeSet) {
      throw new Error('变更集不存在');
    }
    const lifecycleChanges = changeSet.lifecycleChanges ?? {};
    for (const change of changes) {
      const key = lifecycleChangeKey(change);
      const existing = lifecycleChanges[key];
      const folded = foldLifecycleChange(existing, change);
      if (folded) {
        lifecycleChanges[key] = folded;
      } else {
        delete lifecycleChanges[key];
      }
    }
    changeSet.schemaVersion = 3;
    changeSet.lifecycleChanges = lifecycleChanges;
    changeSet.updatedAt = new Date().toISOString();
    validateChangeSet(changeSet);
    await this.writeEntity('change-sets', changeSet.id, changeSet);
    return changeSet;
  }

  async recordPush(
    environmentId: string,
    candidates: PromotionCandidate[],
    requestedPaths: string[],
    name?: string,
  ): Promise<PushRecord> {
    if (candidates.length === 0) {
      throw new Error('没有成功推送并回读验证的文件，无法生成推送记录');
    }
    const now = new Date().toISOString();
    const files: ChangeSetFile[] = [];
    for (const candidate of candidates) {
      files.push({
        path: candidate.path,
        operation: candidate.operation,
        baseHash: candidate.baseHash,
        kind: candidate.kind ?? 'text',
        size: candidate.size,
        baseSnapshotKey: await this.saveCandidateObject(
          candidate.kind ?? 'text',
          candidate.baseContent,
          candidate.baseResourcePath,
        ),
        resultHash: candidate.resultHash,
        resultSnapshotKey: await this.saveCandidateObject(
          candidate.kind ?? 'text',
          candidate.resultContent,
          candidate.resultResourcePath,
        ),
        verifiedAt: now,
      });
    }
    const successfulPaths = new Set(files.map(file => file.path));
    const record: PushRecord = {
      schemaVersion: 2,
      id: `PUSH-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`,
      name: normalizePushRecordName(name, now),
      environmentId,
      createdAt: now,
      status: requestedPaths.every(item => successfulPaths.has(item))
        ? 'succeeded'
        : 'partial',
      requestedPaths: [...requestedPaths],
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
    await this.writeEntity('push-records', record.id, record);
    return record;
  }

  async listPushRecords(environmentId?: string): Promise<PushRecord[]> {
    const records = await this.listEntities<PushRecord>('push-records');
    return records
      .map(normalizeStoredPushRecord)
      .filter(record => !environmentId || record.environmentId === environmentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async renamePushRecord(id: string, name: string): Promise<PushRecord> {
    const record = await this.readEntity<PushRecord>('push-records', id);
    if (!record) {
      throw new Error('推送记录不存在或已删除');
    }
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error('推送记录名称不能为空');
    }
    const updated = {
      ...normalizeStoredPushRecord(record),
      name: normalizedName,
    };
    await this.writeEntity('push-records', id, updated);
    return updated;
  }

  async deletePushRecord(id: string): Promise<void> {
    if (!isEntityId(id)) {
      throw new Error('推送记录标识无效');
    }
    try {
      await fs.unlink(path.join(this.root, 'push-records', `${id}.json`));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('推送记录不存在或已删除');
      }
      throw error;
    }
  }

  async materializePushRecord(
    record: PushRecord,
  ): Promise<PromotionCandidate[]> {
    return this.materializeCandidateFiles(record.files);
  }

  async materializeChangeSetCandidates(
    changeSet: ChangeSet,
  ): Promise<PromotionCandidate[]> {
    return this.materializeCandidateFiles(Object.values(changeSet.files));
  }

  private async materializeCandidateFiles(
    files: ChangeSetFile[],
  ): Promise<PromotionCandidate[]> {
    return Promise.all(files.map(async file => {
      const kind = file.kind ?? 'text';
      const baseContent = kind === 'text' && file.baseSnapshotKey
        ? await this.readObject(file.baseSnapshotKey)
        : undefined;
      const resultContent = kind === 'text' && file.resultSnapshotKey
        ? await this.readObject(file.resultSnapshotKey)
        : undefined;
      const baseResourcePath = kind === 'resource' && file.baseSnapshotKey
        ? await this.readObjectPath(file.baseSnapshotKey, kind)
        : undefined;
      const resultResourcePath = kind === 'resource' && file.resultSnapshotKey
        ? await this.readObjectPath(file.resultSnapshotKey, kind)
        : undefined;
      if (baseContent !== undefined && file.baseHash !== hashText(baseContent)) {
        throw new Error(`${file.path}: 推送前源码快照校验失败`);
      }
      if (resultContent !== undefined && file.resultHash !== hashText(resultContent)) {
        throw new Error(`${file.path}: 推送后源码快照校验失败`);
      }
      return {
        path: file.path,
        operation: file.operation,
        kind,
        size: file.size,
        baseHash: file.baseHash,
        baseContent,
        baseResourcePath,
        resultHash: file.resultHash,
        resultContent,
        resultResourcePath,
      };
    }));
  }

  async materializeChangeSet(changeSet: ChangeSet): Promise<ReleaseArtifact[]> {
    return this.materializeFiles(Object.values(changeSet.files));
  }

  private async materializeFiles(files: ChangeSetFile[]): Promise<ReleaseArtifact[]> {
    return Promise.all(files.map(async file => {
      const kind = file.kind ?? 'text';
      const resultContent = kind === 'text' && file.resultSnapshotKey
        ? await this.readObject(file.resultSnapshotKey)
        : undefined;
      const resultResourcePath = kind === 'resource' && file.resultSnapshotKey
        ? await this.readObjectPath(file.resultSnapshotKey, kind)
        : undefined;
      if (
        resultContent !== undefined
        && file.resultHash !== hashText(resultContent)
      ) {
        throw new Error(`${file.path}: 变更集源码快照校验失败`);
      }
      return {
        path: file.path,
        operation: file.operation,
        kind,
        size: file.size,
        baseHash: file.baseHash,
        resultHash: file.resultHash,
        resultContent,
        resultResourcePath,
      };
    }));
  }

  async saveDeployment(record: DeploymentRecord): Promise<void> {
    await this.writeEntity('deployments', record.id, record);
  }

  async listDeployments(): Promise<DeploymentRecord[]> {
    return this.listEntities<DeploymentRecord>('deployments');
  }

  private async saveObject(content: string): Promise<string> {
    const key = hashText(content);
    const file = path.join(this.root, 'objects', `${key}.txt`);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeTextAtomic(file, content);
    }
    return key;
  }

  private async saveCandidateObject(
    kind: 'text' | 'resource',
    content: string | undefined,
    resourcePath: string | undefined,
  ): Promise<string | undefined> {
    if (kind === 'text') {
      return content === undefined ? undefined : this.saveObject(content);
    }
    if (!resourcePath) {
      return undefined;
    }
    const { hash } = await hashFileBytes(resourcePath);
    const file = path.join(this.root, 'objects', `${hash}.bin`);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await copyFileAtomic(file, resourcePath);
      if ((await hashFileBytes(file)).hash !== hash) {
        await fs.unlink(file);
        throw new Error('资源对象在保存期间发生变化');
      }
    }
    return hash;
  }

  private async readObject(key: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new Error('变更集对象标识无效');
    }
    const content = await fs.readFile(
      path.join(this.root, 'objects', `${key}.txt`),
      'utf8',
    );
    if (hashText(content) !== key) {
      throw new Error('变更集对象存储校验失败');
    }
    return content;
  }

  private async readObjectPath(
    key: string,
    kind: 'text' | 'resource',
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new Error('变更集对象标识无效');
    }
    const file = path.join(
      this.root,
      'objects',
      `${key}.${kind === 'resource' ? 'bin' : 'txt'}`,
    );
    if (kind === 'resource' && (await hashFileBytes(file)).hash !== key) {
      throw new Error('变更集资源对象存储校验失败');
    }
    return file;
  }

  private async readEntity<T>(directory: string, id: string): Promise<T | undefined> {
    if (!isEntityId(id)) {
      return undefined;
    }
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.root, directory, `${id}.json`), 'utf8'),
      ) as T;
    } catch {
      return undefined;
    }
  }

  private async listEntities<T>(directory: string): Promise<T[]> {
    const root = path.join(this.root, directory);
    try {
      const names = await fs.readdir(root);
      const values: T[] = [];
      for (const name of names.filter(item => item.endsWith('.json'))) {
        try {
          values.push(JSON.parse(
            await fs.readFile(path.join(root, name), 'utf8'),
          ) as T);
        } catch {
          // 单条损坏记录不影响读取其他发布历史。
        }
      }
      return values;
    } catch {
      return [];
    }
  }

  private async writeEntity(
    directory: string,
    id: string,
    value: unknown,
  ): Promise<void> {
    if (!isEntityId(id)) {
      throw new Error('发布记录标识无效');
    }
    await writeJsonAtomic(path.join(this.root, directory, `${id}.json`), value);
  }
}

function compactTimestamp(iso: string): string {
  return iso.replace(/\D/g, '').slice(0, 14);
}

function normalizePushRecordName(name: string | undefined, createdAt: string): string {
  const normalized = name?.trim();
  return normalized || new Date(createdAt).toLocaleString();
}

function normalizeStoredPushRecord(record: PushRecord): PushRecord {
  const storedName = (record as PushRecord & { name?: unknown }).name;
  return {
    ...record,
    schemaVersion: 2,
    name: typeof storedName === 'string' && storedName.trim()
      ? storedName.trim()
      : new Date(record.createdAt).toLocaleString(),
    files: record.files.map(file => ({
      ...file,
      kind: file.kind === 'resource' ? 'resource' : 'text',
    })),
  };
}

function normalizeStoredChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    ...changeSet,
    schemaVersion: 3,
    files: Object.fromEntries(Object.entries(changeSet.files).map(
      ([remotePath, file]) => [remotePath, {
        ...file,
        kind: file.kind === 'resource' ? 'resource' : 'text',
      }],
    )),
    lifecycleChanges: changeSet.lifecycleChanges ?? {},
  };
}

function lifecycleChangeKey(change: Pick<LifecycleChange, 'kind' | 'path'>): string {
  return `${change.kind}:${change.path.toLocaleLowerCase('en-US')}`;
}

function foldLifecycleChange(
  existing: LifecycleChange | undefined,
  incoming: LifecycleChange,
): LifecycleChange | undefined {
  if (!existing || existing.kind !== incoming.kind) {
    return incoming;
  }
  if (existing.before === incoming.after) {
    return undefined;
  }
  return {
    ...incoming,
    before: existing.before,
  } as LifecycleChange;
}

function validateChangeSet(changeSet: ChangeSet): void {
  const deletedPaths = new Set(
    Object.values(changeSet.files)
      .filter(file => file.operation === 'delete')
      .map(file => file.path.toLocaleLowerCase('en-US')),
  );
  const invalid = Object.values(changeSet.lifecycleChanges ?? {}).find(change =>
    change.kind === 'filePreload'
    && deletedPaths.has(change.path.toLocaleLowerCase('en-US')));
  if (invalid) {
    throw new Error(`${invalid.path}: 将被删除的文件不能设置前置状态`);
  }
}

function isLifecycleChangeRecord(value: LifecycleChangeRecord): boolean {
  const change = value?.change;
  if (
    value?.schemaVersion !== 1
    || typeof value.id !== 'string'
    || typeof value.environmentId !== 'string'
    || typeof value.createdAt !== 'string'
    || !change
    || typeof change.path !== 'string'
    || typeof change.verifiedAt !== 'string'
  ) {
    return false;
  }
  if (change.kind === 'preloadOrder') {
    return typeof change.before === 'string' && typeof change.after === 'string';
  }
  return (change.kind === 'filePreload' || change.kind === 'folderRelease')
    && typeof change.before === 'boolean'
    && typeof change.after === 'boolean';
}

function isEntityId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
