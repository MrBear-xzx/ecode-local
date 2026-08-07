import * as assert from 'assert';
import * as http from 'http';
import { type AddressInfo } from 'net';
import { EcodeApiClient } from '../../sync/api/EcodeApiClient';
import { LifecycleApi } from '../../sync/api/LifecycleApi';

suite('Lifecycle API', () => {
  let server: http.Server;
  let baseUrl: string;
  const posted = new Map<string, URLSearchParams>();
  const releasePages: number[] = [];

  setup(async () => {
    posted.clear();
    releasePages.length = 0;
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/cloudstore/ecode/sysInfo') {
        response.end(JSON.stringify({
          status: true,
          data: { ecodeVersion: '1.5.0', buildNumber: 42 },
        }));
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith(
        '/api/cloudstore/ecode/releaseList',
      )) {
        const url = new URL(request.url, 'http://localhost');
        const pageNum = Number(url.searchParams.get('pageNum'));
        releasePages.push(pageNum);
        response.end(JSON.stringify({
          status: true,
          count: 2,
          datas: pageNum === 1
            ? [{ folderId: 7, folderName: 'app', releasePath: '/app' }]
            : [{ appid: 8, folderName: 'other', releasePath: '/other' }],
        }));
        return;
      }
      if (request.method === 'POST') {
        void collectForm(request).then(form => {
          posted.set(request.url ?? '', form);
          response.end(JSON.stringify({ status: true }));
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

  test('normalizes system information and release records', async () => {
    const api = new LifecycleApi(new EcodeApiClient(baseUrl));

    const system = await api.getSystemInfo();
    const releases = await api.listReleases();

    assert.strictEqual(system.status, true);
    assert.strictEqual(system.data?.version, '1.5.0');
    assert.strictEqual(system.data?.build, '42');
    assert.deepStrictEqual(releases.data, [{
      folderId: '7',
      name: 'app',
      path: '/app',
    }, {
      folderId: '8',
      name: 'other',
      path: '/other',
    }]);
    assert.deepStrictEqual(releasePages, [1, 2]);
  });

  test('uses the verified Ecode lifecycle request contracts', async () => {
    const api = new LifecycleApi(new EcodeApiClient(baseUrl));

    await api.markFile('file-1', 'pre-state');
    assert.deepStrictEqual(formValues(posted, '/api/cloudstore/ecode/markFile'), {
      id: 'file-1',
      type: 'pre-state',
    });
    await api.markFile('file-2', '');
    await api.setPreStateOrder('folder-1', '5.5');
    await api.publishFolder('folder-1');
    await api.unpublishFolder('folder-2');

    assert.deepStrictEqual(formValues(posted, '/api/cloudstore/ecode/markFile'), {
      id: 'file-2',
      type: '',
    });
    assert.deepStrictEqual(formValues(posted, '/api/ecode/type/setPreStateOrder'), {
      appId: 'folder-1',
      preStateOrder: '5.5',
    });
    assert.deepStrictEqual(formValues(posted, '/api/cloudstore/ecode/release'), {
      path: '',
      folderId: 'folder-1',
    });
    assert.deepStrictEqual(formValues(posted, '/api/cloudstore/ecode/deleteReleaseFile'), {
      folderIds: 'folder-2',
    });
  });
});

async function collectForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function formValues(
  posted: Map<string, URLSearchParams>,
  requestPath: string,
): Record<string, string> {
  return Object.fromEntries(posted.get(requestPath)?.entries() ?? []);
}
