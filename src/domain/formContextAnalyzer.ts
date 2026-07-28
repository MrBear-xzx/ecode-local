import * as path from 'path';

export interface FormSourceFile {
  path: string;
  content: string;
}

export interface StaticFormBinding {
  kind: 'workflow' | 'mode';
  id: string;
  entryPath: string;
}

export interface FormContextAnalysis {
  bindingsByPath: Map<string, StaticFormBinding[]>;
  unresolvedPaths: Set<string>;
  warnings: string[];
}

interface GuardReference {
  kind: StaticFormBinding['kind'];
  expression: string;
}

interface StaticNumericValues {
  global: Map<string, Set<string>>;
  localByPath: Map<string, Map<string, Set<string>>>;
}

const SOURCE_EXTENSION = /\.(?:js|jsx|ts|tsx)$/i;

export function analyzeFormContexts(
  files: Iterable<FormSourceFile>,
): FormContextAnalysis {
  const sourceFiles = [...files]
    .filter(file => SOURCE_EXTENSION.test(file.path))
    .map(file => ({
      ...file,
      path: normalizePath(file.path),
      code: maskNonCode(file.content),
    }));
  const values = collectStaticNumericValues(sourceFiles);
  const directoryBindings = new Map<string, StaticFormBinding[]>();
  const unresolvedDirectories = new Set<string>();
  const warnings: string[] = [];

  for (const file of sourceFiles) {
    const references = collectGuardReferences(file.code);
    if (references.length === 0) {
      continue;
    }

    const resolved: StaticFormBinding[] = [];
    for (const reference of references) {
      const ids = resolveNumericExpression(
        reference.expression,
        values,
        values.localByPath.get(file.path),
      );
      if (ids.size === 1) {
        resolved.push({
          kind: reference.kind,
          id: [...ids][0],
          entryPath: file.path,
        });
      } else {
        const reason = ids.size === 0 ? '无法静态解析' : '存在多个候选值';
        unresolvedDirectories.add(businessDirectory(file.path));
        warnings.push(
          `${file.path}: ${reason} ${reference.kind} 表单守卫 ${reference.expression}`,
        );
      }
    }

    if (resolved.length === 0) {
      continue;
    }
    const root = businessDirectory(file.path);
    const existing = directoryBindings.get(root) ?? [];
    directoryBindings.set(root, mergeBindings(existing, resolved));
  }

  const bindingsByPath = new Map<string, StaticFormBinding[]>();
  const unresolvedPaths = new Set<string>();
  for (const file of sourceFiles) {
    if ([...unresolvedDirectories].some(directory =>
      isInsideDirectory(file.path, directory))) {
      unresolvedPaths.add(file.path);
    }
    const candidates = [...directoryBindings.entries()]
      .filter(([directory]) => isInsideDirectory(file.path, directory))
      .sort(([left], [right]) => right.length - left.length);
    if (candidates.length === 0) {
      continue;
    }
    const nearestLength = candidates[0][0].length;
    const bindings = mergeBindings(
      [],
      candidates
        .filter(([directory]) => directory.length === nearestLength)
        .flatMap(([, items]) => items),
    );
    if (bindings.length > 0) {
      bindingsByPath.set(file.path, bindings);
    }
  }

  return { bindingsByPath, unresolvedPaths, warnings };
}

function collectStaticNumericValues(
  files: Array<FormSourceFile & { code: string }>,
): StaticNumericValues {
  const global = new Map<string, Set<string>>();
  const localByPath = new Map<string, Map<string, Set<string>>>();
  const aliases: Array<{ path: string; name: string; expression: string }> = [];
  for (const file of files) {
    const local = new Map<string, Set<string>>();
    localByPath.set(file.path, local);
    const declarations = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
    let declaration: RegExpExecArray | null;
    while ((declaration = declarations.exec(file.code))) {
      const name = declaration[1];
      const start = skipWhitespace(file.code, declarations.lastIndex);
      if (file.code[start] === '{') {
        const end = findBalancedEnd(file.code, start, '{', '}');
        if (end < 0) {
          continue;
        }
        const objectValues = new Map<string, Set<string>>();
        collectObjectValues(file.code.slice(start + 1, end), name, objectValues);
        mergeNumericValues(global, objectValues);
        mergeNumericValues(local, objectValues);
        declarations.lastIndex = end + 1;
        continue;
      }

      const expression = readExpression(file.code, start);
      const literal = numericLiteral(expression);
      if (literal !== undefined) {
        addValue(global, name, literal);
        addValue(local, name, literal);
      } else if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(expression)) {
        aliases.push({ path: file.path, name, expression });
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      const local = localByPath.get(alias.path);
      const resolved = lookupValues(alias.expression, local, global);
      for (const value of resolved) {
        const before = global.get(alias.name)?.size ?? 0;
        addValue(global, alias.name, value);
        if (local) {
          addValue(local, alias.name, value);
        }
        changed = changed || (global.get(alias.name)?.size ?? 0) > before;
      }
    }
  }
  return { global, localByPath };
}

function collectObjectValues(
  body: string,
  owner: string,
  values: Map<string, Set<string>>,
): void {
  const propertyPattern = /(?:^|[,;])\s*([A-Za-z_$][\w$]*)\s*:\s*/g;
  let property: RegExpExecArray | null;
  while ((property = propertyPattern.exec(body))) {
    const propertyName = property[1];
    const start = skipWhitespace(body, propertyPattern.lastIndex);
    if (body[start] === '{') {
      const end = findBalancedEnd(body, start, '{', '}');
      if (end >= 0) {
        collectObjectValues(
          body.slice(start + 1, end),
          `${owner}.${propertyName}`,
          values,
        );
        propertyPattern.lastIndex = end + 1;
      }
      continue;
    }
    const expression = readExpression(body, start);
    const literal = numericLiteral(expression);
    if (literal !== undefined) {
      addValue(values, `${owner}.${propertyName}`, literal);
    }
  }
}

function collectGuardReferences(code: string): GuardReference[] {
  const references: GuardReference[] = [];
  const guardPattern = /\bif\s*\(([\s\S]*?)\)\s*(?:\{\s*)?return\b/g;
  let guard: RegExpExecArray | null;
  while ((guard = guardPattern.exec(code))) {
    const condition = guard[1];
    collectPreferredVariableComparisons(
      condition,
      'formid',
      'formId',
      'workflow',
      references,
    );
    collectPreferredVariableComparisons(
      condition,
      'modeId',
      'modeid',
      'mode',
      references,
    );
  }
  return dedupeReferences(references);
}

function collectPreferredVariableComparisons(
  condition: string,
  preferred: string,
  fallback: string,
  kind: GuardReference['kind'],
  target: GuardReference[],
): void {
  const variable = new RegExp(`\\b${escapeRegExp(preferred)}\\b`).test(condition)
    ? preferred
    : fallback;
  collectVariableComparisons(condition, variable, kind, target);
}

function collectVariableComparisons(
  condition: string,
  variable: string,
  kind: GuardReference['kind'],
  target: GuardReference[],
): void {
  const escaped = escapeRegExp(variable);
  const right = new RegExp(
    `\\b${escaped}\\b\\s*(?:!==|!=|===|==)\\s*([+-]?\\d+|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`,
    'g',
  );
  const left = new RegExp(
    `([+-]?\\d+|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*(?:!==|!=|===|==)\\s*\\b${escaped}\\b`,
    'g',
  );
  for (const pattern of [right, left]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(condition))) {
      if (
        match[1] !== variable
        && !['null', 'undefined', 'true', 'false'].includes(match[1])
      ) {
        target.push({ kind, expression: match[1] });
      }
    }
  }
}

function resolveNumericExpression(
  expression: string,
  values: StaticNumericValues,
  local: Map<string, Set<string>> | undefined,
): Set<string> {
  const literal = numericLiteral(expression);
  return literal !== undefined
    ? new Set([literal])
    : lookupValues(expression, local, values.global);
}

function lookupValues(
  expression: string,
  local: Map<string, Set<string>> | undefined,
  global: Map<string, Set<string>>,
): Set<string> {
  const localResult = lookupMapValues(expression, local);
  if (localResult.size > 0) {
    return localResult;
  }
  if (!expression.includes('.')) {
    return new Set();
  }
  return lookupMapValues(expression, global);
}

function lookupMapValues(
  expression: string,
  values: Map<string, Set<string>> | undefined,
): Set<string> {
  const result = new Set<string>();
  if (!values) {
    return result;
  }
  const segments = expression.split('.');
  const lastStart = segments.length > 1 ? segments.length - 2 : 0;
  for (let index = 0; index <= lastStart; index++) {
    const suffix = segments.slice(index).join('.');
    for (const value of values.get(suffix) ?? []) {
      result.add(value);
    }
  }
  return result;
}

function mergeNumericValues(
  target: Map<string, Set<string>>,
  source: Map<string, Set<string>>,
): void {
  for (const [key, values] of source) {
    for (const value of values) {
      addValue(target, key, value);
    }
  }
}

function businessDirectory(filePath: string): string {
  return path.posix.dirname(filePath);
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  return filePath === directory || filePath.startsWith(`${directory}/`);
}

function mergeBindings(
  left: StaticFormBinding[],
  right: StaticFormBinding[],
): StaticFormBinding[] {
  const merged = new Map<string, StaticFormBinding>();
  for (const binding of [...left, ...right]) {
    merged.set(`${binding.kind}:${binding.id}`, binding);
  }
  return [...merged.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function dedupeReferences(references: GuardReference[]): GuardReference[] {
  const unique = new Map<string, GuardReference>();
  for (const reference of references) {
    unique.set(`${reference.kind}:${reference.expression}`, reference);
  }
  return [...unique.values()];
}

function addValue(
  values: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const existing = values.get(key) ?? new Set<string>();
  existing.add(value);
  values.set(key, existing);
}

function numericLiteral(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[+-]?\d+$/.test(trimmed) ? String(Number(trimmed)) : undefined;
}

function readExpression(source: string, start: number): string {
  let end = start;
  while (end < source.length && !/[,;\r\n}]/.test(source[end])) {
    end++;
  }
  return source.slice(start, end).trim();
}

function findBalancedEnd(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === open) {
      depth++;
    } else if (source[index] === close && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function skipWhitespace(source: string, offset: number): number {
  while (offset < source.length && /\s/.test(source[offset])) {
    offset++;
  }
  return offset;
}

function maskNonCode(source: string): string {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const boundary = end < 0 ? source.length : end;
      result += source.slice(index, boundary).replace(/[^\r\n]/g, ' ');
      index = boundary;
    } else if (current === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const boundary = end < 0 ? source.length : end + 2;
      result += source.slice(index, boundary).replace(/[^\r\n]/g, ' ');
      index = boundary;
    } else if (current === '"' || current === '\'' || current === '`') {
      const quote = current;
      result += ' ';
      index++;
      while (index < source.length) {
        if (source[index] === '\\') {
          result += '  ';
          index += 2;
        } else if (source[index] === quote) {
          result += ' ';
          index++;
          break;
        } else {
          result += source[index] === '\n' ? '\n' : ' ';
          index++;
        }
      }
    } else {
      result += current;
      index++;
    }
  }
  return result;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
