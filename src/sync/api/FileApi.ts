import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, stat, unlink } from 'fs/promises';
import * as path from 'path';
import { once } from 'events';
import { Readable } from 'stream';
import { type EcodeApiClient } from './EcodeApiClient';
import { extractFormMetadata } from './FormMetadataParser';
import type { FormContext, FormField, FormTable } from '../../domain/formMetadata';
import type {
  ApiResponse,
  FileDetail,
  TreeNode,
  TreePayload,
} from './types';
import {
  formatResourceLimit,
  MAX_RESOURCE_BYTES,
} from '../../domain/text';

export interface ResourceDownloadResult {
  sourcePath: string;
  hash: string;
  size: number;
}

export class FileApi {
  constructor(private readonly client: EcodeApiClient) {}

  async listTree(folderId = '', typeId = ''): Promise<ApiResponse<TreePayload>> {
    const params = new URLSearchParams();
    if (folderId) {
      params.set('folderId', folderId);
    }
    if (typeId) {
      params.set('typeId', typeId);
    }
    const query = params.toString();
    const result = await this.client.get<unknown>(`/api/ecode/type/tree${query ? `?${query}` : ''}`);
    if (!result.status) {
      return result as ApiResponse<TreePayload>;
    }
    return { status: true, data: extractTreePayload(result) };
  }

  async viewFile(id: string): Promise<ApiResponse<string>> {
    const result = await this.viewFileDetail(id);
    return result.status
      ? { status: true, data: result.data?.content ?? '' }
      : {
          status: false,
          msg: result.msg,
          errcode: result.errcode,
          code: result.code,
          msgShowType: result.msgShowType,
        };
  }

  async viewFileDetail(id: string): Promise<ApiResponse<FileDetail>> {
    const result = await this.client.get<unknown>(
      `/api/cloudstore/ecode/one?id=${encodeURIComponent(id)}`,
    );
    if (!result.status) {
      return result as ApiResponse<FileDetail>;
    }

    const content = extractContent(result.data !== undefined ? result.data : result);
    if (content === undefined) {
      return { status: false, msg: '未获取到文件内容' };
    }
    const metadata = extractFormMetadata(result);
    return {
      status: true,
      data: {
        content,
        formMetadataState: metadata.state,
        formContexts: metadata.contexts,
        formMetadataWarnings: metadata.warnings,
      },
    };
  }

  async loadWorkflowFormContext(formId: string): Promise<ApiResponse<FormContext>> {
    const fieldList = await this.client.postForm<unknown>(
      '/api/workflow/formSetting/fieldSet/getFieldList',
      {
        formId,
        isBill: '1',
      },
    );
    if (!fieldList.status) {
      return fieldList as ApiResponse<FormContext>;
    }
    const sessionKey = findString(fieldList.data ?? fieldList, 'sessionkey');
    if (!sessionKey) {
      return {
        status: false,
        msg: `表单 ${formId} 字段接口未返回 sessionkey`,
      };
    }

    const tableData = await this.client.postForm<unknown>(
      '/api/ec/dev/table/datas',
      {
        dataKey: sessionKey,
        pageSize: '1000',
        min: '1',
        max: '1000',
      },
    );
    if (!tableData.status) {
      return tableData as ApiResponse<FormContext>;
    }
    const rows = findArray(tableData.data ?? tableData, 'datas');
    if (!rows) {
      return {
        status: false,
        msg: `表单 ${formId} 字段数据格式异常`,
      };
    }
    return {
      status: true,
      data: normalizeWorkflowFormContext(formId, rows),
    };
  }

  async updateFile(
    remoteId: string,
    content: string,
    compiledContent = content,
  ): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/updateFile', {
      id: remoteId,
      content: encodeContent(content),
      compiledContent: encodeContent(compiledContent),
    });
  }

  async addFile(
    folderId: string,
    name: string,
    extension: string,
  ): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/addFile', {
      name,
      folderId,
      content: '',
      compiledContent: '',
      type: extension,
    });
  }

  async addFolder(
    name: string,
    parent: { parentId: string } | { typeId: string },
  ): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/addFolder', {
      name,
      parentId: 'parentId' in parent ? parent.parentId : '',
      typeId: 'typeId' in parent ? parent.typeId : '',
      description: '',
    });
  }

  async deleteFile(remoteId: string): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/logicalDeleteFile', {
      id: remoteId,
    });
  }

  async deleteFolder(remoteId: string): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/logicalDeleteFolder', {
      folderId: remoteId,
    });
  }

  async downloadResource(
    route: string,
    targetPath: string,
  ): Promise<ApiResponse<ResourceDownloadResult>> {
    let response: Response;
    try {
      response = await this.client.getRaw(route);
    } catch (error: unknown) {
      return {
        status: false,
        msg: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401 || response.status === 302) {
      return { status: false, msg: 'Session expired', code: 401 };
    }
    if (!response.ok || !response.body) {
      return {
        status: false,
        msg: `资源下载失败: HTTP ${response.status}`,
        code: response.status,
      };
    }

    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_RESOURCE_BYTES) {
      return {
        status: false,
        msg: `资源文件超过 ${formatResourceLimit()} 上限`,
      };
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const output = createWriteStream(targetPath, { flags: 'wx' });
    const hash = createHash('sha256');
    let size = 0;
    try {
      await once(output, 'open');
      const readable = Readable.fromWeb(
        response.body as unknown as globalThis.ReadableStream<Uint8Array>,
      );
      for await (const chunk of readable) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_RESOURCE_BYTES) {
          throw new Error(`资源文件超过 ${formatResourceLimit()} 上限`);
        }
        hash.update(buffer);
        if (!output.write(buffer)) {
          await once(output, 'drain');
        }
      }
      output.end();
      await once(output, 'close');
      return {
        status: true,
        data: { sourcePath: targetPath, hash: hash.digest('hex'), size },
      };
    } catch (error: unknown) {
      output.destroy();
      try {
        await unlink(targetPath);
      } catch {
        // 下载失败时目标文件可能尚未创建。
      }
      return {
        status: false,
        msg: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async uploadResource(
    filePath: string,
    folderId: string,
    fileName?: string,
  ): Promise<ApiResponse<unknown>> {
    const file = await stat(filePath);
    if (file.size > MAX_RESOURCE_BYTES) {
      return { status: false, msg: `资源文件超过 ${formatResourceLimit()} 上限` };
    }
    return this.client.postMultipartFile(
      `/api/ecode/resource/upload?folderId=${encodeURIComponent(folderId)}`,
      'file',
      filePath,
      fileName,
    );
  }

  async deleteResource(resourceId: string): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/ecode/resource/remove', { resourceId });
  }
}

function encodeContent(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function extractTreePayload(result: ApiResponse<unknown>): TreePayload {
  const wrapped = asRecord(result.data);
  const root = Object.keys(wrapped).length > 0
    ? wrapped
    : result as unknown as Record<string, unknown>;
  const nested = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : undefined;
  const data = nested ?? root;
  return {
    system: asTreeNode(data.system),
    typeList: asTreeNodes(data.typeList),
    childFolder: asTreeNodes(data.childFolder),
    childFile: asTreeNodes(data.childFile),
    resources: asTreeNodes(data.resources),
  };
}

function extractContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const outer = asRecord(value);
  if (typeof outer.content === 'string') {
    return outer.content;
  }
  const inner = asRecord(outer.data);
  return typeof inner.content === 'string' ? inner.content : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asTreeNode(value: unknown): TreeNode | undefined {
  const record = asRecord(value);
  const id = stringValue(record.id);
  const name = stringValue(record.name);
  const releaseStatus = firstRecordString(
    record,
    'releaseStatus',
    'releasedStatus',
    'status',
  );
  return id && name
    ? {
        id,
        name,
        attribute: stringValue(record.attribute) ?? '',
        hasChild: booleanValue(record.hasChild),
        parentId: stringValue(record.parentId),
        appId: firstRecordString(record, 'appId', 'appid'),
        fileType: firstRecordString(
          record,
          'fileExtension',
          'fileType',
          'suffix',
          'type',
        ),
        preloadState: firstRecordString(
          record,
          'state',
          'preloadState',
          'preloadType',
          'preState',
          'markType',
          'markFileType',
          'loadState',
          'loadType',
        ),
        preStateOrder: firstRecordString(record, 'preStateOrder'),
        isRootFolder: optionalBooleanValue(
          firstRecordValue(record, 'isRootFolder', 'rootFolder'),
        ),
        released: optionalBooleanValue(
          firstRecordValue(record, 'released', 'isReleased', 'isRelease'),
        ) ?? (releaseStatus?.toLowerCase() === 'released' ? true : undefined),
        treeType: firstRecordString(record, 'treeType'),
        businessType: firstRecordString(record, 'businessType'),
        initialAppId: firstRecordString(record, 'initialAppId'),
        route: firstRecordString(record, 'route'),
        status: releaseStatus,
        state: firstRecordString(record, 'state'),
        debugMode: firstRecordString(record, 'debugMode') === 'y' ? 'y' : 'n',
      }
    : undefined;
}

function asTreeNodes(value: unknown): TreeNode[] {
  return Array.isArray(value)
    ? value.map(asTreeNode).filter((item): item is TreeNode => Boolean(item))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function optionalBooleanValue(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return false;
  }
  return booleanValue(value) ? true : undefined;
}

function firstRecordString(
  record: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  return stringValue(firstRecordValue(record, ...names));
}

function firstRecordValue(
  record: Record<string, unknown>,
  ...names: string[]
): unknown {
  const normalized = new Map(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const name of names) {
    const value = normalized.get(name.toLowerCase());
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function normalizeWorkflowFormContext(
  formId: string,
  rows: unknown[],
): FormContext {
  const tables = new Map<FormTable['mark'], FormTable>();
  const detailMarks = new Map<string, `detail_${number}`>();
  let nextDetailIndex = 1;

  for (const value of rows) {
    const row = asCaseInsensitiveRecord(value);
    const id = firstString(row, 'fieldid', 'id');
    if (!id) {
      continue;
    }
    const positionName = visibleText(
      firstString(row, 'viewtypespan', 'positionname'),
    );
    const groupName = visibleText(
      firstString(row, 'groupnamespan', 'groupname', 'grouplabel', 'detailname'),
    );
    const viewType = firstString(row, 'viewtype', 'isdetail');
    const groupId = firstString(
      row,
      'detailtable',
      'randomfield3',
      'groupid',
      'detailid',
      'detailindex',
    );
    const main = viewType === '0'
      || positionName?.includes('主表') === true
      || positionName?.toLowerCase() === 'main';
    let mark: FormTable['mark'] = 'main';
    if (!main && (viewType === '1' || groupId || positionName)) {
      const explicit = detailIndex(positionName) ?? detailIndex(groupId);
      const groupKey = groupId ?? positionName ?? viewType ?? 'detail';
      let detailMark = detailMarks.get(groupKey);
      if (!detailMark) {
        const index = explicit ?? nextDetailIndex++;
        detailMark = `detail_${index}`;
        detailMarks.set(groupKey, detailMark);
        nextDetailIndex = Math.max(nextDetailIndex, index + 1);
      }
      mark = detailMark;
    }

    const fieldName = firstString(row, 'fieldname', 'randomfield0', 'dbname', 'dbfieldname');
    const rawLabel = visibleText(
      firstString(row, 'fieldlabelspan', 'fieldlabelname', 'fieldlabeltext'),
    );
    const labelId = firstString(row, 'fieldlabel', 'label');
    const field: FormField = {
      id,
      label: rawLabel
        ?? (labelId && !/^-?\d+$/.test(labelId) ? labelId : undefined)
        ?? fieldName
        ?? id,
      name: fieldName,
      htmlType: firstString(row, 'fieldhtmltype', 'htmltype'),
      detailType: firstString(row, 'detailtype', 'fieldtype', 'type'),
      dbType: firstString(row, 'fielddbtype', 'dbtype'),
      isView: optionalBoolean(row, 'isview'),
      isEdit: optionalBoolean(row, 'isedit'),
      isMandatory: optionalBoolean(row, 'ismand', 'ismandatory'),
    };
    const table = tables.get(mark) ?? {
      mark,
      title: positionName ?? groupName,
      fields: [],
    };
    table.fields.push(field);
    tables.set(mark, table);
  }

  return {
    kind: 'workflow',
    formId,
    tables: [...tables.values()].sort((left, right) =>
      tableIndex(left.mark) - tableIndex(right.mark)),
  };
}

function asCaseInsensitiveRecord(value: unknown): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    normalized[key.toLowerCase()] = item;
  }
  return normalized;
}

function firstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key.toLowerCase()]);
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function optionalBoolean(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = record[key.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') {
      return booleanValue(value);
    }
  }
  return undefined;
}

function findString(value: unknown, key: string): string | undefined {
  const record = asCaseInsensitiveRecord(value);
  const direct = stringValue(record[key.toLowerCase()]);
  if (direct !== undefined) {
    return direct;
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      const found = findString(nested, key);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function findArray(value: unknown, key: string): unknown[] | undefined {
  const record = asCaseInsensitiveRecord(value);
  const direct = record[key.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct;
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      const found = findArray(nested, key);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function detailIndex(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /(?:detail[_\s-]*|明细(?:表)?\s*)(\d+)/i.exec(value)
    ?? (/^\d+$/.test(value) ? [value, value] : undefined);
  const index = match ? Number(match[1]) : NaN;
  return Number.isInteger(index) && index > 0 ? index : undefined;
}

function visibleText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .trim();
  return text || undefined;
}

function tableIndex(mark: FormTable['mark']): number {
  return mark === 'main' ? 0 : Number(mark.slice('detail_'.length));
}
