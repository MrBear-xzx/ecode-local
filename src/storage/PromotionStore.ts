import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ECODE_LOCAL_DIRECTORY,
  ECODE_PROMOTION_DIRECTORY,
} from '../domain/constants';
import { hashText } from '../domain/text';
import type {
  ChangeSet,
  ChangeSetFile,
  DeploymentRecord,
  PromotionCandidate,
  PushRecord,
  ReleaseArtifact,
} from '../domain/types';
import { writeJsonAtomic, writeTextAtomic } from './AtomicFileStore';

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
      schemaVersion: 1,
      id: `CS-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`,
      name: name.trim(),
      sourceEnvironmentId,
      createdAt: now,
      updatedAt: now,
      files: {},
    };
    await this.writeEntity('change-sets', changeSet.id, changeSet);
    return changeSet;
  }

  async getChangeSet(id: string): Promise<ChangeSet | undefined> {
    return this.readEntity<ChangeSet>('change-sets', id);
  }

  async listChangeSets(): Promise<ChangeSet[]> {
    return this.listEntities<ChangeSet>('change-sets');
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
        : (candidate.baseContent === undefined
          ? undefined
          : await this.saveObject(candidate.baseContent));
      const resultSnapshotKey = candidate.resultContent === undefined
        ? undefined
        : await this.saveObject(candidate.resultContent);

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
        baseHash,
        baseSnapshotKey,
        resultHash: candidate.resultHash,
        resultSnapshotKey,
        verifiedAt: new Date().toISOString(),
      };
      changeSet.files[candidate.path] = file;
    }
    changeSet.updatedAt = new Date().toISOString();
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
        baseSnapshotKey: candidate.baseContent === undefined
          ? undefined
          : await this.saveObject(candidate.baseContent),
        resultHash: candidate.resultHash,
        resultSnapshotKey: candidate.resultContent === undefined
          ? undefined
          : await this.saveObject(candidate.resultContent),
        verifiedAt: now,
      });
    }
    const successfulPaths = new Set(files.map(file => file.path));
    const record: PushRecord = {
      schemaVersion: 1,
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
      const baseContent = file.baseSnapshotKey
        ? await this.readObject(file.baseSnapshotKey)
        : undefined;
      const resultContent = file.resultSnapshotKey
        ? await this.readObject(file.resultSnapshotKey)
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
        baseHash: file.baseHash,
        baseContent,
        resultHash: file.resultHash,
        resultContent,
      };
    }));
  }

  async materializeChangeSet(changeSet: ChangeSet): Promise<ReleaseArtifact[]> {
    return this.materializeFiles(Object.values(changeSet.files));
  }

  private async materializeFiles(files: ChangeSetFile[]): Promise<ReleaseArtifact[]> {
    return Promise.all(files.map(async file => {
      const resultContent = file.resultSnapshotKey
        ? await this.readObject(file.resultSnapshotKey)
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
        baseHash: file.baseHash,
        resultHash: file.resultHash,
        resultContent,
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
    name: typeof storedName === 'string' && storedName.trim()
      ? storedName.trim()
      : new Date(record.createdAt).toLocaleString(),
  };
}

function isEntityId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
