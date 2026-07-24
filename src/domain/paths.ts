import * as fs from 'fs';
import * as path from 'path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001F]/;

export function normalizeRemotePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\')) {
    throw new Error('远端路径为空或包含非法字符');
  }

  const rawSegments = value.split('/');
  if (rawSegments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`远端路径包含穿越或空名称: ${value}`);
  }

  const normalized = path.posix.normalize(value);
  if (
    normalized === '.'
    || normalized.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`远端路径越界: ${value}`);
  }

  for (const segment of normalized.split('/')) {
    if (
      !segment
      || segment === '.'
      || segment === '..'
      || WINDOWS_RESERVED.test(segment)
      || WINDOWS_INVALID.test(segment)
      || segment.endsWith('.')
      || segment.endsWith(' ')
    ) {
      throw new Error(`远端路径包含非法名称: ${value}`);
    }
  }
  return normalized;
}

export function assertNoCaseCollisions(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const value of paths) {
    const key = value.toLocaleLowerCase('en-US');
    const existing = seen.get(key);
    if (existing && existing !== value) {
      throw new Error(`路径大小写冲突: ${existing} / ${value}`);
    }
    seen.set(key, value);
  }
}

export function resolveSafeSyncRoot(workspaceFolder: string, localDirectory: string): string {
  const segments = localDirectory.split(/[\\/]+/);
  if (
    !localDirectory.trim()
    || path.isAbsolute(localDirectory)
    || segments.includes('..')
  ) {
    throw new Error('本地目录必须是工作区内的相对路径');
  }

  const workspaceRoot = path.resolve(workspaceFolder);
  const target = path.resolve(workspaceRoot, localDirectory);
  assertInside(workspaceRoot, target);

  const realWorkspace = fs.realpathSync(workspaceRoot);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error('无法验证本地目录');
    }
    probe = parent;
  }

  const realProbe = fs.realpathSync(probe);
  assertInside(realWorkspace, realProbe);
  if (fs.existsSync(target)) {
    assertInside(realWorkspace, fs.realpathSync(target));
  }
  return target;
}

export function resolveSafeLocalPath(syncRoot: string, remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  const target = path.resolve(syncRoot, ...normalized.split('/'));
  assertInside(path.resolve(syncRoot), target);
  return target;
}

export function assertNoSymlinkSegments(syncRoot: string, target: string): void {
  const root = path.resolve(syncRoot);
  assertInside(root, path.resolve(target));
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      return;
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`同步路径包含符号链接: ${current}`);
    }
  }
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径超出工作区范围: ${target}`);
  }
}
