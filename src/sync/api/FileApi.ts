import { EcodeApiClient } from './EcodeApiClient';
import type { ApiResponse, TreeNode, TreePayload } from './types';

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
    const result = await this.client.get<unknown>(
      `/api/cloudstore/ecode/one?id=${encodeURIComponent(id)}`,
    );
    if (!result.status) {
      return result as ApiResponse<string>;
    }

    const content = extractContent(result.data !== undefined ? result.data : result);
    return content === undefined
      ? { status: false, msg: '未获取到文件内容' }
      : { status: true, data: content };
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
  return id && name
    ? {
        id,
        name,
        attribute: stringValue(record.attribute) ?? '',
        hasChild: booleanValue(record.hasChild),
        parentId: stringValue(record.parentId),
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
