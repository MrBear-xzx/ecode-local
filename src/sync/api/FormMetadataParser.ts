import type {
  ExtractedFormMetadata,
  FormContext,
  FormContextKind,
  FormField,
  FormTable,
} from '../../domain/formMetadata';

const IGNORED_KEYS = new Set(['content', 'compiledcontent']);
const MAX_DEPTH = 12;

interface Candidate {
  context: FormContext;
  signature: string;
}

export function extractFormMetadata(value: unknown): ExtractedFormMetadata {
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  const visited = new Set<object>();
  let malformedCandidate = false;

  const visit = (
    current: unknown,
    ancestors: Array<Record<string, unknown>>,
    path: string,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH || current === null || current === undefined) {
      return;
    }

    if (typeof current === 'string') {
      const parsed = parseJsonObject(current);
      if (parsed) {
        visit(parsed, ancestors, `${path}<json>`, depth + 1);
      } else if (
        /(?:metadata|tableinfo)/i.test(path)
        && looksLikeJson(current)
      ) {
        malformedCandidate = true;
        warnings.push(`${path}: 表单元数据不是有效 JSON`);
      }
      return;
    }
    if (typeof current !== 'object') {
      return;
    }
    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) =>
        visit(item, ancestors, `${path}[${index}]`, depth + 1));
      return;
    }

    const record = current as Record<string, unknown>;
    const parsedTables = parseTables(record);
    if (parsedTables.recognized) {
      if (parsedTables.tables.length === 0) {
        malformedCandidate = true;
        warnings.push(`${path}: 发现表单字段结构，但没有可用字段`);
      } else {
        const descriptors = [...ancestors, record];
        const context = buildContext(parsedTables.tables, descriptors);
        const signature = contextSignature(context);
        if (!candidates.some(candidate => candidate.signature === signature)) {
          candidates.push({ context, signature });
        }
      }
    }

    const nextAncestors = [...ancestors, record];
    for (const [key, child] of Object.entries(record)) {
      if (IGNORED_KEYS.has(key.toLowerCase())) {
        continue;
      }
      visit(child, nextAncestors, `${path}.${key}`, depth + 1);
    }
  };

  visit(value, [], '$', 0);

  if (candidates.length === 0) {
    return {
      state: malformedCandidate ? 'invalid' : 'absent',
      contexts: [],
      warnings,
    };
  }

  const contexts = candidates.map(candidate => candidate.context);
  const untyped = contexts.filter(context => context.kind === 'shared');
  if (untyped.length > 1) {
    const typedContexts = contexts.filter(context => context.kind !== 'shared');
    return {
      state: typedContexts.length > 0 ? 'present' : 'invalid',
      contexts: typedContexts,
      warnings: [
        ...warnings,
        '响应包含多个无法区分流程或建模类型的字段表，已忽略这些歧义元数据',
      ],
    };
  }

  return { state: 'present', contexts, warnings };
}

function parseTables(record: Record<string, unknown>): {
  recognized: boolean;
  tables: FormTable[];
} {
  const tableEntries = Object.entries(record)
    .filter(([key]) => key.toLowerCase() === 'main' || /^detail_\d+$/i.test(key));
  if (tableEntries.length === 0) {
    return { recognized: false, tables: [] };
  }

  const recognized = tableEntries.some(([, value]) =>
    hasKey(asRecord(value), 'fieldinfomap'));
  if (!recognized) {
    return { recognized: false, tables: [] };
  }

  const tables = tableEntries
    .map(([key, value]) => parseTable(key, value))
    .filter((table): table is FormTable => Boolean(table))
    .sort(compareTables);
  return { recognized: true, tables };
}

function parseTable(markValue: string, value: unknown): FormTable | undefined {
  const record = asRecord(value);
  const rawFields = asRecord(valueForKey(record, 'fieldinfomap'));
  const fields = Object.entries(rawFields)
    .map(([fallbackId, field]) => parseField(fallbackId, field))
    .filter((field): field is FormField => Boolean(field))
    .sort(compareFields);
  if (fields.length === 0) {
    return undefined;
  }

  const normalizedMark = markValue.toLowerCase();
  if (normalizedMark !== 'main' && !/^detail_\d+$/.test(normalizedMark)) {
    return undefined;
  }
  const detailAttributes = asRecord(valueForKey(record, 'detailtableattr'));
  return {
    mark: normalizedMark as FormTable['mark'],
    title: stringValue(valueForKey(detailAttributes, 'detailtitle')),
    tableName: stringValue(
      valueForKey(record, 'tablename')
      ?? valueForKey(detailAttributes, 'detailtable'),
    ),
    fields,
  };
}

function parseField(fallbackId: string, value: unknown): FormField | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const id = stringValue(valueForKey(record, 'fieldid')) ?? fallbackId;
  const label = stringValue(valueForKey(record, 'fieldlabel'));
  if (!id || !label) {
    return undefined;
  }
  return {
    id,
    label,
    name: stringValue(valueForKey(record, 'fieldname')),
    htmlType: stringValue(valueForKey(record, 'htmltype')),
    detailType: stringValue(valueForKey(record, 'detailtype')),
    dbType: stringValue(valueForKey(record, 'fielddbtype')),
    isView: booleanValue(valueForKey(record, 'isview')),
    isEdit: booleanValue(valueForKey(record, 'isedit')),
    isMandatory: booleanValue(valueForKey(record, 'ismand')),
  };
}

function buildContext(
  tables: FormTable[],
  descriptors: Array<Record<string, unknown>>,
): FormContext {
  const lookup = (key: string): string | undefined => {
    for (let index = descriptors.length - 1; index >= 0; index--) {
      const value = stringValue(valueForKey(descriptors[index], key));
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const workflowId = lookup('workflowid');
  const requestId = lookup('requestid');
  const modeId = lookup('modeid');
  const formId = lookup('formid');
  return {
    kind: inferKind(descriptors, workflowId, requestId, modeId),
    workflowId,
    requestId,
    modeId,
    formId,
    tables,
  };
}

function inferKind(
  descriptors: Array<Record<string, unknown>>,
  workflowId: string | undefined,
  requestId: string | undefined,
  modeId: string | undefined,
): FormContextKind {
  if (workflowId || requestId) {
    return 'workflow';
  }
  if (modeId) {
    return 'mode';
  }
  for (let index = descriptors.length - 1; index >= 0; index--) {
    const explicit = stringValue(
      valueForKey(descriptors[index], 'formtype')
      ?? valueForKey(descriptors[index], 'contexttype')
      ?? valueForKey(descriptors[index], 'type'),
    )?.toLowerCase();
    if (explicit && /workflow|wf|流程/.test(explicit)) {
      return 'workflow';
    }
    if (explicit && /mode|model|建模/.test(explicit)) {
      return 'mode';
    }
  }
  return 'shared';
}

function contextSignature(context: FormContext): string {
  return JSON.stringify({
    kind: context.kind,
    workflowId: context.workflowId,
    requestId: context.requestId,
    modeId: context.modeId,
    formId: context.formId,
    tables: context.tables,
  });
}

function parseJsonObject(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (
    trimmed.length < 2
    || trimmed.length > 5_000_000
    || !(
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function valueForKey(
  record: Record<string, unknown>,
  key: string,
): unknown {
  const found = Object.keys(record)
    .find(candidate => candidate.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : record[found];
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.keys(record).some(candidate => candidate.toLowerCase() === key.toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1' || value === 'true') {
    return true;
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return false;
  }
  return undefined;
}

function compareTables(left: FormTable, right: FormTable): number {
  if (left.mark === 'main') {
    return right.mark === 'main' ? 0 : -1;
  }
  if (right.mark === 'main') {
    return 1;
  }
  return Number(left.mark.slice('detail_'.length))
    - Number(right.mark.slice('detail_'.length));
}

function compareFields(left: FormField, right: FormField): number {
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.id.localeCompare(right.id);
}
