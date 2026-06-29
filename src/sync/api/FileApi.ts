import { EcodeApiClient } from './EcodeApiClient';
import type { ApiResponse } from './types';
import * as fs from 'fs';
import FormData = require('form-data');

/**
 * Ecode 文件操作 API
 */
export class FileApi {
  private endpoints = {
    tree: '/api/ecode/type/tree',
    viewFile: '/api/cloudstore/ecode/one',
    upload: '/api/ecode/upload',
  };

  constructor(private client: EcodeApiClient) {}

  /** 列出目录树 */
  async listTree(folderId = '', typeId = ''): Promise<ApiResponse<{
    system: unknown[];
    typeList: unknown[];
    childFolder: unknown[];
    childFile: unknown[];
  }>> {
    const params = new URLSearchParams();
    if (folderId) { params.append('folderId', folderId); }
    if (typeId) { params.append('typeId', typeId); }
    const query = params.toString();
    return this.client.get(`${this.endpoints.tree}${query ? '?' + query : ''}`);
  }

  /** 获取文件内容（仅源文件，resources/jars 不支持） */
  async viewFile(id: string): Promise<ApiResponse<string>> {
    const result = await this.client.get<Record<string, unknown>>(
      `${this.endpoints.viewFile}?id=${encodeURIComponent(id)}`,
    );

    if (!result.status) {
      return { status: false, msg: result.msg || '请求失败' };
    }

    const raw = (result.data || result) as Record<string, unknown>;

    // 结构: {data: {content: "..."}}
    if (raw.data && typeof raw.data === 'object') {
      const inner = raw.data as Record<string, unknown>;
      if (typeof inner.content === 'string') {
        return { status: true, data: inner.content };
      }
    }
    // 结构: {content: "..."}
    if (typeof raw.content === 'string') {
      return { status: true, data: raw.content };
    }
    // 结构: data 是纯文本
    if (typeof result.data === 'string') {
      return { status: true, data: result.data };
    }

    return { status: false, msg: '未获取到文件内容' };
  }

  /** 推送文件到服务器（FormData） */
  async push(localPath: string, remotePath: string): Promise<ApiResponse<unknown>> {
    const form = new FormData();
    form.append('path', remotePath);
    form.append('file', fs.createReadStream(localPath));
    return this.client.uploadForm(this.endpoints.upload, form);
  }
}
