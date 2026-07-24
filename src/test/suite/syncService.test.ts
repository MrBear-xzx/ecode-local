import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import type { ConnectionProfile, StoredConflict, SyncManifest } from '../../domain/types';
import type { WorkspaceStore } from '../../storage/WorkspaceStore';
import { EcodeSyncService, SyncCancelledError } from '../../sync/EcodeSyncService';
import { EcodeApiClient } from '../../sync/api/EcodeApiClient';
import type { AuthManager } from '../../sync/auth/AuthManager';

suite('Ecode sync service', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;
  let files: Array<{
    id: string;
    name: string;
    content?: string;
    compiledContent?: string;
    status?: number;
    parentId?: string;
  }>;
  let folders: Array<{ id: string; name: string; parentId: string }>;
  let failedUploads: Set<string>;
  let corruptedUploads: Set<string>;
  let duplicateFolders: boolean;
  let expiredTreeResponses: number;
  let rootTreeRequests: number;

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-service-'));
    files = [{ id: 'file-1', name: 'a.js', content: 'const remote = true;\n' }];
    folders = [];
    failedUploads = new Set();
    corruptedUploads = new Set();
    duplicateFolders = false;
    expiredTreeResponses = 0;
    rootTreeRequests = 0;
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/ecode/type/tree' && !url.search) {
        rootTreeRequests++;
        if (expiredTreeResponses > 0) {
          expiredTreeResponses--;
          response.end(JSON.stringify({
            status: false,
            errorCode: '002',
            errorMsg: '登录信息超时',
          }));
          return;
        }
        response.end(JSON.stringify({
          status: true,
          data: {
            typeList: [{ id: 'type-1', name: 'Type', attribute: 'type' }],
            childFolder: [],
            childFile: [],
          },
        }));
        return;
      }
      if (
        url.pathname === '/api/ecode/type/tree' &&
        ['folder-1', 'folder-2'].includes(url.searchParams.get('folderId') ?? '')
      ) {
        response.end(JSON.stringify({
          status: true,
          data: { typeList: [], childFolder: [], childFile: [] },
        }));
        return;
      }
      if (url.pathname === '/api/ecode/type/tree' && url.searchParams.has('folderId')) {
        const folderId = url.searchParams.get('folderId') ?? '';
        response.end(JSON.stringify({
          status: true,
          data: {
            typeList: [],
            childFolder: folders
              .filter(folder => folder.parentId === folderId)
              .map(folder => ({
                id: folder.id,
                name: folder.name,
                attribute: 'folder',
              })),
            childFile: files
              .filter(file => file.parentId === folderId)
              .map(file => ({
                id: file.id,
                name: file.name,
                attribute: 'file',
              })),
          },
        }));
        return;
      }
      if (url.pathname === '/api/ecode/type/tree' && url.searchParams.get('typeId') === 'type-1') {
        response.end(JSON.stringify({
          status: true,
          data: {
            typeList: [],
            childFolder: duplicateFolders
              ? [
                  { id: 'folder-1', name: 'Duplicate', attribute: 'folder' },
                  { id: 'folder-2', name: 'Duplicate', attribute: 'folder' },
                ]
              : folders
                  .filter(folder => folder.parentId === 'type-1')
                  .map(folder => ({
                    id: folder.id,
                    name: folder.name,
                    attribute: 'folder',
                  })),
            childFile: files
              .filter(file => !file.parentId || file.parentId === 'type-1')
              .map(file => ({
                id: file.id,
                name: file.name,
                attribute: 'file',
              })),
          },
        }));
        return;
      }
      if (url.pathname === '/api/cloudstore/ecode/one') {
        const file = files.find(item => item.id === url.searchParams.get('id'));
        if (!file || file.status) {
          response.statusCode = file?.status ?? 404;
          response.end(JSON.stringify({ status: false, msg: 'read failed' }));
        } else {
          response.end(JSON.stringify({
            status: true,
            data: { content: file.content },
          }));
        }
        return;
      }
      if (url.pathname === '/api/cloudstore/ecode/addFolder' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          folders.push({
            id: `folder-${folders.length + 10}`,
            name: form.get('name') ?? '',
            parentId: form.get('parentId') || form.get('typeId') || '',
          });
          response.end(JSON.stringify({ api_status: true, status: true }));
        });
        return;
      }
      if (
        ['/api/cloudstore/ecode/updateFile', '/api/cloudstore/ecode/addFile'].includes(url.pathname) &&
        request.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const existing = files.find(file => file.id === form.get('id'));
          const name = existing?.name ?? `${form.get('name')}.${form.get('type')}`;
          const remotePath = `Type/${name}`;
          if (failedUploads.has(remotePath)) {
            response.end(JSON.stringify({ api_status: false, msg: 'upload failed' }));
            return;
          }
          const content = url.pathname.endsWith('/addFile')
            ? form.get('content') ?? ''
            : Buffer.from(form.get('content') ?? '', 'base64').toString('utf8');
          const compiledContent = url.pathname.endsWith('/addFile')
            ? form.get('compiledContent') ?? ''
            : Buffer.from(form.get('compiledContent') ?? '', 'base64').toString('utf8');
          const storedContent = corruptedUploads.has(remotePath) ? `${content}// corrupted\n` : content;
          if (existing) {
            existing.content = storedContent;
            existing.compiledContent = compiledContent;
          } else {
            files.push({
              id: `file-${files.length + 1}`,
              name,
              content: storedContent,
              compiledContent,
              parentId: form.get('folderId') ?? undefined,
            });
          }
          response.end(JSON.stringify({ api_status: true, status: true }));
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ status: false, msg: 'not found' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  teardown(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('pulls a remote file and persists its verified baseline', async () => {
    const harness = createHarness(root, baseUrl);
    const progress: string[] = [];
    const result = await harness.service.pull(message => progress.push(message));
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'const remote = true;\n');
    assert.ok(harness.store.manifest.files['Type/a.js']);
    assert.ok(progress.some(message => message.includes('扫描远端目录')));
    assert.ok(progress.some(message => message.includes('读取远端文件 1/1')));
    assert.ok(progress.some(message => message.includes('扫描本地文件')));
  });

  test('reconnects once when Ecode reports session error 002', async () => {
    expiredTreeResponses = 1;
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(harness.authState.reconnects, 1);
  });

  test('does not retry indefinitely when the renewed session also expires', async () => {
    expiredTreeResponses = 2;
    const harness = createHarness(root, baseUrl);

    await assert.rejects(
      harness.service.pull(() => undefined),
      /登录信息超时/,
    );
    assert.strictEqual(harness.authState.reconnects, 1);
  });

  test('pulls files when the server repeats an ambiguous directory path', async () => {
    duplicateFolders = true;
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
  });

  test('blocks additions below an ambiguous remote directory path', async () => {
    duplicateFolders = true;
    const localPath = path.join(root, 'ecode', 'Type', 'Duplicate', 'new.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'export default true;\n');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pushSelected(
      ['Type/Duplicate/new.js'],
      () => undefined,
    );

    assert.strictEqual(result.pushed, 0);
    assert.strictEqual(result.failed, 1);
    assert.match(result.errors[0], /多个节点/);
  });

  test('keeps a different initial local file and records a conflict', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'const local = true;\n');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.conflicts, 1);
    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'const local = true;\n');
    assert.strictEqual(harness.store.conflicts.get('Type/a.js')?.reason, 'initialCollision');
  });

  test('applies successful files while reporting independent remote read failures', async () => {
    files.push({ id: 'file-2', name: 'broken.js', status: 500 });
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(result.failed, 1);
    assert.match(result.errors[0], /broken\.js/);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      'const remote = true;\n',
    );
  });

  test('pushes a selected new file and records the verified remote result', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'new.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'const created = true;\n');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pushSelected(['Type/new.js'], () => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pushed, 1);
    assert.strictEqual(
      files.find(file => file.name === 'new.js')?.content,
      'const created = true;\n',
    );
    assert.match(files.find(file => file.name === 'new.js')?.compiledContent ?? '', /var created/);
    assert.ok(harness.store.manifest.files['Type/new.js']);
    assert.strictEqual(rootTreeRequests, 1);
  });

  test('creates nested directories without rebuilding the complete remote index', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'Nested', 'new.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, '// 中文内容\n');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pushSelected(
      ['Type/Nested/new.js'],
      () => undefined,
    );

    const nested = folders.find(folder => folder.name === 'Nested');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pushed, 1);
    assert.ok(nested);
    assert.strictEqual(
      files.find(file => file.name === 'new.js' && file.parentId === nested?.id)?.content,
      '// 中文内容\n',
    );
    assert.strictEqual(rootTreeRequests, 1);
  });

  test('does not create or overwrite a remote file when JavaScript compilation fails', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'broken.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'const = ;\n');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pushSelected(
      ['Type/broken.js'],
      () => undefined,
    );

    assert.strictEqual(result.pushed, 0);
    assert.strictEqual(result.failed, 1);
    assert.match(result.errors[0], /Ecode 前端编译失败/);
    assert.ok(!files.some(file => file.name === 'broken.js'));
  });

  test('blocks a push when both local and remote changed after the baseline', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    fs.writeFileSync(
      path.join(root, 'ecode', 'Type', 'a.js'),
      'const localChanged = true;\n',
    );
    files[0].content = 'const remoteChanged = true;\n';

    const result = await harness.service.pushSelected(['Type/a.js'], () => undefined);

    assert.strictEqual(result.pushed, 0);
    assert.strictEqual(result.conflicts, 1);
    assert.strictEqual(files[0].content, 'const remoteChanged = true;\n');
    assert.strictEqual(harness.store.conflicts.get('Type/a.js')?.reason, 'bothModified');
    assert.strictEqual(
      (await harness.service.refreshLocalChanges()).find(change => change.path === 'Type/a.js')?.status,
      'conflict',
    );
  });

  test('keeps successful push baselines when a later selected upload fails', async () => {
    const directory = path.join(root, 'ecode', 'Type');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'good.js'), 'const good = true;\n');
    fs.writeFileSync(path.join(directory, 'bad.js'), 'const bad = true;\n');
    failedUploads.add('Type/bad.js');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pushSelected(
      ['Type/good.js', 'Type/bad.js'],
      () => undefined,
    );

    assert.strictEqual(result.pushed, 1);
    assert.strictEqual(result.failed, 1);
    assert.ok(harness.store.manifest.files['Type/good.js']);
    assert.ok(!harness.store.manifest.files['Type/bad.js']);
  });

  test('does not update the baseline when upload verification differs', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'wrong.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'const expected = true;\n');
    corruptedUploads.add('Type/wrong.js');
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pushSelected(['Type/wrong.js'], () => undefined);

    assert.strictEqual(result.pushed, 0);
    assert.strictEqual(result.failed, 1);
    assert.ok(!harness.store.manifest.files['Type/wrong.js']);
    assert.match(result.errors[0], /校验不一致/);
  });

  test('accepts the current remote side of a stored conflict', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'const local = true;\n');
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);

    await harness.service.acceptRemote('Type/a.js');

    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'const remote = true;\n');
    assert.ok(harness.store.manifest.files['Type/a.js']);
    assert.ok(!harness.store.conflicts.has('Type/a.js'));
  });

  test('honors cancellation before traversing a remote category', async () => {
    const harness = createHarness(root, baseUrl);

    await assert.rejects(
      harness.service.pull(() => undefined, { isCancellationRequested: true }),
      SyncCancelledError,
    );
  });
});

function createHarness(workspaceFolder: string, serverUrl: string): {
  service: EcodeSyncService;
  store: MemoryStore;
  authState: { reconnects: number };
} {
  const profile: ConnectionProfile = {
    version: 2,
    workspaceFolder,
    serverUrl,
    username: 'test',
    localDirectory: 'ecode',
  };
  const store = new MemoryStore(profile);
  const client = new EcodeApiClient(serverUrl);
  const authState = { reconnects: 0 };
  const auth = {
    getAuthenticatedClient: async () => client,
    reconnect: async () => {
      authState.reconnects++;
      return client;
    },
  } as unknown as AuthManager;
  const output = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return {
    service: new EcodeSyncService(
      store as unknown as WorkspaceStore,
      auth,
      output as never,
    ),
    store,
    authState,
  };
}

class MemoryStore {
  manifest: SyncManifest;
  conflicts = new Map<string, StoredConflict>();
  private snapshots = new Map<string, string>();

  constructor(private profile: ConnectionProfile) {
    this.manifest = {
      schemaVersion: 1,
      serverFingerprint: '',
      syncRoot: '',
      updatedAt: new Date(0).toISOString(),
      files: {},
    };
  }

  async getProfile(): Promise<ConnectionProfile> {
    return this.profile;
  }

  async loadManifest(fingerprint: string, syncRoot: string): Promise<SyncManifest> {
    this.manifest.serverFingerprint = fingerprint;
    this.manifest.syncRoot = syncRoot;
    return this.manifest;
  }

  async saveManifest(manifest: SyncManifest): Promise<void> {
    this.manifest = manifest;
  }

  async saveSnapshot(content: string): Promise<string> {
    const key = String(this.snapshots.size + 1);
    this.snapshots.set(key, content);
    return key;
  }

  async readSnapshot(key: string): Promise<string> {
    return this.snapshots.get(key) ?? '';
  }

  async saveConflict(conflict: StoredConflict): Promise<void> {
    this.conflicts.set(conflict.path, conflict);
  }

  async loadConflict(remotePath: string): Promise<StoredConflict | undefined> {
    return this.conflicts.get(remotePath);
  }

  async listConflicts(): Promise<StoredConflict[]> {
    return [...this.conflicts.values()];
  }

  async deleteConflict(remotePath: string): Promise<void> {
    this.conflicts.delete(remotePath);
  }

  async saveRecovery(): Promise<string> {
    return 'recovery.txt';
  }
}
