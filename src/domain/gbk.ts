import { TextDecoder } from 'util';
import { normalizeText } from './text';

export interface GbkIncompatibleCharacter {
  character: string;
  codePoint: number;
  line: number;
  column: number;
}

let supportedCharacters: ReadonlySet<string> | undefined;

export function findGbkIncompatibleCharacters(
  content: string,
  limit = 10,
): GbkIncompatibleCharacter[] {
  if (limit <= 0) {
    return [];
  }
  const supported = getSupportedCharacters();
  const issues: GbkIncompatibleCharacter[] = [];
  let line = 1;
  let column = 1;
  for (const character of normalizeText(content)) {
    if (!supported.has(character)) {
      issues.push({
        character,
        codePoint: character.codePointAt(0)!,
        line,
        column,
      });
      if (issues.length >= limit) {
        break;
      }
    }
    if (character === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return issues;
}

export function formatUnicodeCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function getSupportedCharacters(): ReadonlySet<string> {
  if (supportedCharacters) {
    return supportedCharacters;
  }
  const decoder = new TextDecoder('gbk', { fatal: true });
  const supported = new Set<string>();
  for (let byte = 0; byte <= 0x7f; byte++) {
    supported.add(String.fromCodePoint(byte));
  }
  for (let byte = 0x80; byte <= 0xff; byte++) {
    addDecodedCharacter(supported, decoder, Uint8Array.of(byte));
  }
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail !== 0x7f) {
        addDecodedCharacter(supported, decoder, Uint8Array.of(lead, trail));
      }
    }
  }
  supportedCharacters = supported;
  return supportedCharacters;
}

function addDecodedCharacter(
  supported: Set<string>,
  decoder: TextDecoder,
  bytes: Uint8Array,
): void {
  try {
    const decoded = decoder.decode(bytes);
    if ([...decoded].length === 1) {
      supported.add(decoded);
    }
  } catch {
    // 非法 GBK 字节序列不代表任何可安全保存的字符。
  }
}
