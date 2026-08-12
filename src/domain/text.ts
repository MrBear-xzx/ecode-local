import { createHash } from 'crypto';
import { createReadStream } from 'fs';

export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;

export function normalizeText(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

export function hashText(content: string): string {
  return createHash('sha256').update(normalizeText(content), 'utf8').digest('hex');
}

export function textByteSize(content: string): number {
  return Buffer.byteLength(normalizeText(content), 'utf8');
}

export async function hashFileBytes(
  filePath: string,
  maxBytes = MAX_RESOURCE_BYTES,
): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`资源文件超过 ${formatResourceLimit(maxBytes)} 上限`);
    }
    hash.update(buffer);
  }
  return { hash: hash.digest('hex'), size };
}

export function formatResourceLimit(bytes = MAX_RESOURCE_BYTES): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

export function isSupportedText(content: string): boolean {
  return !content.includes('\u0000') && !content.includes('\uFFFD');
}

export function serverFingerprint(serverUrl: string, username: string): string {
  const normalizedUrl = serverUrl.trim().replace(/\/+$/, '').toLowerCase();
  return createHash('sha256')
    .update(`${normalizedUrl}\n${username.trim().toLowerCase()}`, 'utf8')
    .digest('hex');
}
