import { createHash } from 'crypto';

export function normalizeText(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

export function hashText(content: string): string {
  return createHash('sha256').update(normalizeText(content), 'utf8').digest('hex');
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
