export interface ApiResponse<T = unknown> {
  status: boolean;
  msg?: string;
  errcode?: string;
  code?: number | string;
  msgShowType?: string;
  data?: T;
}

export interface TreeNode {
  id: string;
  name: string;
  attribute: string;
  hasChild?: boolean;
  parentId?: string;
}

export interface TreePayload {
  system?: TreeNode;
  typeList: TreeNode[];
  childFolder: TreeNode[];
  childFile: TreeNode[];
}

export class EcodeApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'EcodeApiError';
  }
}
