import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  ECODE_ENVIRONMENTS_FILE,
  ECODE_LOCAL_DIRECTORY,
} from '../domain/constants';

const LEGACY_STATE_KEYS = [
  'ecode.v2.profile',
  'ecode.v3.profile',
  'ecode.v4.environments',
] as const;

const LEGACY_PATHS = [
  ['ecode'],
  ['.ecode-ai'],
  [ECODE_LOCAL_DIRECTORY, 'storage'],
  [ECODE_LOCAL_DIRECTORY, 'ecode-ai'],
] as const;

export interface LegacyProjectDetection {
  workspaceFolder: string;
  reasons: string[];
}

export async function detectLegacyProjects(
  context: vscode.ExtensionContext,
  workspaceFolders: readonly string[],
): Promise<LegacyProjectDetection[]> {
  const stateReasons = LEGACY_STATE_KEYS.filter(key =>
    context.workspaceState.get(key) !== undefined);
  const detections: LegacyProjectDetection[] = [];
  for (const workspaceFolder of workspaceFolders) {
    if (await hasCurrentConfiguration(workspaceFolder)) {
      continue;
    }
    const reasons: string[] = [];
    for (const segments of LEGACY_PATHS) {
      const candidate = path.join(workspaceFolder, ...segments);
      if (await exists(candidate)) {
        reasons.push(`旧版目录 ${path.relative(workspaceFolder, candidate)}`);
      }
    }
    const legacyProfile = context.workspaceState.get<{
      workspaceFolder?: unknown;
      localDirectory?: unknown;
    }>('ecode.v2.profile');
    if (
      typeof legacyProfile?.workspaceFolder === 'string'
      && samePath(legacyProfile.workspaceFolder, workspaceFolder)
      && typeof legacyProfile.localDirectory === 'string'
      && await exists(path.join(workspaceFolder, legacyProfile.localDirectory))
    ) {
      reasons.push(`旧版自定义源码目录 ${legacyProfile.localDirectory}`);
    }
    if (reasons.length > 0) {
      reasons.push(...stateReasons.map(key => `旧版工作区状态 ${key}`));
      detections.push({ workspaceFolder, reasons });
    }
  }
  return detections;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase('en-US')
    === path.resolve(right).toLocaleLowerCase('en-US');
}

async function hasCurrentConfiguration(workspaceFolder: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(
        workspaceFolder,
        ECODE_LOCAL_DIRECTORY,
        ECODE_ENVIRONMENTS_FILE,
      ),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
    return parsed.schemaVersion === 2;
  } catch {
    return false;
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
