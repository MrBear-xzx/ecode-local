import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { type AddressInfo } from 'net';
import { EcodeApiClient } from '../../sync/api/EcodeApiClient';
import { FileApi } from '../../sync/api/FileApi';

suite('File API', () => {
  let server: http.Server;
  let baseUrl: string;
  const posted = new Map<string, URLSearchParams>();
  let root: string;
  let multipartBody: Buffer = Buffer.alloc(0);

  setup(async () => {
    posted.clear();
    multipartBody = Buffer.alloc(0);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ecode-file-api-test-'));
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/resource/raw.bin') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(Buffer.from([0, 255, 1, 2, 128]));
      } else if (
        request.method === 'POST'
        && request.url?.startsWith('/api/ecode/resource/upload')
      ) {
        void collectBody(request).then(body => {
          multipartBody = body;
          response.end(JSON.stringify({ status: true }));
        });
      } else if (
        request.method === 'POST'
        && request.url === '/api/ecode/resource/remove'
      ) {
        respondWithForm(request, response, form => {
          posted.set(request.url ?? '', form);
          response.end(JSON.stringify({ status: true }));
        });
      } else if (request.url?.startsWith('/api/ecode/type/tree')) {
        response.end(JSON.stringify({
          status: true,
          typeList: [{
            id: 1,
            name: 'Type',
            attribute: 'type',
            hasChild: 'true',
            appId: 9,
          }],
          childFolder: [{
            id: 2,
            name: 'app',
            attribute: 'folder',
            isRootFolder: '1',
            releaseStatus: 'released',
            preStateOrder: 10000,
          }],
          childFile: [{
            id: 3,
            name: 'app.js',
            attribute: 'file',
            fileExtension: 'js',
            state: 'pre-state',
          }],
          resources: [{
            id: 4,
            name: 'logo.png',
            attribute: 'resource',
            route: '/resource/raw.bin',
          }],
        }));
      } else if (request.url?.startsWith('/api/cloudstore/ecode/one')) {
        const id = new URL(request.url, 'http://localhost').searchParams.get('id');
        response.end(JSON.stringify({
          api_status: true,
          status: true,
          data: {
            content: 'const value = 1;\n',
            ...(id === 'metadata-file'
              ? {
                  metadata: {
                    modeId: 8,
                    formId: 9,
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
                  },
                }
              : {}),
          },
        }));
      } else if (request.url === '/redirect') {
        response.statusCode = 302;
        response.setHeader('Location', '/login');
        response.end();
      } else if (request.url === '/slow') {
        setTimeout(() => response.end(JSON.stringify({ status: true })), 100);
      } else if (request.url === '/resource/stalled.bin') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.flushHeaders();
        response.write(Buffer.from([1]));
        setTimeout(() => response.end(Buffer.from([2])), 200);
      } else if (request.url === '/expired') {
        response.end(JSON.stringify({
          status: false,
          errorCode: '002',
          errorMsg: '登录信息超时',
        }));
      } else if (
        request.method === 'POST'
        && request.url === '/api/workflow/formSetting/fieldSet/getFieldList'
      ) {
        respondWithForm(request, response, form => {
          posted.set(request.url ?? '', form);
          response.end(JSON.stringify({
            status: true,
            data: { sessionkey: 'field-session' },
          }));
        });
      } else if (
        request.method === 'POST'
        && request.url === '/api/ec/dev/table/datas'
      ) {
        respondWithForm(request, response, form => {
          posted.set(request.url ?? '', form);
          response.end(JSON.stringify({
            status: true,
            data: {
              datas: [
                {
                  id: 110,
                  fieldName: 'sqr',
                  fieldlabel: '-86043',
                  fieldlabelspan: '<a href="javascript:void(0)">申请人</a>',
                  fieldhtmltype: 3,
                  viewtype: 0,
                  viewtypespan: '主表',
                  groupname: '主表',
                },
                {
                  id: '220',
                  fieldName: 'mdd',
                  fieldlabel: '-89192',
                  fieldlabelspan: '<a href="javascript:void(0)">目的地</a>',
                  fieldhtmltype: '1',
                  viewtype: '1',
                  groupid: '1',
                  viewtypespan: '明细表1',
                  groupname: '明细表1',
                },
              ],
            },
          }));
        });
      } else if (request.method === 'POST' && request.url?.startsWith('/api/cloudstore/ecode/')) {
        respondWithForm(request, response, form => {
          posted.set(request.url ?? '', form);
          if (request.url === '/api/cloudstore/ecode/rejected') {
            response.end(JSON.stringify({ api_status: false, code: '214', msg: 'rejected' }));
          } else {
            response.end(JSON.stringify({ api_status: true, status: true }));
          }
        });
      } else {
        response.statusCode = 500;
        response.end(JSON.stringify({ status: false, msg: 'request rejected' }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  teardown(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()),
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  test('unwraps top-level tree and file-content response shapes', async () => {
    const api = new FileApi(new EcodeApiClient(baseUrl));
    const tree = await api.listTree();
    const content = await api.viewFile('file-1');

    assert.strictEqual(tree.status, true);
    assert.strictEqual(tree.data?.typeList[0].id, '1');
    assert.strictEqual(tree.data?.typeList[0].hasChild, true);
    assert.strictEqual(tree.data?.typeList[0].appId, '9');
    assert.strictEqual(tree.data?.childFolder[0].isRootFolder, true);
    assert.strictEqual(tree.data?.childFolder[0].released, true);
    assert.strictEqual(tree.data?.childFolder[0].preStateOrder, '10000');
    assert.strictEqual(tree.data?.childFile[0].fileType, 'js');
    assert.strictEqual(tree.data?.childFile[0].preloadState, 'pre-state');
    assert.strictEqual(tree.data?.resources[0].route, '/resource/raw.bin');
    assert.strictEqual(content.status, true);
    assert.strictEqual(content.data, 'const value = 1;\n');
  });

  test('retains normalized form metadata from a file-detail response', async () => {
    const detail = await new FileApi(new EcodeApiClient(baseUrl))
      .viewFileDetail('metadata-file');

    assert.strictEqual(detail.status, true);
    assert.strictEqual(detail.data?.content, 'const value = 1;\n');
    assert.strictEqual(detail.data?.formMetadataState, 'present');
    assert.strictEqual(detail.data?.formContexts[0].kind, 'mode');
    assert.strictEqual(
      detail.data?.formContexts[0].tables[0].fields[0].name,
      'applicant',
    );
  });

  test('loads workflow fields through the verified two-stage field-list API', async () => {
    const context = await new FileApi(new EcodeApiClient(baseUrl))
      .loadWorkflowFormContext('-133');

    assert.strictEqual(context.status, true);
    assert.strictEqual(context.data?.kind, 'workflow');
    assert.strictEqual(context.data?.formId, '-133');
    assert.strictEqual(context.data?.tables[0].mark, 'main');
    assert.strictEqual(context.data?.tables[0].fields[0].name, 'sqr');
    assert.strictEqual(context.data?.tables[1].mark, 'detail_1');
    assert.strictEqual(context.data?.tables[1].fields[0].label, '目的地');
    assert.strictEqual(
      posted.get('/api/workflow/formSetting/fieldSet/getFieldList')?.get('formId'),
      '-133',
    );
    assert.strictEqual(
      posted.get('/api/ec/dev/table/datas')?.get('dataKey'),
      'field-session',
    );
  });

  test('preserves an HTTP failure as a failed API response', async () => {
    const result = await new EcodeApiClient(baseUrl).get('/unknown');

    assert.strictEqual(result.status, false);
    assert.strictEqual(result.code, 500);
  });

  test('reports a login redirect as an expired session', async () => {
    const result = await new EcodeApiClient(baseUrl).get('/redirect');

    assert.strictEqual(result.status, false);
    assert.strictEqual(result.code, 401);
  });

  test('returns a structured timeout failure', async () => {
    const result = await new EcodeApiClient(baseUrl, 10).get('/slow');

    assert.strictEqual(result.status, false);
    assert.strictEqual(result.code, -1);
    assert.match(result.msg ?? '', /超时/);
  });

  test('normalizes the Ecode session-expired response', async () => {
    const result = await new EcodeApiClient(baseUrl).get('/expired');

    assert.strictEqual(result.status, false);
    assert.strictEqual(result.code, '002');
    assert.strictEqual(result.msg, '登录信息超时');
  });

  test('treats api_status false as an explicit API failure', async () => {
    const result = await new EcodeApiClient(baseUrl).postForm(
      '/api/cloudstore/ecode/rejected',
      { id: 'file-1' },
    );

    assert.strictEqual(result.status, false);
    assert.strictEqual(result.code, '214');
    assert.strictEqual(result.msg, 'rejected');
  });

  test('posts Base64 source content using the Ecode update protocol', async () => {
    const api = new FileApi(new EcodeApiClient(baseUrl));
    const content = 'const upload = true;\n';
    const compiledContent = 'var upload = true;\n';
    const result = await api.updateFile('file-1', content, compiledContent);
    const form = posted.get('/api/cloudstore/ecode/updateFile');

    assert.strictEqual(result.status, true);
    assert.strictEqual(form?.get('id'), 'file-1');
    assert.strictEqual(Buffer.from(form?.get('content') ?? '', 'base64').toString('utf8'), content);
    assert.strictEqual(
      Buffer.from(form?.get('compiledContent') ?? '', 'base64').toString('utf8'),
      compiledContent,
    );
  });

  test('creates an empty file before its content is saved through updateFile', async () => {
    const api = new FileApi(new EcodeApiClient(baseUrl));
    await api.addFolder('nested', { typeId: 'type-1' });
    await api.addFile('folder-1', 'hello', 'js');

    const folder = posted.get('/api/cloudstore/ecode/addFolder');
    const file = posted.get('/api/cloudstore/ecode/addFile');
    assert.strictEqual(folder?.get('typeId'), 'type-1');
    assert.strictEqual(folder?.get('parentId'), '');
    assert.strictEqual(file?.get('folderId'), 'folder-1');
    assert.strictEqual(file?.get('name'), 'hello');
    assert.strictEqual(file?.get('type'), 'js');
    assert.strictEqual(file?.get('content'), '');
    assert.strictEqual(file?.get('compiledContent'), '');
  });

  test('deletes a file using the Ecode file identifier', async () => {
    const api = new FileApi(new EcodeApiClient(baseUrl));

    const result = await api.deleteFile('file-1');
    const form = posted.get('/api/cloudstore/ecode/logicalDeleteFile');

    assert.strictEqual(result.status, true);
    assert.strictEqual(form?.get('id'), 'file-1');
  });

  test('deletes a folder using the Ecode folder identifier', async () => {
    const api = new FileApi(new EcodeApiClient(baseUrl));

    const result = await api.deleteFolder('folder-1');
    const form = posted.get('/api/cloudstore/ecode/logicalDeleteFolder');

    assert.strictEqual(result.status, true);
    assert.strictEqual(form?.get('folderId'), 'folder-1');
  });

  test('downloads a resource as original bytes and rejects cross-origin routes', async () => {
    const client = new EcodeApiClient(baseUrl);
    const api = new FileApi(client);
    const target = path.join(root, 'raw.bin');

    const result = await api.downloadResource('/resource/raw.bin', target);

    assert.strictEqual(result.status, true);
    assert.deepStrictEqual(await fs.readFile(target), Buffer.from([0, 255, 1, 2, 128]));
    assert.strictEqual(result.data?.size, 5);
    await assert.rejects(
      client.getRaw('https://example.com/resource.bin'),
      /不同源/,
    );
  });

  test('times out when a resource response body stops transferring', async () => {
    const target = path.join(root, 'stalled.bin');
    const api = new FileApi(new EcodeApiClient(baseUrl, 25));

    const result = await api.downloadResource('/resource/stalled.bin', target);

    assert.strictEqual(result.status, false);
    assert.match(result.msg ?? '', /超时/);
    await assert.rejects(fs.stat(target), /ENOENT/);
  });

  test('uploads a streamed multipart resource with its remote name and deletes by id', async () => {
    const source = path.join(root, 'object.bin');
    const bytes = Buffer.from([0, 10, 13, 255, 128]);
    await fs.writeFile(source, bytes);
    const api = new FileApi(new EcodeApiClient(baseUrl));

    const uploaded = await api.uploadResource(source, 'folder-1', 'logo.png');
    const deleted = await api.deleteResource('resource-1');

    assert.strictEqual(uploaded.status, true);
    assert.match(multipartBody.toString('latin1'), /filename="logo\.png"/);
    assert.ok(multipartBody.includes(bytes));
    assert.strictEqual(deleted.status, true);
    assert.strictEqual(
      posted.get('/api/ecode/resource/remove')?.get('resourceId'),
      'resource-1',
    );
  });
});

async function collectBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function collectForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await collectBody(request)).toString('utf8'));
}

function respondWithForm(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  respond: (form: URLSearchParams) => void,
): void {
  void collectForm(request).then(respond, error => {
    response.statusCode = 500;
    response.end(JSON.stringify({ status: false, msg: String(error) }));
  });
}
