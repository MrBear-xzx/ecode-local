import * as path from 'path';
import { resolveEcodeSourceRoot, resolveLegacySyncRoot } from './paths';
import type { ConnectionProfile, LegacyConnectionProfile } from './types';

export type LegacyProfileMigration =
  | { kind: 'migrated'; profile: ConnectionProfile }
  | { kind: 'confirmationRequired'; legacyProfile: LegacyConnectionProfile };

export function classifyLegacyProfile(
  legacyProfile: LegacyConnectionProfile,
): LegacyProfileMigration {
  const fixedRoot = resolveEcodeSourceRoot(legacyProfile.workspaceFolder);
  const legacyRoot = resolveLegacySyncRoot(
    legacyProfile.workspaceFolder,
    legacyProfile.localDirectory,
  );
  if (!samePath(fixedRoot, legacyRoot)) {
    return { kind: 'confirmationRequired', legacyProfile };
  }
  return {
    kind: 'migrated',
    profile: {
      version: 3,
      workspaceFolder: legacyProfile.workspaceFolder,
      serverUrl: legacyProfile.serverUrl,
      username: legacyProfile.username,
    },
  };
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US')
      === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}
