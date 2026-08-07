import type {
  FormContext,
  FormMetadataState,
} from '../../domain/formMetadata';

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
  appId?: string;
  fileType?: string;
  preloadState?: string;
  preStateOrder?: string;
  isRootFolder?: boolean;
  released?: boolean;
}

export interface TreePayload {
  system?: TreeNode;
  typeList: TreeNode[];
  childFolder: TreeNode[];
  childFile: TreeNode[];
}

export interface FileDetail {
  content: string;
  formMetadataState: FormMetadataState;
  formContexts: FormContext[];
  formMetadataWarnings: string[];
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
