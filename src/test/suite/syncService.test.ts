import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { type AddressInfo } from 'net';
import type { FormMetadataCache } from '../../domain/formMetadata';
import { hashFileBytes, hashText } from '../../domain/text';
import type {
  ConnectionProfile,
  AppMetadataSnapshot,
  PromotionCandidate,
  ReleaseArtifact,
  StoredConflict,
  SyncManifest,
} from '../../domain/types';
import type { WorkspaceStore } from '../../storage/WorkspaceStore';
import { EcodeSyncService, SyncCancelledError } from '../../sync/EcodeSyncService';
import { LocalWorkspaceScanner } from '../../sync/LocalWorkspaceScanner';
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
    metadata?: unknown;
  }>;
  let folders: Array<{ id: string; name: string; parentId: string }>;
  let resources: Array<{
    id: string;
    name: string;
    parentId: string;
    content: Buffer;
  }>;
  let failedResourceUploads: number;
  let failedUploads: Set<string>;
  let corruptedUploads: Set<string>;
  let ambiguousUploads: Set<string>;
  let delayedUploadReads: Map<string, number>;
  let staleRemoteReads: Map<string, { remaining: number; content: string }>;
  let duplicateFolders: boolean;
  let expiredTreeResponses: number;
  let rootTreeRequests: number;
  let updateFileRequests: number;
  let folderDeleteRequests: number;
  let folderTreeRequests: Map<string, number>;
  let requestedFormIds: string[];

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-service-'));
    files = [{ id: 'file-1', name: 'a.js', content: 'const remote = true;\n' }];
    folders = [];
    resources = [];
    failedResourceUploads = 0;
    failedUploads = new Set();
    corruptedUploads = new Set();
    ambiguousUploads = new Set();
    delayedUploadReads = new Map();
    staleRemoteReads = new Map();
    duplicateFolders = false;
    expiredTreeResponses = 0;
    rootTreeRequests = 0;
    updateFileRequests = 0;
    folderDeleteRequests = 0;
    folderTreeRequests = new Map();
    requestedFormIds = [];
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/resource/')) {
        const resource = resources.find(item => item.id === url.pathname.slice('/resource/'.length));
        if (!resource) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Length', String(resource.content.length));
        response.end(resource.content);
        return;
      }
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
            typeList: [{
              id: 'type-1',
              name: 'Type',
              attribute: 'type',
              appId: 'app-1',
            }],
            childFolder: [],
            childFile: [],
          },
        }));
        return;
      }
      if (url.pathname === '/api/ecode/type/tree' && url.searchParams.has('folderId')) {
        const folderId = url.searchParams.get('folderId') ?? '';
        folderTreeRequests.set(
          folderId,
          (folderTreeRequests.get(folderId) ?? 0) + 1,
        );
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
            resources: resources
              .filter(resource => resource.parentId === folderId)
              .map(resource => ({
                id: resource.id,
                name: resource.name,
                attribute: 'resource',
                route: `/resource/${resource.id}`,
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
            resources: resources
              .filter(resource => resource.parentId === 'type-1')
              .map(resource => ({
                id: resource.id,
                name: resource.name,
                attribute: 'resource',
                route: `/resource/${resource.id}`,
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
          const stale = staleRemoteReads.get(file.id);
          const content = stale?.content ?? file.content;
          if (stale) {
            stale.remaining--;
            if (stale.remaining <= 0) {
              staleRemoteReads.delete(file.id);
            }
          }
          response.end(JSON.stringify({
            status: true,
            data: {
              content,
              ...(file.metadata === undefined ? {} : { metadata: file.metadata }),
            },
          }));
        }
        return;
      }
      if (
        url.pathname === '/api/workflow/formSetting/fieldSet/getFieldList'
        && request.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          requestedFormIds.push(form.get('formId') ?? '');
          response.end(JSON.stringify({
            status: true,
            data: { sessionkey: `fields-${form.get('formId')}` },
          }));
        });
        return;
      }
      if (
        url.pathname === '/api/ec/dev/table/datas'
        && request.method === 'POST'
      ) {
        response.end(JSON.stringify({
          status: true,
          data: {
            datas: [{
              id: '110',
              fieldName: 'cfdd',
              fieldlabel: '出发地点',
              viewtype: '0',
              groupname: '主表',
            }],
          },
        }));
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
        url.pathname === '/api/ecode/resource/remove'
        && request.method === 'POST'
      ) {
        void collectRequestBody(request).then(body => {
          const form = new URLSearchParams(body.toString('utf8'));
          const index = resources.findIndex(item => item.id === form.get('resourceId'));
          if (index >= 0) {
            resources.splice(index, 1);
          }
          response.end(JSON.stringify({ status: index >= 0 }));
        });
        return;
      }
      if (
        url.pathname === '/api/ecode/resource/upload'
        && request.method === 'POST'
      ) {
        void collectRequestBody(request).then(body => {
          if (failedResourceUploads > 0) {
            failedResourceUploads--;
            response.end(JSON.stringify({ status: false, msg: 'upload failed' }));
            return;
          }
          const contentType = request.headers['content-type'] ?? '';
          const boundary = /boundary=([^;]+)/.exec(contentType)?.[1] ?? '';
          const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'));
          const footer = Buffer.from(`\r\n--${boundary}--`);
          const footerStart = body.lastIndexOf(footer);
          const header = body.subarray(0, headerEnd).toString('utf8');
          const name = /filename="([^"]+)"/.exec(header)?.[1] ?? 'resource.bin';
          resources.push({
            id: `resource-${resources.length + 10}`,
            name,
            parentId: url.searchParams.get('folderId') ?? '',
            content: body.subarray(headerEnd + 4, footerStart),
          });
          response.end(JSON.stringify({ status: true }));
        });
        return;
      }
      if (
        url.pathname === '/api/cloudstore/ecode/logicalDeleteFile'
        && request.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const index = files.findIndex(file => file.id === form.get('id'));
          if (index < 0) {
            response.end(JSON.stringify({ api_status: false, msg: 'file not found' }));
            return;
          }
          files.splice(index, 1);
          response.end(JSON.stringify({ api_status: true, status: true }));
        });
        return;
      }
      if (
        url.pathname === '/api/cloudstore/ecode/logicalDeleteFolder'
        && request.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const folderId = form.get('folderId');
          const index = folders.findIndex(folder => folder.id === folderId);
          if (index < 0) {
            response.end(JSON.stringify({ api_status: false, msg: 'folder not found' }));
            return;
          }
          const descendantIds = new Set<string>([folderId ?? '']);
          let changed = true;
          while (changed) {
            changed = false;
            for (const folder of folders) {
              if (descendantIds.has(folder.parentId) && !descendantIds.has(folder.id)) {
                descendantIds.add(folder.id);
                changed = true;
              }
            }
          }
          folders = folders.filter(folder => !descendantIds.has(folder.id));
          files = files.filter(file => !file.parentId || !descendantIds.has(file.parentId));
          folderDeleteRequests++;
          response.end(JSON.stringify({ api_status: true, status: true }));
        });
        return;
      }
      if (
        ['/api/cloudstore/ecode/updateFile', '/api/cloudstore/ecode/addFile'].includes(url.pathname) &&
        request.method === 'POST'
      ) {
        if (url.pathname.endsWith('/updateFile')) {
          updateFileRequests++;
        }
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
            const delayedReads = delayedUploadReads.get(remotePath) ?? 0;
            if (delayedReads > 0) {
              staleRemoteReads.set(existing.id, {
                remaining: delayedReads,
                content: existing.content ?? '',
              });
            }
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
          if (ambiguousUploads.has(remotePath)) {
            request.socket.destroy();
            return;
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

  test('pulls raw resources and restores the old remote bytes when replacement upload fails', async () => {
    files = [];
    folders = [{ id: 'resource-folder', name: 'Resources', parentId: 'type-1' }];
    const original = Buffer.from([0, 255, 1, 128]);
    resources = [{
      id: 'resource-1',
      name: 'logo.png',
      parentId: 'resource-folder',
      content: original,
    }];
    const harness = createHarness(root, baseUrl);

    const pull = await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'Resources', 'logo.png');
    assert.strictEqual(pull.success, true);
    assert.deepStrictEqual(fs.readFileSync(localPath), original);
    assert.strictEqual(
      harness.store.manifest.files['Type/Resources/logo.png'].kind,
      'resource',
    );

    fs.writeFileSync(localPath, Buffer.from([9, 8, 7, 6]));
    failedResourceUploads = 1;
    const push = await harness.service.pushSelected(
      ['Type/Resources/logo.png'],
      () => undefined,
    );

    assert.strictEqual(push.pushed, 0);
    assert.strictEqual(push.failed, 1);
    assert.match(push.errors[0], /旧版本已恢复/);
    assert.strictEqual(resources.length, 1);
    assert.strictEqual(resources[0].name, 'logo.png');
    assert.deepStrictEqual(resources[0].content, original);
  });

  test('applies a binary resource change set by target path without reusing the source id', async () => {
    files = [];
    folders = [{ id: 'target-resource-folder', name: 'Resources', parentId: 'type-1' }];
    const original = Buffer.from([1, 2, 3, 4]);
    resources = [{
      id: 'target-resource-id',
      name: 'logo.png',
      parentId: 'target-resource-folder',
      content: original,
    }];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const replacementPath = path.join(root, 'replacement-object.bin');
    const replacement = Buffer.from([9, 8, 7, 6, 5]);
    fs.writeFileSync(replacementPath, replacement);
    const base = await hashFileBytes(path.join(
      root,
      'ecode',
      'Type',
      'Resources',
      'logo.png',
    ));
    const result = await hashFileBytes(replacementPath);
    const artifact: ReleaseArtifact = {
      path: 'Type/Resources/logo.png',
      operation: 'modify',
      kind: 'resource',
      size: result.size,
      baseHash: base.hash,
      resultHash: result.hash,
      resultResourcePath: replacementPath,
    };

    const candidates: PromotionCandidate[] = [];
    const deployed = await harness.service.deployRelease(
      await harness.store.getProfile(),
      [artifact],
      () => undefined,
      undefined,
      candidate => candidates.push(candidate),
    );

    assert.strictEqual(deployed[0].status, 'succeeded');
    assert.strictEqual(resources.length, 1);
    assert.notStrictEqual(resources[0].id, 'target-resource-id');
    assert.deepStrictEqual(resources[0].content, replacement);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'Resources', 'logo.png')),
      replacement,
    );
    assert.strictEqual(candidates[0].kind, 'resource');
    assert.ok(candidates[0].baseResourcePath);
    assert.ok(fs.existsSync(candidates[0].baseResourcePath!));
  });

  test('deletes a resource without deleting its resource root', async () => {
    files = [];
    folders = [{ id: 'resource-folder', name: 'Resources', parentId: 'type-1' }];
    resources = [{
      id: 'resource-1',
      name: 'obsolete.bin',
      parentId: 'resource-folder',
      content: Buffer.from([1, 0, 2]),
    }];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    fs.unlinkSync(path.join(root, 'ecode', 'Type', 'Resources', 'obsolete.bin'));

    const result = await harness.service.pushSelected(
      ['Type/Resources/obsolete.bin'],
      () => undefined,
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedRemote, 1);
    assert.deepStrictEqual(resources, []);
    assert.ok(folders.some(folder => folder.id === 'resource-folder'));
  });

  test('uploads a new resource only inside a known resource root', async () => {
    files = [];
    folders = [{ id: 'resource-folder', name: 'Resources', parentId: 'type-1' }];
    resources = [{
      id: 'resource-seed',
      name: 'seed.bin',
      parentId: 'resource-folder',
      content: Buffer.from([1]),
    }];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const added = Buffer.from([0, 255, 5, 128]);
    const localPath = path.join(root, 'ecode', 'Type', 'Resources', 'new.bin');
    fs.writeFileSync(localPath, added);

    const result = await harness.service.pushSelected(
      ['Type/Resources/new.bin'],
      () => undefined,
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pushed, 1);
    assert.deepStrictEqual(
      resources.find(resource => resource.name === 'new.bin')?.content,
      added,
    );
    assert.strictEqual(harness.store.manifest.files['Type/Resources/new.bin'].kind, 'resource');
  });

  test('batches manifest persistence during a full pull', async () => {
    files = Array.from({ length: 51 }, (_, index) => ({
      id: `file-${index}`,
      name: `file-${index}.js`,
      content: `const value = ${index};\n`,
    }));
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.pulled, files.length);
    assert.strictEqual(harness.store.manifestSaves, 3);
  });

  test('flushes the manifest when pull post-processing exits unexpectedly', async () => {
    files = [
      { id: 'file-1', name: 'first.js', content: 'const first = true;\n' },
      { id: 'file-2', name: 'second.js', content: 'const second = true;\n' },
    ];
    const harness = createHarness(root, baseUrl);

    await assert.rejects(
      harness.service.pull(message => {
        if (message.includes('正在应用远端变更 2/2')) {
          throw new Error('simulated progress failure');
        }
      }),
      /simulated progress failure/,
    );

    assert.strictEqual(harness.store.manifestSaves, 1);
    assert.ok(harness.store.manifest.files['Type/first.js']);
  });

  test('does not report every local file before an environment baseline exists', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'local.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'const local = true;\n');
    const harness = createHarness(root, baseUrl);
    harness.store.manifest.updatedAt = new Date(0).toISOString();

    const changes = await harness.service.refreshLocalChanges();

    assert.deepStrictEqual(changes, []);
    assert.strictEqual(await harness.service.hasSyncBaseline(), false);
    assert.match(
      harness.service.getLastPlan()?.warnings[0] ?? '',
      /尚未建立同步基线/,
    );
    await assert.rejects(
      harness.service.pushSelected(['Type/local.js'], () => undefined),
      /先执行全量拉取/,
    );
    await harness.service.pull(() => undefined);
    assert.strictEqual(await harness.service.hasSyncBaseline(), true);
  });

  test('refreshes remote state and reports a conflict without applying remote content', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, 'const local = true;\n');
    files[0].content = 'const remoteAfterPull = true;\n';
    const progress: string[] = [];

    const changes = await harness.service.refreshChanges(message => progress.push(message));
    const conflict = changes.find(change => change.path === 'Type/a.js');

    assert.strictEqual(conflict?.status, 'conflict');
    assert.strictEqual(conflict?.conflictReason, 'bothModified');
    assert.strictEqual(conflict?.remoteHash, hashText('const remoteAfterPull = true;\n'));
    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'const local = true;\n');
    assert.strictEqual(harness.store.conflicts.get('Type/a.js')?.reason, 'bothModified');
    assert.ok(progress.some(message => message.includes('读取远端')));
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

  test('isolates ambiguous empty remote directories and continues pulling safe files', async () => {
    duplicateFolders = true;
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(result.unsupported, 1);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      'const remote = true;\n',
    );
    assert.ok(harness.service.getLastPlan()?.blocked.some(change =>
      change.path === 'Type/Duplicate'
        && change.status === 'unsupported'));
  });

  test('allows device-like names and isolates other invalid remote names', async () => {
    folders = [{ id: 'folder-invalid', name: 'Invalid:Folder', parentId: 'type-1' }];
    files.push({
      id: 'file-invalid',
      name: 'CON.js',
      content: 'const invalid = true;\n',
      parentId: 'type-1',
    });
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 2);
    assert.strictEqual(result.unsupported, 1);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      'const remote = true;\n',
    );
    assert.ok(harness.service.getLastPlan()?.blocked.some(change =>
      change.path === 'Type/Invalid:Folder'
        && change.status === 'unsupported'));
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'CON.js'), 'utf8'),
      'const invalid = true;\n',
    );
    assert.strictEqual(folderTreeRequests.get('folder-invalid'), undefined);
  });

  test('deduplicates an identical remote file node before pulling', async () => {
    files.push({ ...files[0] });
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(result.unsupported, 0);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      'const remote = true;\n',
    );
  });

  test('deduplicates an identical remote directory task before traversing it', async () => {
    folders = [
      { id: 'folder-10', name: 'Same', parentId: 'type-1' },
      { id: 'folder-10', name: 'Same', parentId: 'type-1' },
    ];
    files.push({
      id: 'file-2',
      name: 'inside.js',
      content: 'const inside = true;\n',
      parentId: 'folder-10',
    });
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 2);
    assert.strictEqual(result.unsupported, 0);
    assert.strictEqual(folderTreeRequests.get('folder-10'), 1);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'Same', 'inside.js'), 'utf8'),
      'const inside = true;\n',
    );
  });

  test('isolates a repeated remote directory node that would form a cycle', async () => {
    folders = [
      { id: 'folder-10', name: 'Cycle', parentId: 'type-1' },
      { id: 'folder-10', name: 'Nested', parentId: 'folder-10' },
    ];
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(result.unsupported, 1);
    assert.ok(harness.service.getLastPlan()?.blocked.some(change =>
      change.path === 'Type/Cycle/Nested'
        && change.status === 'unsupported'));
  });

  test('allows the same file name in different remote directories', async () => {
    folders = [
      { id: 'folder-10', name: 'First', parentId: 'type-1' },
      { id: 'folder-20', name: 'Second', parentId: 'type-1' },
    ];
    files.push(
      {
        id: 'file-2',
        name: 'a.js',
        content: 'const first = true;\n',
        parentId: 'folder-10',
      },
      {
        id: 'file-3',
        name: 'a.js',
        content: 'const second = true;\n',
        parentId: 'folder-20',
      },
    );
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 3);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'First', 'a.js'), 'utf8'),
      'const first = true;\n',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'Second', 'a.js'), 'utf8'),
      'const second = true;\n',
    );
  });

  test('selects the only populated file when different nodes share one path', async () => {
    files.push({
      id: 'file-2',
      name: 'a.js',
      content: '',
    });
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(result.unsupported, 0);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      'const remote = true;\n',
    );
  });

  test('isolates ambiguous files, logs masked ids, and pulls safe files', async () => {
    files.push(
      {
        id: 'file-2',
        name: 'a.js',
        content: 'const ambiguous = true;\n',
      },
      {
        id: 'file-3',
        name: 'safe.js',
        content: 'const safe = true;\n',
      },
    );
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(result.unsupported, 1);
    assert.strictEqual(fs.existsSync(path.join(root, 'ecode', 'Type', 'a.js')), false);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'safe.js'), 'utf8'),
      'const safe = true;\n',
    );
    const warnings = harness.logs.warnings.join('\n');
    assert.match(warnings, /Type\/a\.js/);
    assert.match(warnings, /fi\*\*\*-1/);
    assert.match(warnings, /fi\*\*\*-2/);
    assert.doesNotMatch(warnings, /file-1|file-2/);
  });

  test('selects the only populated directory when different nodes share one path', async () => {
    duplicateFolders = true;
    files.push({
      id: 'file-2',
      name: 'inside.js',
      content: 'const inside = true;\n',
      parentId: 'folder-1',
    });
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 2);
    assert.strictEqual(result.unsupported, 0);
    assert.strictEqual(
      fs.readFileSync(
        path.join(root, 'ecode', 'Type', 'Duplicate', 'inside.js'),
        'utf8',
      ),
      'const inside = true;\n',
    );
  });

  test('isolates an ambiguous directory subtree without deleting tracked files', async () => {
    folders = [{ id: 'folder-1', name: 'Duplicate', parentId: 'type-1' }];
    files.push({
      id: 'file-2',
      name: 'existing.js',
      content: 'const existing = true;\n',
      parentId: 'folder-1',
    });
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    duplicateFolders = true;
    files.push({
      id: 'file-3',
      name: 'other.js',
      content: 'const other = true;\n',
      parentId: 'folder-2',
    });

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedLocal, 0);
    assert.strictEqual(result.unsupported, 1);
    assert.strictEqual(
      fs.readFileSync(
        path.join(root, 'ecode', 'Type', 'Duplicate', 'existing.js'),
        'utf8',
      ),
      'const existing = true;\n',
    );
    assert.strictEqual(
      fs.existsSync(path.join(root, 'ecode', 'Type', 'Duplicate', 'other.js')),
      false,
    );
    const warnings = harness.logs.warnings.join('\n');
    assert.match(warnings, /Type\/Duplicate/);
    assert.match(warnings, /fo\*\*\*-1/);
    assert.match(warnings, /fo\*\*\*-2/);
    assert.doesNotMatch(warnings, /folder-1|folder-2/);
  });

  test('isolates a file-directory collision and continues pulling safe files', async () => {
    folders = [{ id: 'folder-10', name: 'Collision', parentId: 'type-1' }];
    files.push(
      {
        id: 'file-2',
        name: 'Collision',
        content: 'const impossible = true;\n',
        parentId: 'type-1',
      },
      {
        id: 'file-3',
        name: 'inside.js',
        content: 'const inside = true;\n',
        parentId: 'folder-10',
      },
    );
    const harness = createHarness(root, baseUrl);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 2);
    assert.strictEqual(result.unsupported, 1);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'Collision', 'inside.js'), 'utf8'),
      'const inside = true;\n',
    );
  });

  test('blocks pushes while a duplicate remote directory path exists', async () => {
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
    assert.match(result.errors[0], /Type\/Duplicate.*多个节点/);
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

  test('adopts converged local and remote edits instead of reporting a false conflict', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, 'const converged = true;\n');
    files[0].content = 'const converged = true;\n';

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.conflicts, 0);
    assert.strictEqual(result.pulled, 1);
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      hashText('const converged = true;\n'),
    );
    assert.ok(!harness.store.conflicts.has('Type/a.js'));
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

  test('refreshes, preserves, and removes file form metadata with a full pull', async () => {
    files[0].metadata = {
      workflowId: 77,
      tableInfo: {
        main: {
          fieldInfoMap: {
            110: {
              fieldId: 110,
              fieldLabel: '申请人',
              fieldName: 'applicant',
            },
          },
        },
      },
    };
    const harness = createHarness(root, baseUrl);

    await harness.service.pull(() => undefined);
    assert.strictEqual(
      harness.store.formMetadata.files['Type/a.js']
        .contexts[0].tables[0].fields[0].label,
      '申请人',
    );

    files[0].status = 500;
    await harness.service.pull(() => undefined);
    assert.ok(harness.store.formMetadata.files['Type/a.js']);

    files[0].status = undefined;
    files[0].metadata = '{"tableInfo":';
    await harness.service.pull(() => undefined);
    assert.ok(harness.store.formMetadata.files['Type/a.js']);

    files[0].metadata = undefined;
    await harness.service.pull(() => undefined);
    assert.strictEqual(
      harness.store.formMetadata.files['Type/a.js'],
      undefined,
    );
  });

  test('binds guarded workflow source to fields loaded by formId during full pull', async () => {
    files[0].content = `
      const carRequest = { WfFormId: -133 };
      const runScript = () => WfForm.convertFieldNameToId('cfdd');
      const { formid } = WfForm.getBaseInfo();
      if (formid !== carRequest.WfFormId) return;
      runScript();
    `;
    const harness = createHarness(root, baseUrl);

    await harness.service.pull(() => undefined);

    assert.deepStrictEqual(requestedFormIds, ['-133']);
    const context = harness.store.formMetadata.files['Type/a.js'].contexts[0];
    assert.strictEqual(context.formId, '-133');
    assert.strictEqual(context.tables[0].fields[0].name, 'cfdd');
    assert.strictEqual(context.tables[0].fields[0].label, '出发地点');
  });

  test('does not fail source pull when form metadata cache cannot be saved', async () => {
    const harness = createHarness(root, baseUrl);
    harness.store.failFormMetadataSave = true;

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pulled, 1);
  });

  test('does not delete a tracked local file when its remote content cannot be read', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    files[0].status = 500;
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.deletedLocal, 0);
    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'const remote = true;\n');
    assert.ok(harness.store.manifest.files['Type/a.js']);
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

  test('blocks GBK-incompatible source before any remote push request', async () => {
    const localPath = path.join(root, 'ecode', 'Type', 'unsafe.js');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(
      localPath,
      `const arrow = '${String.fromCodePoint(0x203a)}';\n`,
    );
    const harness = createHarness(root, baseUrl);

    await assert.rejects(
      harness.service.preparePromotionCandidates(['Type/unsafe.js']),
      /Type\/unsafe\.js:1:\d+: "›" \(U\+203A\)/,
    );
    await assert.rejects(
      harness.service.pushSelected(['Type/unsafe.js'], () => undefined),
      /GBK 环境无法保存/,
    );

    assert.strictEqual(rootTreeRequests, 0);
    assert.strictEqual(files.some(file => file.name === 'unsafe.js'), false);
  });

  test('blocks a GBK-incompatible change set before target preflight requests', async () => {
    const content = `const icon = '${String.fromCodePoint(0x1f600)}';\n`;
    const artifact: ReleaseArtifact = {
      path: 'Type/unsafe-release.js',
      operation: 'add',
      resultHash: hashText(content),
      resultContent: content,
    };
    const harness = createHarness(root, baseUrl);

    await assert.rejects(
      harness.service.verifyRelease(
        await harness.store.getProfile(),
        [artifact],
      ),
      /U\+1F600/,
    );

    assert.strictEqual(rootTreeRequests, 0);
    assert.strictEqual(files.some(file => file.name === 'unsafe-release.js'), false);
  });

  test('publishes a frozen artifact when the target has a different base', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const artifact: ReleaseArtifact = {
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('const sourceEnvironmentBase = true;\n'),
      resultHash: hashText('const released = true;\n'),
      resultContent: 'const released = true;\n',
    };

    const preflight = await harness.service.verifyRelease(
      await harness.store.getProfile(),
      [artifact],
    );
    const appliedCandidates: PromotionCandidate[] = [];
    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      [artifact],
      () => undefined,
      undefined,
      candidate => appliedCandidates.push(candidate),
    );

    assert.strictEqual(preflight.success, true);
    assert.strictEqual(preflight.files[0].status, 'pending');
    assert.strictEqual(results[0].status, 'succeeded');
    assert.strictEqual(files[0].content, artifact.resultContent);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      artifact.resultContent,
    );
    assert.deepStrictEqual(harness.store.recoveries, [{
      path: 'Type/a.js',
      content: 'const remote = true;\n',
    }]);
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      artifact.resultHash,
    );
    assert.deepStrictEqual(appliedCandidates, [{
      path: 'Type/a.js',
      operation: 'modify',
      kind: 'text',
      size: Buffer.byteLength('const remote = true;\n', 'utf8'),
      baseHash: hashText('const remote = true;\n'),
      baseContent: 'const remote = true;\n',
      baseResourcePath: undefined,
      resultHash: artifact.resultHash,
      resultContent: artifact.resultContent,
      resultResourcePath: undefined,
    }]);
  });

  test('publishes frozen additions and deletions by remote path', async () => {
    const localScanner = new TrackingLocalWorkspaceScanner();
    const harness = createHarness(root, baseUrl, localScanner);
    await harness.service.pull(() => undefined);
    localScanner.scanCalls = 0;
    const addedContent = 'const addedByRelease = true;\n';
    const artifacts: ReleaseArtifact[] = [{
      path: 'Type/a.js',
      operation: 'delete',
      baseHash: hashText('const sourceEnvironmentBase = true;\n'),
    }, {
      path: 'Type/released.js',
      operation: 'add',
      resultHash: hashText(addedContent),
      resultContent: addedContent,
    }];

    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      artifacts,
      () => undefined,
    );

    assert.ok(results.every(result => result.status === 'succeeded'));
    assert.strictEqual(files.some(file => file.name === 'a.js'), false);
    assert.strictEqual(
      fs.existsSync(path.join(root, 'ecode', 'Type', 'a.js')),
      false,
    );
    assert.strictEqual(
      files.find(file => file.name === 'released.js')?.content,
      addedContent,
    );
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'released.js'), 'utf8'),
      addedContent,
    );
    assert.strictEqual(harness.store.manifest.files['Type/a.js'], undefined);
    assert.strictEqual(
      harness.store.manifest.files['Type/released.js'].baselineHash,
      hashText(addedContent),
    );
    assert.strictEqual(localScanner.scanCalls, 2);
  });

  test('creates a missing target file for a source modification at the same relative path', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const resultContent = 'const appliedAcrossEnvironments = true;\n';
    const artifact: ReleaseArtifact = {
      path: 'Type/Nested/cross-environment.js',
      operation: 'modify',
      baseHash: hashText('const sourceBaseline = true;\n'),
      resultHash: hashText(resultContent),
      resultContent,
    };

    const preflight = await harness.service.verifyRelease(
      await harness.store.getProfile(),
      [artifact],
    );
    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      [artifact],
      () => undefined,
    );

    assert.strictEqual(preflight.success, true);
    assert.strictEqual(preflight.files[0].status, 'pending');
    assert.strictEqual(results[0].status, 'succeeded');
    const createdFolder = folders.find(folder =>
      folder.name === 'Nested' && folder.parentId === 'type-1');
    assert.ok(createdFolder);
    assert.strictEqual(
      files.find(file =>
        file.name === 'cross-environment.js'
        && file.parentId === createdFolder.id)?.content,
      resultContent,
    );
    assert.strictEqual(
      fs.readFileSync(
        path.join(root, 'ecode', 'Type', 'Nested', 'cross-environment.js'),
        'utf8',
      ),
      resultContent,
    );
    assert.strictEqual(files[0].content, 'const remote = true;\n');
    assert.strictEqual(
      harness.store.manifest.files[artifact.path].baselineHash,
      artifact.resultHash,
    );
  });

  test('does not write any release file when remote names conflict', async () => {
    folders = [{
      id: 'folder-10',
      name: 'Collision',
      parentId: 'type-1',
    }];
    files.push({
      id: 'file-2',
      name: 'Collision',
      content: 'const collision = true;\n',
      parentId: 'type-1',
    });
    const harness = createHarness(root, baseUrl);
    const artifacts: ReleaseArtifact[] = [{
      path: 'Type/Collision',
      operation: 'modify',
      baseHash: hashText('const sourceCollision = true;\n'),
      resultHash: hashText('const collisionChanged = true;\n'),
      resultContent: 'const collisionChanged = true;\n',
    }, {
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('const sourceBase = true;\n'),
      resultHash: hashText('const shouldNotApply = true;\n'),
      resultContent: 'const shouldNotApply = true;\n',
    }];

    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      artifacts,
      () => undefined,
    );

    assert.strictEqual(results[0].status, 'conflict');
    assert.match(results[0].message ?? '', /Type\/Collision/);
    assert.strictEqual(results[1].status, 'pending');
    assert.strictEqual(files[0].content, 'const remote = true;\n');
    assert.strictEqual(files[1].content, 'const collision = true;\n');
    assert.deepStrictEqual(harness.store.recoveries, []);
  });

  test('treats an already applied release artifact as successful', async () => {
    const content = 'const remote = true;\n';
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const artifact: ReleaseArtifact = {
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('previous'),
      resultHash: hashText(content),
      resultContent: content,
    };

    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      [artifact],
      () => undefined,
    );

    assert.strictEqual(results[0].status, 'succeeded');
    assert.deepStrictEqual(harness.store.recoveries, []);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      content,
    );
  });

  test('reconciles target local source after a partially completed release', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const resultContent = 'const releasedBeforeRetry = true;\n';
    files[0].content = resultContent;
    const artifact: ReleaseArtifact = {
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('const remote = true;\n'),
      resultHash: hashText(resultContent),
      resultContent,
    };

    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      [artifact],
      () => undefined,
    );

    assert.strictEqual(results[0].status, 'succeeded');
    assert.deepStrictEqual(harness.store.recoveries, [{
      path: 'Type/a.js',
      content: 'const remote = true;\n',
    }]);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      resultContent,
    );
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      artifact.resultHash,
    );
  });

  test('returns a recordable release result when deployment is cancelled', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const artifact: ReleaseArtifact = {
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('const remote = true;\n'),
      resultHash: hashText('const cancelled = true;\n'),
      resultContent: 'const cancelled = true;\n',
    };

    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      [artifact],
      () => undefined,
      { isCancellationRequested: true },
    );

    assert.strictEqual(results[0].status, 'failed');
    assert.match(results[0].message ?? '', /取消/);
    assert.strictEqual(files[0].content, 'const remote = true;\n');
  });

  test('backs up and replaces target local changes with the release snapshot', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    fs.writeFileSync(
      path.join(root, 'ecode', 'Type', 'a.js'),
      'const localOnly = true;\n',
    );
    const addedContent = 'const shouldNotBeCreated = true;\n';
    const artifacts: ReleaseArtifact[] = [{
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('const remote = true;\n'),
      resultHash: hashText('const released = true;\n'),
      resultContent: 'const released = true;\n',
    }, {
      path: 'Type/not-created.js',
      operation: 'add',
      resultHash: hashText(addedContent),
      resultContent: addedContent,
    }];

    const results = await harness.service.deployRelease(
      await harness.store.getProfile(),
      artifacts,
      () => undefined,
    );

    assert.ok(results.every(result => result.status === 'succeeded'));
    assert.strictEqual(files[0].content, 'const released = true;\n');
    assert.strictEqual(files.some(file => file.name === 'not-created.js'), true);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'ecode', 'Type', 'a.js'), 'utf8'),
      'const released = true;\n',
    );
    assert.deepStrictEqual(harness.store.recoveries, [{
      path: 'Type/a.js',
      content: 'const remote = true;\n',
    }, {
      path: 'Type/a.js',
      content: 'const localOnly = true;\n',
    }]);
  });

  test('applies a remote deletion to an unchanged local file with a recovery copy', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    files.splice(0, 1);

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedLocal, 1);
    assert.ok(!fs.existsSync(path.join(root, 'ecode', 'Type', 'a.js')));
    assert.ok(!harness.store.manifest.files['Type/a.js']);
    assert.deepStrictEqual(harness.store.recoveries, [{
      path: 'Type/a.js',
      content: 'const remote = true;\n',
    }]);
  });

  test('removes an empty local directory after the matching remote folder is deleted', async () => {
    folders = [{ id: 'folder-10', name: 'Deleted', parentId: 'type-1' }];
    files = [
      {
        id: 'file-10',
        name: 'first.js',
        content: 'const first = true;\n',
        parentId: 'folder-10',
      },
      {
        id: 'file-11',
        name: 'second.js',
        content: 'const second = true;\n',
        parentId: 'folder-10',
      },
    ];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localFolder = path.join(root, 'ecode', 'Type', 'Deleted');
    assert.ok(fs.existsSync(localFolder));
    folders = [];
    files = [];

    const result = await harness.service.pull(() => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedLocal, 2);
    assert.ok(!fs.existsSync(localFolder));
  });

  test('pushes a local deletion only when the remote content still matches the baseline', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    fs.unlinkSync(path.join(root, 'ecode', 'Type', 'a.js'));

    const result = await harness.service.pushSelected(['Type/a.js'], () => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedRemote, 1);
    assert.ok(!files.some(file => file.id === 'file-1'));
    assert.ok(!harness.store.manifest.files['Type/a.js']);
  });

  test('deletes the matching remote folder when a selected local directory was removed', async () => {
    folders = [{ id: 'folder-10', name: 'Deleted', parentId: 'type-1' }];
    files = [
      {
        id: 'file-10',
        name: 'first.js',
        content: 'const first = true;\n',
        parentId: 'folder-10',
      },
      {
        id: 'file-11',
        name: 'second.js',
        content: 'const second = true;\n',
        parentId: 'folder-10',
      },
    ];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localFolder = path.join(root, 'ecode', 'Type', 'Deleted');
    fs.rmSync(localFolder, { recursive: true });

    const result = await harness.service.pushSelected(
      ['Type/Deleted/first.js', 'Type/Deleted/second.js'],
      () => undefined,
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedRemote, 2);
    assert.strictEqual(folderDeleteRequests, 1);
    assert.ok(!folders.some(folder => folder.id === 'folder-10'));
    assert.ok(!files.some(file => file.parentId === 'folder-10'));
    assert.ok(!harness.store.manifest.files['Type/Deleted/first.js']);
    assert.ok(!harness.store.manifest.files['Type/Deleted/second.js']);
  });

  test('keeps a remote folder when it contains a file outside the selected local deletion', async () => {
    folders = [{ id: 'folder-10', name: 'Deleted', parentId: 'type-1' }];
    files = [
      {
        id: 'file-10',
        name: 'tracked.js',
        content: 'const tracked = true;\n',
        parentId: 'folder-10',
      },
    ];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localFolder = path.join(root, 'ecode', 'Type', 'Deleted');
    fs.rmSync(localFolder, { recursive: true });
    files.push({
      id: 'file-11',
      name: 'remote-only.js',
      content: 'const remoteOnly = true;\n',
      parentId: 'folder-10',
    });

    const result = await harness.service.pushSelected(
      ['Type/Deleted/tracked.js'],
      () => undefined,
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedRemote, 1);
    assert.strictEqual(folderDeleteRequests, 0);
    assert.ok(folders.some(folder => folder.id === 'folder-10'));
    assert.ok(files.some(file => file.id === 'file-11'));
  });

  test('keeps a local deletion when the remote file changed and records a conflict', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    fs.unlinkSync(path.join(root, 'ecode', 'Type', 'a.js'));
    files[0].content = 'const changedRemotely = true;\n';

    const result = await harness.service.pushSelected(['Type/a.js'], () => undefined);

    assert.strictEqual(result.deletedRemote, 0);
    assert.strictEqual(result.conflicts, 1);
    assert.strictEqual(files[0].content, 'const changedRemotely = true;\n');
    assert.strictEqual(
      harness.store.conflicts.get('Type/a.js')?.reason,
      'localDeletedRemoteModified',
    );
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

  test('retries upload verification while the remote read is temporarily stale', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, 'const eventuallyVisible = true;\n');
    delayedUploadReads.set('Type/a.js', 2);

    const result = await harness.service.pushSelected(['Type/a.js'], () => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pushed, 1);
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      hashText('const eventuallyVisible = true;\n'),
    );
  });

  test('accepts a timed-out upload when remote readback proves it succeeded', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const content = 'const appliedAfterTimeout = true;\n';
    fs.writeFileSync(path.join(root, 'ecode', 'Type', 'a.js'), content);
    ambiguousUploads.add('Type/a.js');

    const result = await harness.service.pushSelected(['Type/a.js'], () => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pushed, 1);
    assert.strictEqual(updateFileRequests, 1);
    assert.strictEqual(files[0].content, content);
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      hashText(content),
    );
  });

  test('reconciles an already applied upload without writing it again', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const content = 'const alreadyApplied = true;\n';
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, content);
    files[0].content = content;
    await harness.store.saveConflict(path.join(root, 'ecode'), {
      path: 'Type/a.js',
      remoteId: 'file-1',
      remoteContent: content,
      remoteHash: hashText(content),
      detectedAt: new Date().toISOString(),
      reason: 'bothModified',
    });

    const result = await harness.service.pushSelected(['Type/a.js'], () => undefined);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pushed, 1);
    assert.strictEqual(updateFileRequests, 0);
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      hashText(content),
    );
    assert.ok(!harness.store.conflicts.has('Type/a.js'));
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

  test('turns a modified local file into an addition when keeping a remote deletion conflict', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, 'const localChanged = true;\n');
    files.splice(0, 1);
    await harness.service.pull(() => undefined);

    await harness.service.keepLocalAfterRemoteDeletion('Type/a.js');

    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'const localChanged = true;\n');
    assert.ok(!harness.store.manifest.files['Type/a.js']);
    assert.strictEqual(
      (await harness.service.refreshLocalChanges())[0]?.status,
      'localAdded',
    );
  });

  test('backs up a modified local file before accepting a remote deletion conflict', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, 'const localChanged = true;\n');
    files.splice(0, 1);
    await harness.service.pull(() => undefined);

    const recovery = await harness.service.acceptRemoteDeletion('Type/a.js');

    assert.strictEqual(recovery, 'recovery.txt');
    assert.ok(!fs.existsSync(localPath));
    assert.ok(!harness.store.manifest.files['Type/a.js']);
    assert.deepStrictEqual(harness.store.recoveries.at(-1), {
      path: 'Type/a.js',
      content: 'const localChanged = true;\n',
    });
  });

  test('reverts added, modified, and deleted local changes to the baseline', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const directory = path.join(root, 'ecode', 'Type');
    const baselinePath = path.join(directory, 'a.js');
    const addedPath = path.join(directory, 'added.js');

    fs.writeFileSync(baselinePath, 'const localChanged = true;\n');
    await harness.service.revertLocalChange('Type/a.js');
    assert.strictEqual(fs.readFileSync(baselinePath, 'utf8'), 'const remote = true;\n');

    fs.unlinkSync(baselinePath);
    await harness.service.revertLocalChange('Type/a.js');
    assert.strictEqual(fs.readFileSync(baselinePath, 'utf8'), 'const remote = true;\n');

    fs.writeFileSync(addedPath, 'const added = true;\n');
    await harness.service.revertLocalChange('Type/added.js');
    assert.ok(!fs.existsSync(addedPath));
  });

  test('rolls a successful push back locally without changing remote or baseline', async () => {
    files = [
      { id: 'file-1', name: 'a.js', content: 'const value = "before";\n' },
      { id: 'file-2', name: 'deleted.js', content: 'const deleted = true;\n' },
    ];
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const directory = path.join(root, 'ecode', 'Type');
    fs.writeFileSync(path.join(directory, 'a.js'), 'const value = "after";\n');
    fs.writeFileSync(path.join(directory, 'added.js'), 'const added = true;\n');
    fs.unlinkSync(path.join(directory, 'deleted.js'));
    const selected = ['Type/a.js', 'Type/added.js', 'Type/deleted.js'];
    const candidates = await harness.service.preparePromotionCandidates(selected);
    const pushed = await harness.service.pushSelected(selected, () => undefined);
    assert.strictEqual(pushed.success, true);

    const recoveries = await harness.service.rollbackPushLocally(candidates);

    assert.strictEqual(
      fs.readFileSync(path.join(directory, 'a.js'), 'utf8'),
      'const value = "before";\n',
    );
    assert.ok(!fs.existsSync(path.join(directory, 'added.js')));
    assert.strictEqual(
      fs.readFileSync(path.join(directory, 'deleted.js'), 'utf8'),
      'const deleted = true;\n',
    );
    assert.strictEqual(
      files.find(file => file.name === 'a.js')?.content,
      'const value = "after";\n',
    );
    assert.ok(files.some(file => file.name === 'added.js'));
    assert.ok(!files.some(file => file.name === 'deleted.js'));
    assert.strictEqual(
      harness.store.manifest.files['Type/a.js'].baselineHash,
      hashText('const value = "after";\n'),
    );
    assert.ok(harness.store.manifest.files['Type/added.js']);
    assert.ok(!harness.store.manifest.files['Type/deleted.js']);
    assert.strictEqual(recoveries.length, 2);
    const statuses = new Map(
      (await harness.service.refreshLocalChanges()).map(change =>
        [change.path, change.status]),
    );
    assert.strictEqual(statuses.get('Type/a.js'), 'localModified');
    assert.strictEqual(statuses.get('Type/added.js'), 'localDeleted');
    assert.strictEqual(statuses.get('Type/deleted.js'), 'localAdded');
  });

  test('does not overwrite edits made after a recorded push during local rollback', async () => {
    const harness = createHarness(root, baseUrl);
    await harness.service.pull(() => undefined);
    const localPath = path.join(root, 'ecode', 'Type', 'a.js');
    fs.writeFileSync(localPath, 'const pushed = true;\n');
    const candidates = await harness.service.preparePromotionCandidates(['Type/a.js']);
    await harness.service.pushSelected(['Type/a.js'], () => undefined);
    fs.writeFileSync(localPath, 'const editedAfterPush = true;\n');

    await assert.rejects(
      harness.service.rollbackPushLocally(candidates),
      /本地回退预检未通过/,
    );

    assert.strictEqual(
      fs.readFileSync(localPath, 'utf8'),
      'const editedAfterPush = true;\n',
    );
    assert.deepStrictEqual(harness.store.recoveries, []);
  });

  test('honors cancellation before traversing a remote category', async () => {
    const harness = createHarness(root, baseUrl);

    await assert.rejects(
      harness.service.pull(() => undefined, { isCancellationRequested: true }),
      SyncCancelledError,
    );
  });
});

async function collectRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createHarness(
  workspaceFolder: string,
  serverUrl: string,
  localScanner?: LocalWorkspaceScanner,
): {
  service: EcodeSyncService;
  store: MemoryStore;
  authState: { reconnects: number };
  logs: { warnings: string[] };
} {
  const profile: ConnectionProfile = {
    version: 4,
    environmentId: 'test-environment',
    environmentDirectory: 'ecode',
    workspaceFolder,
    serverUrl,
    username: 'test',
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
  const logs = { warnings: [] as string[] };
  const output = {
    info: () => undefined,
    warn: (message: unknown) => logs.warnings.push(String(message)),
    error: () => undefined,
  };
  return {
    service: new EcodeSyncService(
      store as unknown as WorkspaceStore,
      auth,
      output as never,
      undefined,
      localScanner,
    ),
    store,
    authState,
    logs,
  };
}

class MemoryStore {
  manifest: SyncManifest;
  manifestSaves = 0;
  formMetadata: FormMetadataCache;
  failFormMetadataSave = false;
  conflicts = new Map<string, StoredConflict>();
  recoveries: Array<{ path: string; content: string }> = [];
  private snapshots = new Map<string, string>();
  private resourceSnapshots = new Map<string, string>();
  private appMetadata: AppMetadataSnapshot | undefined;

  constructor(private profile: ConnectionProfile) {
    this.manifest = {
      schemaVersion: 1,
      serverFingerprint: '',
      syncRoot: '',
      updatedAt: new Date().toISOString(),
      files: {},
    };
    this.formMetadata = {
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
    this.manifestSaves++;
    manifest.updatedAt = new Date().toISOString();
    this.manifest = manifest;
  }

  async loadAppMetadata(): Promise<AppMetadataSnapshot | undefined> {
    return this.appMetadata;
  }

  async saveRemoteCatalog(
    _tree: unknown,
    apps: AppMetadataSnapshot,
  ): Promise<void> {
    this.appMetadata = apps;
  }

  async loadFormMetadataCache(
    fingerprint: string,
    syncRoot: string,
  ): Promise<FormMetadataCache> {
    this.formMetadata.serverFingerprint = fingerprint;
    this.formMetadata.syncRoot = syncRoot;
    return this.formMetadata;
  }

  async saveFormMetadataCache(cache: FormMetadataCache): Promise<void> {
    if (this.failFormMetadataSave) {
      throw new Error('metadata storage unavailable');
    }
    this.formMetadata = cache;
  }

  async saveSnapshot(_syncRoot: string, content: string): Promise<string> {
    const key = String(this.snapshots.size + 1);
    this.snapshots.set(key, content);
    return key;
  }

  async readSnapshot(_syncRoot: string, key: string): Promise<string> {
    return this.snapshots.get(key) ?? '';
  }

  async saveResourceSnapshot(
    _syncRoot: string,
    sourcePath: string,
    expectedHash?: string,
  ): Promise<string> {
    const result = await hashFileBytes(sourcePath);
    assert.strictEqual(expectedHash ?? result.hash, result.hash);
    const objectDirectory = path.join(this.profile.workspaceFolder, '.test-resource-objects');
    fs.mkdirSync(objectDirectory, { recursive: true });
    const objectPath = path.join(objectDirectory, `${result.hash}.bin`);
    fs.copyFileSync(sourcePath, objectPath);
    this.resourceSnapshots.set(result.hash, objectPath);
    return result.hash;
  }

  async getSnapshotPath(
    _syncRoot: string,
    key: string,
  ): Promise<string> {
    const snapshot = this.resourceSnapshots.get(key);
    if (!snapshot) {
      throw new Error('resource snapshot missing');
    }
    return snapshot;
  }

  async saveConflict(_syncRoot: string, conflict: StoredConflict): Promise<void> {
    this.conflicts.set(conflict.path, conflict);
  }

  async loadConflict(
    _syncRoot: string,
    remotePath: string,
  ): Promise<StoredConflict | undefined> {
    return this.conflicts.get(remotePath);
  }

  async listConflicts(_syncRoot: string): Promise<StoredConflict[]> {
    return [...this.conflicts.values()];
  }

  async deleteConflict(_syncRoot: string, remotePath: string): Promise<void> {
    this.conflicts.delete(remotePath);
  }

  async saveRecovery(
    _syncRoot: string,
    remotePath: string,
    content: string,
  ): Promise<string> {
    this.recoveries.push({ path: remotePath, content });
    return 'recovery.txt';
  }

  async saveResourceRecovery(
    _syncRoot: string,
    remotePath: string,
    sourcePath: string,
  ): Promise<string> {
    const recoveryDirectory = path.join(this.profile.workspaceFolder, '.test-recovery');
    fs.mkdirSync(recoveryDirectory, { recursive: true });
    const recoveryPath = path.join(recoveryDirectory, `${this.recoveries.length}.bin`);
    fs.copyFileSync(sourcePath, recoveryPath);
    this.recoveries.push({ path: remotePath, content: recoveryPath });
    return recoveryPath;
  }
}

class TrackingLocalWorkspaceScanner extends LocalWorkspaceScanner {
  scanCalls = 0;

  override async scan(syncRoot: string) {
    this.scanCalls++;
    return super.scan(syncRoot);
  }
}
