export type EcodeComponentCallKind = 'definition' | 'reference';

export interface TextOffsetRange {
  start: number;
  end: number;
}

export interface EcodeComponentCall {
  kind: EcodeComponentCallKind;
  method: 'setCom' | 'getCom';
  appId: string;
  name: string;
  appIdRange: TextOffsetRange;
  nameRange: TextOffsetRange;
}

export interface EcodeComponentNameCompletionContext {
  method: 'setCom' | 'getCom';
  appId: string;
  prefix: string;
  replaceLength: number;
  hasOpeningQuote: boolean;
  quote?: '\'' | '"' | '`';
}

interface StringLiteral {
  value: string;
  contentRange: TextOffsetRange;
  end: number;
}

export function parseEcodeComponentCalls(source: string): EcodeComponentCall[] {
  const calls: EcodeComponentCall[] = [];
  let offset = 0;
  while (offset < source.length) {
    const skipped = skipNonCodeToken(source, offset);
    if (skipped > offset) {
      offset = skipped;
      continue;
    }
    const candidate = parseSdkCallAt(source, offset);
    if (candidate) {
      calls.push(candidate.call);
      offset = candidate.end;
      continue;
    }
    offset += 1;
  }
  return calls;
}

export function findEcodeComponentCallAt(
  source: string,
  offset: number,
): EcodeComponentCall | undefined {
  if (offset < 0 || offset > source.length) {
    return undefined;
  }
  return parseEcodeComponentCalls(source)
    .find(call =>
      offset >= call.nameRange.start
      && offset <= call.nameRange.end);
}

export function parseEcodeComponentNameCompletionContext(
  textBeforeCursor: string,
): EcodeComponentNameCompletionContext | undefined {
  const suffix = textBeforeCursor.slice(-2000);
  const match =
    /(?:window\s*\.\s*)?ecodeSDK\s*\.\s*(setCom|getCom)\s*\(\s*(['"`])([^'"`\r\n]*)\2\s*,\s*(?:(['"`])([^'"`\r\n]*))?$/
      .exec(suffix);
  if (!match) {
    return undefined;
  }
  return {
    method: match[1] as 'setCom' | 'getCom',
    appId: decodeStringContent(match[3]),
    prefix: decodeStringContent(match[5] ?? ''),
    replaceLength: (match[5] ?? '').length,
    hasOpeningQuote: Boolean(match[4]),
    quote: match[4] as '\'' | '"' | '`' | undefined,
  };
}

function parseSdkCallAt(
  source: string,
  offset: number,
): { call: EcodeComponentCall; end: number } | undefined {
  if (offset > 0 && /[\w$]/.test(source[offset - 1])) {
    return undefined;
  }
  let cursor = offset;
  if (source.startsWith('window', cursor)) {
    cursor += 'window'.length;
    cursor = skipTrivia(source, cursor);
    if (source[cursor] !== '.') {
      return undefined;
    }
    cursor = skipTrivia(source, cursor + 1);
  }
  if (!source.startsWith('ecodeSDK', cursor)) {
    return undefined;
  }
  cursor += 'ecodeSDK'.length;
  if (/[\w$]/.test(source[cursor] ?? '')) {
    return undefined;
  }
  cursor = skipTrivia(source, cursor);
  if (source[cursor] !== '.') {
    return undefined;
  }
  cursor = skipTrivia(source, cursor + 1);
  const method = source.startsWith('setCom', cursor)
    ? 'setCom'
    : source.startsWith('getCom', cursor)
      ? 'getCom'
      : undefined;
  if (!method) {
    return undefined;
  }
  cursor += method.length;
  if (/[\w$]/.test(source[cursor] ?? '')) {
    return undefined;
  }
  cursor = skipTrivia(source, cursor);
  if (source[cursor] !== '(') {
    return undefined;
  }
  cursor = skipTrivia(source, cursor + 1);
  const appId = parseStringLiteral(source, cursor);
  if (!appId) {
    return undefined;
  }
  cursor = skipTrivia(source, appId.end);
  if (source[cursor] !== ',') {
    return undefined;
  }
  cursor = skipTrivia(source, cursor + 1);
  const name = parseStringLiteral(source, cursor);
  if (!name) {
    return undefined;
  }
  return {
    call: {
      kind: method === 'setCom' ? 'definition' : 'reference',
      method,
      appId: appId.value,
      name: name.value,
      appIdRange: appId.contentRange,
      nameRange: name.contentRange,
    },
    end: name.end,
  };
}

function parseStringLiteral(
  source: string,
  offset: number,
): StringLiteral | undefined {
  const quote = source[offset];
  if (quote !== '\'' && quote !== '"' && quote !== '`') {
    return undefined;
  }
  let cursor = offset + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (quote === '`' && source.startsWith('${', cursor)) {
      return undefined;
    }
    if (source[cursor] === quote) {
      const content = source.slice(offset + 1, cursor);
      return {
        value: decodeStringContent(content),
        contentRange: { start: offset + 1, end: cursor },
        end: cursor + 1,
      };
    }
    cursor += 1;
  }
  return undefined;
}

function skipTrivia(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2);
      cursor = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end < 0 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function skipNonCodeToken(source: string, offset: number): number {
  if (source.startsWith('//', offset)) {
    const end = source.indexOf('\n', offset + 2);
    return end < 0 ? source.length : end + 1;
  }
  if (source.startsWith('/*', offset)) {
    const end = source.indexOf('*/', offset + 2);
    return end < 0 ? source.length : end + 2;
  }
  const quote = source[offset];
  if (quote !== '\'' && quote !== '"' && quote !== '`') {
    return offset;
  }
  let cursor = offset + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

function decodeStringContent(value: string): string {
  return value.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,
    (_match, escape: string) => {
      if (escape.startsWith('u{')) {
        return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16));
      }
      if (escape.startsWith('u')) {
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      }
      if (escape.startsWith('x')) {
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      }
      const simpleEscapes: Record<string, string> = {
        '0': '\0',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
      };
      return simpleEscapes[escape] ?? escape;
    },
  );
}
