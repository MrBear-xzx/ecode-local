import type {
  LocalFileState,
  RemoteFileContent,
  SyncChange,
  SyncManifest,
  SyncPlan,
} from './types';

export function buildSyncPlan(
  manifest: SyncManifest,
  localFiles: Map<string, LocalFileState>,
  remoteFiles: Map<string, RemoteFileContent>,
  unsupported: SyncChange[] = [],
  presentRemotePaths: ReadonlySet<string> = new Set(remoteFiles.keys()),
): SyncPlan {
  const paths = new Set([
    ...Object.keys(manifest.files),
    ...localFiles.keys(),
    ...remoteFiles.keys(),
  ]);
  const changes: SyncChange[] = [];

  for (const path of [...paths].sort()) {
    const baseline = manifest.files[path];
    const local = localFiles.get(path);
    const remote = remoteFiles.get(path);
    if (!remote && presentRemotePaths.has(path)) {
      continue;
    }

    if (!baseline) {
      if (local && remote) {
        changes.push(local.hash === remote.hash
          ? change(path, 'remoteAdded', local.hash, remote.hash, remote.entry.id)
          : {
              ...change(path, 'conflict', local.hash, remote.hash, remote.entry.id),
              conflictReason: 'initialCollision',
              message: '首次同步时本地与远端内容不同',
            });
      } else if (remote) {
        changes.push(change(path, 'remoteAdded', undefined, remote.hash, remote.entry.id));
      } else if (local) {
        changes.push(change(path, 'localAdded', local.hash));
      }
      continue;
    }

    if (local && remote) {
      const localChanged = local.hash !== baseline.baselineHash;
      const remoteChanged = remote.hash !== baseline.baselineHash;
      if (localChanged && remoteChanged) {
        changes.push({
          ...change(path, 'conflict', local.hash, remote.hash, remote.entry.id, baseline.baselineHash),
          conflictReason: 'bothModified',
          message: '本地和远端均已修改',
        });
      } else if (localChanged) {
        changes.push(change(path, 'localModified', local.hash, remote.hash, remote.entry.id, baseline.baselineHash));
      } else if (remoteChanged) {
        changes.push(change(path, 'remoteModified', local.hash, remote.hash, remote.entry.id, baseline.baselineHash));
      } else {
        changes.push(change(path, 'clean', local.hash, remote.hash, remote.entry.id, baseline.baselineHash));
      }
    } else if (!local && remote) {
      if (remote.hash !== baseline.baselineHash) {
        changes.push({
          ...change(path, 'conflict', undefined, remote.hash, remote.entry.id, baseline.baselineHash),
          conflictReason: 'localDeletedRemoteModified',
          message: '本地已删除，同时远端已修改',
        });
      } else {
        changes.push(change(path, 'localDeleted', undefined, remote.hash, remote.entry.id, baseline.baselineHash));
      }
    } else if (local && !remote) {
      if (local.hash !== baseline.baselineHash) {
        changes.push({
          ...change(path, 'conflict', local.hash, undefined, baseline.remoteId, baseline.baselineHash),
          conflictReason: 'remoteDeletedLocalModified',
          message: '远端已删除，同时本地已修改',
        });
      } else {
        changes.push(change(path, 'remoteDeleted', local.hash, undefined, baseline.remoteId, baseline.baselineHash));
      }
    } else {
      changes.push(change(path, 'remoteDeleted', undefined, undefined, baseline.remoteId, baseline.baselineHash));
    }
  }

  changes.push(...unsupported);
  const executable = changes.filter(item =>
    item.status === 'remoteAdded'
    || item.status === 'remoteModified'
    || item.status === 'remoteDeleted',
  );
  const blocked = changes.filter(item =>
    item.status === 'conflict'
    || item.status === 'localDeleted'
    || item.status === 'unsupported',
  );

  return {
    generatedAt: new Date().toISOString(),
    changes,
    executable,
    blocked,
    warnings: blocked.length > 0 ? [`${blocked.length} 项不会自动应用`] : [],
  };
}

export function buildLocalChanges(
  manifest: SyncManifest,
  localFiles: Map<string, LocalFileState>,
): SyncChange[] {
  const paths = new Set([...Object.keys(manifest.files), ...localFiles.keys()]);
  const changes: SyncChange[] = [];
  for (const path of [...paths].sort()) {
    const baseline = manifest.files[path];
    const local = localFiles.get(path);
    if (!baseline && local) {
      changes.push(change(path, 'localAdded', local.hash));
    } else if (baseline && !local) {
      changes.push(change(path, 'localDeleted', undefined, undefined, baseline.remoteId, baseline.baselineHash));
    } else if (baseline && local && baseline.baselineHash !== local.hash) {
      changes.push(change(path, 'localModified', local.hash, undefined, baseline.remoteId, baseline.baselineHash));
    }
  }
  return changes;
}

function change(
  path: string,
  status: SyncChange['status'],
  localHash?: string,
  remoteHash?: string,
  remoteId?: string,
  baselineHash?: string,
): SyncChange {
  return { path, status, localHash, remoteHash, remoteId, baselineHash };
}
