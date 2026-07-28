import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import type { FormMetadataCache } from '../../domain/formMetadata';
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
    metadata?: unknown;
  }>;
  let folders: Array<{ id: string; name: string; parentId: string }>;
  let failedUploads: Set<string>;
  let corruptedUploads: Set<string>;
  let duplicateFolders: boolean;
  let expiredTreeResponses: number;
  let rootTreeRequests: number;
  let folderDeleteRequests: number;
  let requestedFormIds: string[];

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-service-'));
    files = [{ id: 'file-1', name: 'a.js', content: 'const remote = true;\n' }];
    folders = [];
    failedUploads = new Set();
    corruptedUploads = new Set();
    duplicateFolders = false;
    expiredTreeResponses = 0;
    rootTreeRequests = 0;
    folderDeleteRequests = 0;
    requestedFormIds = [];
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
            data: {
              content: file.content,
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
    version: 3,
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
  formMetadata: FormMetadataCache;
  failFormMetadataSave = false;
  conflicts = new Map<string, StoredConflict>();
  recoveries: Array<{ path: string; content: string }> = [];
  private snapshots = new Map<string, string>();

  constructor(private profile: ConnectionProfile) {
    this.manifest = {
      schemaVersion: 1,
      serverFingerprint: '',
      syncRoot: '',
      updatedAt: new Date(0).toISOString(),
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
    this.manifest = manifest;
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

  async saveRecovery(remotePath: string, content: string): Promise<string> {
    this.recoveries.push({ path: remotePath, content });
    return 'recovery.txt';
  }
}
