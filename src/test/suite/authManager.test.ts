import * as assert from 'assert';
import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import type { ConnectionProfile } from '../../domain/types';
import { AuthManager } from '../../sync/auth/AuthManager';

suite('Auth manager', () => {
  let server: http.Server;
  let baseUrl: string;
  let publicKey: string;
  let allowTree: boolean;
  let rotateSessionOnLogin: boolean;
  let treeRequests: number;
  let treeCookie: string | undefined;

  suiteSetup(() => {
    const generated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    publicKey = generated.publicKey.export({
      type: 'spki',
      format: 'der',
    }).toString('base64');
  });

  setup(async () => {
    allowTree = true;
    rotateSessionOnLogin = false;
    treeRequests = 0;
    treeCookie = undefined;
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/') {
        response.setHeader('Set-Cookie', 'ecology_JSessionid=test-session; Path=/');
        response.end('{}');
        return;
      }
      if (request.url === '/rsa/weaver.rsa.GetRsaInfo') {
        response.end(JSON.stringify({
          rsa_pub: publicKey,
          rsa_code: 'test-salt',
          rsa_flag: '|',
        }));
        return;
      }
      if (request.url === '/api/hrm/login/checkLogin' && request.method === 'POST') {
        if (rotateSessionOnLogin) {
          response.setHeader('Set-Cookie', 'ecology_JSessionid=authenticated-session; Path=/');
        }
        response.end(JSON.stringify({ msgcode: '0' }));
        return;
      }
      if (request.url === '/api/ecode/type/tree') {
        treeRequests++;
        treeCookie = request.headers.cookie;
        const hasValidSession = !rotateSessionOnLogin
          || treeCookie === 'ecology_JSessionid=authenticated-session';
        response.end(JSON.stringify(allowTree && hasValidSession
          ? {
              status: true,
              data: {
                typeList: [],
                childFolder: [],
                childFile: [],
              },
            }
          : { status: false }));
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
  });

  test('accepts a login only after the root file tree is readable', async () => {
    const secrets = new MemorySecrets();
    const auth = new AuthManager({ secrets } as never);

    const result = await auth.connect(createProfile(baseUrl), 'test-password');

    assert.strictEqual(result.success, true);
    assert.strictEqual(treeRequests, 1);
    assert.ok((await auth.getAuthenticatedClient(createProfile(baseUrl))));
  });

  test('uses the refreshed session cookie returned after login', async () => {
    rotateSessionOnLogin = true;
    const secrets = new MemorySecrets();
    const auth = new AuthManager({ secrets } as never);

    const result = await auth.connect(createProfile(baseUrl), 'test-password');

    assert.strictEqual(result.success, true);
    assert.strictEqual(treeCookie, 'ecology_JSessionid=authenticated-session');
    assert.strictEqual(treeRequests, 1);
  });

  test('rejects a successful login when the root file tree is unavailable', async () => {
    allowTree = false;
    const secrets = new MemorySecrets();
    const auth = new AuthManager({ secrets } as never);

    const result = await auth.connect(createProfile(baseUrl), 'test-password');

    assert.strictEqual(result.success, false);
    assert.match(result.message, /登录成功，但无法读取远端文件树/);
    assert.match(result.message, /status=false/);
    assert.strictEqual(treeRequests, 1);
    assert.deepStrictEqual(secrets.keys(), []);
  });
});

function createProfile(serverUrl: string): ConnectionProfile {
  return {
    version: 2,
    workspaceFolder: process.cwd(),
    serverUrl,
    username: 'test-user',
    localDirectory: 'ecode',
  };
}

class MemorySecrets {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}
