export type FormContextKind = 'workflow' | 'mode' | 'shared';

export interface FormField {
  id: string;
  label: string;
  name?: string;
  htmlType?: string;
  detailType?: string;
  dbType?: string;
  isView?: boolean;
  isEdit?: boolean;
  isMandatory?: boolean;
}

export interface FormTable {
  mark: 'main' | `detail_${number}`;
  title?: string;
  tableName?: string;
  fields: FormField[];
}

export interface FormContext {
  kind: FormContextKind;
  workflowId?: string;
  requestId?: string;
  modeId?: string;
  formId?: string;
  tables: FormTable[];
}

export interface CachedFileFormMetadata {
  remoteId: string;
  path: string;
  updatedAt: string;
  contexts: FormContext[];
}

export interface FormMetadataCache {
  schemaVersion: 1;
  serverFingerprint: string;
  syncRoot: string;
  updatedAt: string;
  files: Record<string, CachedFileFormMetadata>;
}

export type FormMetadataState = 'present' | 'absent' | 'invalid';

export interface ExtractedFormMetadata {
  state: FormMetadataState;
  contexts: FormContext[];
  warnings: string[];
}
