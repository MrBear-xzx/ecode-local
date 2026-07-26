import { COMPONENT_DEFINITIONS_PART_01 } from './componentData01';
import { COMPONENT_DEFINITIONS_PART_02 } from './componentData02';
import { COMPONENT_DEFINITIONS_PART_03 } from './componentData03';
import { COMPONENT_DEFINITIONS_PART_04 } from './componentData04';
import { COMPONENT_DEFINITIONS_PART_05 } from './componentData05';
import { COMPONENT_DEFINITIONS_PART_06 } from './componentData06';
import { COMPONENT_DEFINITIONS_PART_07 } from './componentData07';
import type {
  EcodeComponentEntry,
  EcodeComponentNamespace,
} from './componentTypes';

// 官方 PC 组件库知识快照；运行时只读取本地数据，不访问文档站。
export type {
  EcodeComponentEntry,
  EcodeComponentNamespace,
  EcodeComponentProp,
} from './componentTypes';

export const ECODE_COMPONENT_DOCUMENTATION_URL =
  'https://cloudstore.e-cology.cn/#/pc/doc/common-index';

const COMPONENT_DEFINITIONS = [
  ...COMPONENT_DEFINITIONS_PART_01,
  ...COMPONENT_DEFINITIONS_PART_02,
  ...COMPONENT_DEFINITIONS_PART_03,
  ...COMPONENT_DEFINITIONS_PART_04,
  ...COMPONENT_DEFINITIONS_PART_05,
  ...COMPONENT_DEFINITIONS_PART_06,
  ...COMPONENT_DEFINITIONS_PART_07,
];

export const ECODE_COMPONENT_ENTRIES: readonly EcodeComponentEntry[] =
  COMPONENT_DEFINITIONS.map(([
    namespace,
    name,
    title,
    description,
    slug,
    props,
  ]) => ({
    namespace,
    name,
    title,
    description,
    props: props.map(([propName, type, required, propDescription, defaultValue]) => ({
      name: propName,
      type,
      required,
      description: propDescription,
      defaultValue: defaultValue || undefined,
    })),
    officialUrl: `https://cloudstore.e-cology.cn/#/pc/component/${slug}`,
  }));

const COMPONENT_LOOKUP = new Map(
  ECODE_COMPONENT_ENTRIES.map(entry => [
    `${entry.namespace}.${entry.name}`,
    entry,
  ]),
);

export function getComponentEntries(
  namespace?: EcodeComponentNamespace,
): readonly EcodeComponentEntry[] {
  return namespace
    ? ECODE_COMPONENT_ENTRIES.filter(entry => entry.namespace === namespace)
    : ECODE_COMPONENT_ENTRIES;
}

export function getComponentEntry(
  namespace: EcodeComponentNamespace,
  name: string,
): EcodeComponentEntry | undefined {
  return COMPONENT_LOOKUP.get(`${namespace}.${name}`);
}

export function parseComponentMemberContext(
  textBeforeCursor: string,
): { namespace: EcodeComponentNamespace; prefix: string } | undefined {
  const match = /(?:window\.)?(ecCom|antd)\.([A-Za-z_$][\w$]*)?$/
    .exec(textBeforeCursor);
  return match
    ? {
      namespace: match[1] as EcodeComponentNamespace,
      prefix: match[2] ?? '',
    }
    : undefined;
}

export function findDirectComponentReferenceAt(
  text: string,
  offset: number,
): EcodeComponentEntry | undefined {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }
  const pattern = /(?:window\.)?(ecCom|antd)\.([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const nameOffset = match.index + match[0].lastIndexOf(match[2]);
    if (offset >= nameOffset && offset <= nameOffset + match[2].length) {
      return getComponentEntry(
        match[1] as EcodeComponentNamespace,
        match[2],
      );
    }
  }
  return undefined;
}

export function getComponentBindings(
  text: string,
): ReadonlyMap<string, EcodeComponentEntry> {
  const bindings = new Map<string, EcodeComponentEntry>();
  const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['"](ecCom|antd)['"]/g;
  const destructuringPattern =
    /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*(?:window\.)?(ecCom|antd)\b/g;
  const assignmentPattern =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?(ecCom|antd)\.([A-Za-z_$][\w$]*)/g;

  addBindings(importPattern, text, bindings, 'as');
  addBindings(destructuringPattern, text, bindings, ':');
  let assignment: RegExpExecArray | null;
  while ((assignment = assignmentPattern.exec(text)) !== null) {
    const entry = getComponentEntry(
      assignment[2] as EcodeComponentNamespace,
      assignment[3],
    );
    if (entry) {
      bindings.set(assignment[1], entry);
    }
  }
  return bindings;
}

export function parseJsxComponentCompletionContext(
  textBeforeCursor: string,
  bindings: ReadonlyMap<string, EcodeComponentEntry>,
): { prefix: string; entries: readonly EcodeComponentEntry[] } | undefined {
  const match = /<([A-Za-z_$][\w$]*)?$/.exec(textBeforeCursor);
  if (!match) {
    return undefined;
  }
  const entries = [...new Set(bindings.values())];
  return entries.length > 0
    ? { prefix: match[1] ?? '', entries }
    : undefined;
}

export function parseJsxPropContext(
  textBeforeCursor: string,
  bindings: ReadonlyMap<string, EcodeComponentEntry>,
): {
  entry: EcodeComponentEntry;
  prefix: string;
  usedProps: ReadonlySet<string>;
} | undefined {
  const tagStart = textBeforeCursor.lastIndexOf('<');
  if (tagStart < 0) {
    return undefined;
  }
  const fragment = textBeforeCursor.slice(tagStart);
  const tag =
    /^<(?:(?:window\.)?((?:ecCom|antd))\.)?([A-Za-z_$][\w$]*)([\s\S]*)$/
    .exec(fragment);
  if (
    !tag
    || tag[3].includes('/>')
    || /(^|[^=])>/.test(tag[3])
    || hasUnclosedQuote(tag[3])
  ) {
    return undefined;
  }

  const entry = tag[1]
    ? getComponentEntry(tag[1] as EcodeComponentNamespace, tag[2])
    : bindings.get(tag[2]);
  if (!entry) {
    return undefined;
  }

  const trailing = /(?:^|\s)([A-Za-z_$][\w$]*)?$/.exec(tag[3]);
  if (!trailing) {
    return undefined;
  }
  const usedProps = new Set(
    [...tag[3].matchAll(/\s([A-Za-z_$][\w$]*)\s*(?==|\s|$)/g)]
      .map(match => match[1]),
  );
  return {
    entry,
    prefix: trailing[1] ?? '',
    usedProps,
  };
}

function addBindings(
  pattern: RegExp,
  text: string,
  bindings: Map<string, EcodeComponentEntry>,
  aliasSeparator: 'as' | ':',
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const namespace = match[2] as EcodeComponentNamespace;
    for (const item of match[1].split(',')) {
      const withoutComments = item
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/g, '')
        .trim();
      if (!withoutComments) {
        continue;
      }
      const separator = aliasSeparator === 'as' ? /\s+as\s+/ : /\s*:\s*/;
      const [exportedName, localName = exportedName] = withoutComments.split(separator);
      const entry = getComponentEntry(namespace, exportedName.trim());
      if (entry && /^[A-Za-z_$][\w$]*$/.test(localName.trim())) {
        bindings.set(localName.trim(), entry);
      }
    }
  }
}

function hasUnclosedQuote(text: string): boolean {
  let quote = '';
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '\'' || character === '"') {
      quote = character;
    }
  }
  return quote !== '';
}
