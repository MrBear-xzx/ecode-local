/** Ecode 鉴权相关类型 */

/** 注册接口响应 */
export interface RegistResponse {
  spk: string;      // RSA 公钥（服务器下发）
  secrit: string;   // 密钥（注意：Ecode 拼写为 secrit 而非 secret）
}

/** 申请 Token 响应 */
export interface ApplyTokenResponse {
  token: string;    // 访问 Token（有效期约 30 分钟）
}

/** API 通用响应（适配 Ecode 实际格式） */
export interface ApiResponse<T = unknown> {
  status: boolean;     // Ecode 使用 status 而非 success
  msg?: string;         // Ecode 使用 msg 而非 message
  errcode?: string;
  code?: number;
  msgShowType?: string;
  data?: T;            // 部分接口将数据放在顶层，此处兜底
}

/** 文件信息 */
export interface FileInfo {
  path: string;       // 相对路径
  name: string;
  type: 'js' | 'css' | 'md';
  size: number;
  modifiedAt: string;
  hash?: string;
}

/** 文件内容 */
export interface FileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
}

/** 同步结果 */
export interface SyncResult {
  success: boolean;
  pulled: number;
  pushed: number;
  failed: number;
  conflicts: string[];
  errors: string[];
}

/** 文件差异 */
export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'conflict';
  localHash?: string;
  remoteHash?: string;
}

/** Ecode 项目配置 */
export interface EcodeConfig {
  server: {
    url: string;
    appId: string;
    strategy: 'api' | 'zip';
  };
  mappings?: {
    [localDir: string]: {
      type: 'js' | 'css' | 'md';
      remotePath: string;
    };
  };
  api?: {
    endpoints?: {
      regist?: string;
      applyToken?: string;
      listFiles?: string;
      getFile?: string;
      uploadFile?: string;
      deleteFile?: string;
      scanUpgrade?: string;
    };
  };
}
