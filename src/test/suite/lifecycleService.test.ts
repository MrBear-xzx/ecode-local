import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { type AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { ConnectionProfile } from '../../domain/types';
import { WorkspaceStore } from '../../storage/WorkspaceStore';
import { EcodeApiClient } from '../../sync/api/EcodeApiClient';
import type { AuthManager } from '../../sync/auth/AuthManager';
import { EcodeLifecycleService } from '../../sync/EcodeLifecycleService';

suite('Ecode lifecycle service', () => {
  let server: http.Server;
  let baseUrl: string;
  let preloadState: string;
  let preStateOrder: string;
  let released: boolean;
  let releaseListSupported: boolean;
  let releaseResponseFails: boolean;
  let treeReportsReleased: boolean;
  let releaseListUsesAppId: boolean;
  let delayedInitialReads: boolean;
  let parallelFolderCount: number;
  let activeInitialReads: number;
  let maxActiveInitialReads: number;
  let activeFolderReads: number;
  let maxActiveFolderReads: number;
  let unsafeTreeNames: boolean;
  const posted: Array<{ path: string; form: URLSearchParams }> = [];

  setup(async () => {
    preloadState = 'pre-state';
    preStateOrder = '10000';
    released = true;
    releaseListSupported = true;
    releaseResponseFails = false;
    treeReportsReleased = false;
    releaseListUsesAppId = false;
    delayedInitialReads = false;
    parallelFolderCount = 0;
    activeInitialReads = 0;
    maxActiveInitialReads = 0;
    activeFolderReads = 0;
    maxActiveFolderReads = 0;
    unsafeTreeNames = false;
    posted.length = 0;
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://localhost');
      const sendDelayed = (
        value: unknown,
        group: 'initial' | 'folder',
      ): void => {
        if (group === 'initial') {
          activeInitialReads++;
          maxActiveInitialReads = Math.max(maxActiveInitialReads, activeInitialReads);
        } else {
          activeFolderReads++;
          maxActiveFolderReads = Math.max(maxActiveFolderReads, activeFolderReads);
        }
        setTimeout(() => {
          if (group === 'initial') {
            activeInitialReads--;
          } else {
            activeFolderReads--;
          }
          response.end(JSON.stringify(value));
        }, 40);
      };
      if (request.method === 'GET' && url.pathname === '/api/cloudstore/ecode/sysInfo') {
        const value = { status: true, data: { version: '1.5.0' } };
        if (delayedInitialReads) {
          sendDelayed(value, 'initial');
        } else {
          response.end(JSON.stringify(value));
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/cloudstore/ecode/releaseList') {
        if (!releaseListSupported) {
          response.end(JSON.stringify({ status: false, code: 404, msg: 'not supported' }));
          return;
        }
        const value = {
          status: true,
          data: released ? [{
            folderId: releaseListUsesAppId ? 'folder-app-1' : 'folder-root',
          }] : [],
        };
        if (delayedInitialReads) {
          sendDelayed(value, 'initial');
        } else {
          response.end(JSON.stringify(value));
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/ecode/type/tree') {
        if (url.searchParams.get('typeId') === 'type-1') {
          response.end(JSON.stringify({
            status: true,
            childFolder: parallelFolderCount > 0
              ? Array.from({ length: parallelFolderCount }, (_, index) => ({
                  id: `parallel-${index}`,
                  name: `parallel-${index}`,
                  attribute: 'folder',
                }))
              : [{
                  id: 'folder-root',
                  name: 'app',
                  attribute: 'folder',
                  appId: 'folder-app-1',
                  isRootFolder: true,
                  isReleased: treeReportsReleased ? true : undefined,
                  preStateOrder,
                }, ...(unsafeTreeNames ? [{
                  id: 'unsafe-folder',
                  name: '../outside',
                  attribute: 'folder',
                }] : [])],
            childFile: [{
              id: 'file-js',
              name: 'entry.js',
              attribute: 'file',
              fileExtension: 'js',
              state: preloadState,
            }, ...(unsafeTreeNames ? [{
              id: 'unsafe-file',
              name: '../secret.js',
              attribute: 'file',
              fileExtension: 'js',
            }] : [])],
            typeList: [],
          }));
          return;
        }
        const folderId = url.searchParams.get('folderId');
        if (folderId?.startsWith('parallel-')) {
          sendDelayed({
            status: true,
            childFolder: [],
            childFile: [],
            typeList: [],
          }, 'folder');
          return;
        }
        if (url.searchParams.get('folderId') === 'folder-root') {
          response.end(JSON.stringify({
            status: true,
            childFolder: [{ id: 'folder-nested', name: 'nested', attribute: 'folder' }],
            childFile: [
              { id: 'file-css', name: 'style.css', attribute: 'file', type: 'css' },
              { id: 'file-json', name: 'data.json', attribute: 'file', type: 'json' },
            ],
            typeList: [],
          }));
          return;
        }
        if (url.searchParams.get('folderId') === 'folder-nested') {
          response.end(JSON.stringify({
            status: true,
            childFolder: [],
            childFile: [],
            typeList: [],
          }));
          return;
        }
        const value = {
          status: true,
          typeList: [{
            id: 'type-1',
            name: 'Project',
            attribute: 'type',
            appId: 'app-1',
          }, ...(unsafeTreeNames ? [{
            id: 'unsafe-type',
            name: '../Unsafe',
            attribute: 'type',
          }] : [])],
          childFolder: [],
          childFile: [],
        };
        if (delayedInitialReads) {
          sendDelayed(value, 'initial');
        } else {
          response.end(JSON.stringify(value));
        }
        return;
      }
      if (request.method === 'POST') {
        void collectForm(request).then(form => {
          posted.push({ path: url.pathname, form });
          if (url.pathname === '/api/cloudstore/ecode/markFile') {
            preloadState = form.get('type') === 'pre-state' ? 'pre-state' : 'normal';
          }
          if (url.pathname === '/api/ecode/type/setPreStateOrder') {
            preStateOrder = form.get('preStateOrder') ?? preStateOrder;
          }
          if (url.pathname === '/api/cloudstore/ecode/release') {
            released = true;
          }
          if (url.pathname === '/api/cloudstore/ecode/deleteReleaseFile') {
            released = false;
          }
          const releaseRequest = [
            '/api/cloudstore/ecode/release',
            '/api/cloudstore/ecode/deleteReleaseFile',
          ].includes(url.pathname);
          response.end(JSON.stringify(
            releaseRequest && releaseResponseFails
              ? { status: false, msg: '请求超时 (30000ms)' }
              : { status: true },
          ));
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ status: false }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  teardown(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  });

  test('lists lifecycle targets with safe eligibility and verified status', async () => {
    const service = createService(baseUrl);

    const snapshot = await service.getSnapshot();

    assert.strictEqual(snapshot.systemInfo?.version, '1.5.0');
    assert.deepStrictEqual(snapshot.capabilities, { systemInfo: true, releaseList: true });
    assert.deepStrictEqual(snapshot.categories.map(item => item.path), ['Project']);
    assert.strictEqual(snapshot.files.find(item => item.id === 'file-js')?.preloadState, 'preloaded');
    assert.strictEqual(snapshot.files.find(item => item.id === 'file-js')?.fileType, 'js');
    assert.strictEqual(snapshot.files.find(item => item.id === 'file-js')?.canPreload, true);
    assert.strictEqual(snapshot.files.find(item => item.id === 'file-css')?.canPreload, true);
    assert.strictEqual(snapshot.files.find(item => item.id === 'file-css')?.preloadState, 'normal');
    assert.strictEqual(snapshot.files.find(item => item.id === 'file-json')?.canPreload, false);
    assert.strictEqual(snapshot.folders.find(item => item.id === 'folder-root')?.rootFolder, true);
    assert.strictEqual(snapshot.folders.find(item => item.id === 'folder-root')?.appId, 'folder-app-1');
    assert.strictEqual(snapshot.folders.find(item => item.id === 'folder-root')?.released, true);
    assert.strictEqual(
      snapshot.folders.find(item => item.id === 'folder-root')?.preStateOrder,
      '10000',
    );
    assert.strictEqual(snapshot.folders.find(item => item.id === 'folder-nested')?.rootFolder, false);
  });

  test('isolates unsafe remote lifecycle names before mapping local resources', async () => {
    unsafeTreeNames = true;
    const messages: string[] = [];
    const service = createService(baseUrl, {
      info: message => messages.push(message),
      warn: message => messages.push(message),
    });

    const snapshot = await service.getSnapshot();

    assert.ok(snapshot.categories.every(item => item.id !== 'unsafe-type'));
    assert.ok(snapshot.folders.every(item => item.id !== 'unsafe-folder'));
    assert.ok(snapshot.files.every(item => item.id !== 'unsafe-file'));
    assert.ok(messages.some(message => message.includes('无法安全映射到本地')));
  });

  test('reads initial endpoints in parallel and limits tree traversal to four requests', async () => {
    delayedInitialReads = true;
    parallelFolderCount = 8;
    const messages: string[] = [];
    const service = createService(baseUrl, {
      info: message => messages.push(message),
      warn: message => messages.push(message),
    });

    const snapshot = await service.getSnapshot();

    assert.strictEqual(maxActiveInitialReads, 3);
    assert.strictEqual(maxActiveFolderReads, 4);
    assert.strictEqual(snapshot.folders.length, 8);
    assert.ok(messages.some(message => message.includes('10 requests')));
  });

  test('persists and restores a connection-scoped lifecycle snapshot cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-lifecycle-cache-'));
    const workspaceFolder = path.join(root, 'workspace');
    fs.mkdirSync(workspaceFolder);
    const store = new WorkspaceStore(workspaceFolder);
    const environment = await store.saveEnvironment({
      name: '缓存环境',
      directory: 'cached',
      workspaceFolder,
      serverUrl: baseUrl,
      username: 'tester',
    });
    const client = new EcodeApiClient(baseUrl);
    const auth = {
      getAuthenticatedClient: async () => client,
      reconnect: async () => client,
    } as unknown as AuthManager;
    const service = new EcodeLifecycleService(store, auth);
    try {
      const live = await service.getSnapshot();
      const cached = await service.getCachedSnapshot();

      assert.deepStrictEqual(
        cached?.snapshot,
        JSON.parse(JSON.stringify(live)) as unknown,
      );
      assert.ok(Number.isFinite(Date.parse(cached?.updatedAt ?? '')));

      await store.saveEnvironment({
        ...environment,
        serverUrl: `${baseUrl}/different`,
      });
      assert.strictEqual(await service.getCachedSnapshot(), undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('re-reads preload and release state after mutations', async () => {
    const service = createService(baseUrl);

    const preloadResult = await service.setFilePreloaded('file-js', false);
    const orderResult = await service.setPreStateOrderByPath('Project/app', '5.50');
    const unpublishResult = await service.unpublishFolder('folder-root');
    const publishResult = await service.publishFolder('folder-root');

    assert.strictEqual(preloadResult.verified, true);
    assert.deepStrictEqual(orderResult, {
      path: 'Project/app',
      preStateOrder: '5.5',
      verified: true,
    });
    assert.strictEqual(unpublishResult.verified, true);
    assert.strictEqual(publishResult.verified, true);
    assert.strictEqual(preStateOrder, '5.5');
  });

  test('resolves lifecycle writes by exact safe paths and returns verification', async () => {
    const service = createService(baseUrl);

    const preloadResult = await service.setFilePreloadedByPath(
      'project/entry.js',
      false,
    );
    const releaseResult = await service.setFolderReleasedByPath('Project/app', false);
    const orderResult = await service.setPreStateOrderByPath('Project/app', '3');

    assert.deepStrictEqual(preloadResult, {
      path: 'Project/entry.js',
      enabled: false,
      verified: true,
    });
    assert.deepStrictEqual(releaseResult, {
      path: 'Project/app',
      enabled: false,
      verified: true,
    });
    assert.deepStrictEqual(orderResult, {
      path: 'Project/app',
      preStateOrder: '3',
      verified: true,
    });
  });

  test('rejects missing and ineligible lifecycle path targets', async () => {
    const service = createService(baseUrl);

    await assert.rejects(
      service.setFilePreloadedByPath('Project/app/data.json', true),
      /不支持前置加载/,
    );
    await assert.rejects(
      service.setFolderReleasedByPath('Project/app/nested', true),
      /仅支持发布分类下的根文件夹/,
    );
    preloadState = 'post-state';
    await assert.rejects(
      service.setFilePreloadedByPath('Project/entry.js', true),
      /不能直接切换/,
    );
    preloadState = 'unexpected-state';
    await assert.rejects(
      service.setFilePreloadedByPath('Project/entry.js', true),
      /不能直接切换/,
    );
  });

  test('keeps release state unknown when the release-list capability is unavailable', async () => {
    releaseListSupported = false;
    const service = createService(baseUrl);

    const snapshot = await service.getSnapshot();
    const result = await service.publishFolder('folder-root');

    assert.strictEqual(snapshot.capabilities.releaseList, false);
    assert.strictEqual(
      snapshot.folders.find(item => item.id === 'folder-root')?.released,
      undefined,
    );
    assert.strictEqual(result.verified, undefined);
  });

  test('preserves an explicit tree release state missing from a partial release list', async () => {
    released = false;
    treeReportsReleased = true;

    const snapshot = await createService(baseUrl).getSnapshot();

    assert.strictEqual(snapshot.capabilities.releaseList, true);
    assert.strictEqual(
      snapshot.folders.find(item => item.id === 'folder-root')?.released,
      true,
    );
  });

  test('matches release-list appid values to the folder tree appId', async () => {
    releaseListUsesAppId = true;
    const service = createService(baseUrl);

    const snapshot = await service.getSnapshot();
    const unpublishResult = await service.unpublishFolder(
      'folder-root',
      'folder-app-1',
    );

    assert.strictEqual(
      snapshot.folders.find(item => item.id === 'folder-root')?.released,
      true,
    );
    assert.strictEqual(unpublishResult.verified, true);
  });

  test('reconciles timed-out release writes from the readable release list', async () => {
    releaseResponseFails = true;
    const service = createService(baseUrl);

    const unpublishResult = await service.unpublishFolder('folder-root');
    const publishResult = await service.publishFolder('folder-root');

    assert.strictEqual(unpublishResult.verified, true);
    assert.strictEqual(publishResult.verified, true);
  });
});

function createService(
  serverUrl: string,
  logger?: { info(message: string): void; warn(message: string): void },
): EcodeLifecycleService {
  const profile: ConnectionProfile = {
    version: 4,
    environmentId: 'test',
    environmentDirectory: 'ecode',
    workspaceFolder: 'D:\\workspace\\test',
    serverUrl,
    username: 'tester',
  };
  const client = new EcodeApiClient(serverUrl);
  const store = {
    getProfile: async () => profile,
  } as unknown as WorkspaceStore;
  const auth = {
    getAuthenticatedClient: async () => client,
    reconnect: async () => client,
  } as unknown as AuthManager;
  return new EcodeLifecycleService(store, auth, logger);
}

async function collectForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
