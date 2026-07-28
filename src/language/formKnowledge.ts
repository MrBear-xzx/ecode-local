import {
  parseCallContext,
  type EcodeApiObject,
} from './knowledge';

export type FormReferenceRole =
  | 'fieldMark'
  | 'fieldMarks'
  | 'fieldId'
  | 'fieldName'
  | 'detailMark'
  | 'detailOrFieldMark'
  | 'fieldObjectKey';

export interface FormReferenceContext {
  object: Extract<EcodeApiObject, 'WfForm' | 'ModeForm'>;
  role: FormReferenceRole;
  prefix: string;
  replaceStart: number;
  replaceEnd: number;
  tableScope?: 'main' | `detail_${number}`;
}

const FIELD_OBJECT_PARAMETERS = new Set([
  'changeDatas',
  'changeVariable',
  'initialValues',
]);

export function parseFormReferenceContext(
  text: string,
  offset: number,
): FormReferenceContext | undefined {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }
  const windowStart = Math.max(0, offset - 4000);
  const beforeCursor = text.slice(windowStart, offset);
  const call = parseCallContext(beforeCursor);
  if (
    !call
    || (call.entry.object !== 'WfForm' && call.entry.object !== 'ModeForm')
  ) {
    return undefined;
  }
  const parameter = call.entry.parameters[call.activeParameter];
  if (!parameter) {
    return undefined;
  }

  const object = call.entry.object;
  const directRole = directRoleFor(object, parameter.name);
  if (directRole) {
    const literal = stringLiteralPrefix(call.activeArgumentText, directRole);
    if (!literal) {
      return undefined;
    }
    const tableScope = directRole === 'fieldName'
      ? explicitFieldNameTableScope(text, offset)
      : undefined;
    if (directRole === 'fieldName' && !tableScope) {
      return undefined;
    }
    return {
      object,
      role: directRole,
      prefix: literal.prefix,
      replaceStart: offset - literal.prefix.length,
      replaceEnd: offset,
      tableScope,
    };
  }

  if (FIELD_OBJECT_PARAMETERS.has(parameter.name)) {
    const key = objectKeyPrefix(call.activeArgumentText);
    if (!key) {
      return undefined;
    }
    return {
      object,
      role: 'fieldObjectKey',
      prefix: key.prefix,
      replaceStart: offset - key.prefix.length,
      replaceEnd: offset,
      tableScope: detailScope(beforeCursor, call.entry.name),
    };
  }
  return undefined;
}

function explicitFieldNameTableScope(
  text: string,
  offset: number,
): 'main' | `detail_${number}` | undefined {
  const suffix = text.slice(offset, Math.min(text.length, offset + 512));
  const boundary = /^[^,)]*([,)])/.exec(suffix);
  if (!boundary || boundary[1] === ')') {
    return 'main';
  }
  const match = /^[^,)]*,\s*(['"])(main|detail_\d+)\1/i.exec(suffix);
  return match?.[2].toLowerCase() as 'main' | `detail_${number}` | undefined;
}

export function findFormReferenceAt(
  text: string,
  offset: number,
): FormReferenceContext | undefined {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }
  const range = identifierRangeAt(text, offset);
  if (!range) {
    return undefined;
  }
  const context = parseFormReferenceContext(text, range.end);
  if (!context || context.replaceStart > range.start) {
    return undefined;
  }
  return {
    ...context,
    prefix: text.slice(range.start, range.end),
    replaceStart: range.start,
    replaceEnd: range.end,
  };
}

export function findFormVariableReferenceAt(
  text: string,
  offset: number,
): FormReferenceContext | undefined {
  const range = identifierRangeAt(text, offset);
  if (
    !range
    || !isCodeOffset(text, range.start)
    || text[range.start - 1] === '.'
  ) {
    return undefined;
  }
  const name = text.slice(range.start, range.end);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return undefined;
  }
  const suffix = text.slice(range.end);
  if (/^\s*:/.test(suffix)) {
    return undefined;
  }

  const declarations: FormReferenceContext[] = [];
  const declarationPattern =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\s*\.\s*)?(WfForm|ModeForm)\s*\.\s*convertFieldNameToId\s*\(\s*(['"])([\w-]+)\3/gi;
  for (const match of text.matchAll(declarationPattern)) {
    if (
      match[1] !== name
      || match.index === undefined
      || !isCodeOffset(text, match.index)
    ) {
      continue;
    }
    const tableScope = fieldNameTableScopeAfterLiteral(
      text,
      match.index + match[0].length,
    );
    if (!tableScope) {
      continue;
    }
    declarations.push({
      object: match[2] as Extract<EcodeApiObject, 'WfForm' | 'ModeForm'>,
      role: 'fieldName',
      prefix: match[4],
      replaceStart: range.start,
      replaceEnd: range.end,
      tableScope,
    });
  }
  return declarations.length === 1 ? declarations[0] : undefined;
}

function fieldNameTableScopeAfterLiteral(
  text: string,
  offset: number,
): 'main' | `detail_${number}` | undefined {
  const suffix = text.slice(offset, Math.min(text.length, offset + 512));
  if (/^\s*\)/.test(suffix) || !/^\s*,/.test(suffix)) {
    return 'main';
  }
  const match = /^\s*,\s*(['"])(main|detail_\d+)\1/i.exec(suffix);
  return match?.[2].toLowerCase() as 'main' | `detail_${number}` | undefined;
}

function directRoleFor(
  object: Extract<EcodeApiObject, 'WfForm' | 'ModeForm'>,
  parameterName: string,
): FormReferenceRole | undefined {
  switch (parameterName) {
    case 'fieldMark':
      return 'fieldMark';
    case 'fieldMarks':
      return 'fieldMarks';
    case 'fieldName':
      return 'fieldName';
    case 'detailMark':
      return 'detailMark';
    case 'detailOrFieldMark':
      return 'detailOrFieldMark';
    case 'fieldId':
      return object === 'WfForm' ? 'fieldId' : 'fieldMark';
    default:
      return undefined;
  }
}

function stringLiteralPrefix(
  activeArgumentText: string,
  role: FormReferenceRole,
): { prefix: string } | undefined {
  const match = /(['"])([^'"]*)$/.exec(activeArgumentText);
  if (!match) {
    return undefined;
  }
  let prefix = match[2];
  if (role === 'fieldMarks') {
    prefix = prefix.slice(prefix.lastIndexOf(',') + 1).trimStart();
  }
  if (!/^[\w-]*$/.test(prefix)) {
    return undefined;
  }
  return { prefix };
}

function objectKeyPrefix(
  activeArgumentText: string,
): { prefix: string } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let segmentStart = -1;
  for (let index = 0; index < activeArgumentText.length; index++) {
    const character = activeArgumentText[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth++;
      if (depth === 1) {
        segmentStart = index + 1;
      }
    } else if (character === '}') {
      depth--;
      if (depth < 1) {
        segmentStart = -1;
      }
    } else if (character === ',' && depth === 1) {
      segmentStart = index + 1;
    } else if (character === ':' && depth === 1) {
      segmentStart = -1;
    }
  }
  if (depth !== 1 || segmentStart < 0) {
    return undefined;
  }
  const segment = activeArgumentText.slice(segmentStart);
  const match = /^\s*(['"]?)([\w-]*)$/.exec(segment);
  return match ? { prefix: match[2] } : undefined;
}

function detailScope(
  beforeCursor: string,
  methodName: string,
): `detail_${number}` | undefined {
  if (methodName !== 'addDetailRow') {
    return undefined;
  }
  const match = /(?:window\.)?(?:WfForm|ModeForm)\.addDetailRow\s*\(\s*['"](detail_\d+)['"]/i
    .exec(beforeCursor);
  return match?.[1].toLowerCase() as `detail_${number}` | undefined;
}

function identifierRangeAt(
  text: string,
  offset: number,
): { start: number; end: number } | undefined {
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w-]/.test(text[start - 1])) {
    start--;
  }
  while (end < text.length && /[\w-]/.test(text[end])) {
    end++;
  }
  return start < end ? { start, end } : undefined;
}

function isCodeOffset(text: string, offset: number): boolean {
  let state: 'code' | 'lineComment' | 'blockComment' | 'string' = 'code';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < offset; index++) {
    const current = text[index];
    const next = text[index + 1];
    if (state === 'lineComment') {
      if (current === '\n') {
        state = 'code';
      }
    } else if (state === 'blockComment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index++;
      }
    } else if (state === 'string') {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        state = 'code';
      }
    } else if (current === '/' && next === '/') {
      state = 'lineComment';
      index++;
    } else if (current === '/' && next === '*') {
      state = 'blockComment';
      index++;
    } else if (current === '\'' || current === '"' || current === '`') {
      state = 'string';
      quote = current;
    }
  }
  return state === 'code';
}
