import * as assert from 'assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface CliProcess {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

interface FileRequest {
  schemaVersion: number;
  id: string;
  action: string;
  environmentDirectory: string;
  createdAt: string;
  expiresAt: string;
  confirmed?: boolean;
  environmentId?: string;
  paths?: string[];
  path?: string;
  enabled?: boolean;
  preStateOrder?: string;
  pushRecordIds?: string[];
  lifecycleRecordIds?: string[];
}

suite('Ecode Agent CLI', () => {
  const cli = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'resources',
    'skills',
    'ecode-local',
    'scripts',
    'ecode-agent.cjs',
  );

  test('provides Chinese help for every extension action', async () => {
    const process_ = startCli(cli, ['--help'], process.cwd());
    const result = await process_.completion;
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /Ecode Local 通用 Agent CLI/);
    for (const action of [
      'getState', 'getLifecycleState', 'refreshChanges', 'listPushRecords',
      'listLifecycleRecords', 'listChangeSets',
      'getKnowledge', 'configure', 'addEnvironment', 'switchEnvironment',
      'deleteEnvironment',
      'pull', 'push', 'setPreload', 'setPreloadOrder', 'setFolderRelease',
      'rollbackPushFile', 'renamePushRecord',
      'deletePushRecord', 'deleteLifecycleRecord', 'revertChange',
      'resolveConflict', 'createChangeSet', 'applyChangeSet',
      'deleteChangeSet',
    ]) {
      assert.match(result.stdout, new RegExp(action));
    }
    for (const removedAction of [
      'openDiff', 'openPromotionDiff', 'searchDocumentation',
      'openOnlineDocumentation', 'refreshAiSupport', 'enableAiSupport',
      'openAiGuide', 'removeAiSupport',
    ]) {
      assert.doesNotMatch(result.stdout, new RegExp(removedAction));
    }
  });

  test('creates and waits for a workspace getState request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-state-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'getState',
      '--workspace', root,
      '--request-id', 'cli_state_001',
      '--timeout', '5',
    ], root);
    try {
      const request = await waitForRequest(root, item => item.id === 'cli_state_001');
      assert.strictEqual(request.schemaVersion, 2);
      assert.strictEqual(request.action, 'getState');
      assert.strictEqual(request.environmentDirectory, 'workspace');
      assert.ok(Date.parse(request.expiresAt) > Date.parse(request.createdAt));
      writeResult(root, request, 'succeeded', {
        activeEnvironment: { directory: 'dev_env' },
      });
      const result = await process_.completion;
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stderr, '');
      assert.strictEqual(JSON.parse(result.stdout).status, 'succeeded');
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('reads the active environment configuration without creating a bootstrap getState request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-push-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'push',
      '--workspace', root,
      '--path', 'Type/a.js',
      '--path', 'Page/b.jsx',
      '--confirmed',
      '--timeout', '5',
    ], root);
    try {
      const pushRequest = await waitForRequest(
        root,
        item => item.action === 'push',
      );
      assert.strictEqual(pushRequest.environmentDirectory, 'dev_env');
      assert.strictEqual(pushRequest.confirmed, true);
      assert.deepStrictEqual(pushRequest.paths, ['Type/a.js', 'Page/b.jsx']);
      assert.strictEqual(
        fs.readdirSync(path.join(root, '.ecode-local', 'agent-cli', 'requests'))
          .filter(name => name.endsWith('.json')).length,
        1,
      );
      writeResult(root, pushRequest, 'cancelled', undefined, '用户取消推送');
      const result = await process_.completion;
      assert.strictEqual(result.code, 4);
      assert.strictEqual(JSON.parse(result.stdout).status, 'cancelled');
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('requires explicit Agent authorization for protected actions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-confirm-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'push',
      '--workspace', root,
      '--path', 'Type/a.js',
    ], root);
    try {
      const result = await process_.completion;
      assert.strictEqual(result.code, 64);
      assert.match(result.stderr, /取得明确授权.*--confirmed/);
      assert.strictEqual(
        fs.existsSync(path.join(root, '.ecode-local', 'agent-cli', 'requests')),
        false,
      );
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('creates a confirmed lifecycle request with a strict boolean value', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-lifecycle-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'setFolderRelease',
      '--workspace', root,
      '--path', 'Project/app',
      '--enabled', 'false',
      '--confirmed',
      '--timeout', '5',
    ], root);
    try {
      const request = await waitForRequest(root, item => item.action === 'setFolderRelease');
      assert.strictEqual(request.environmentDirectory, 'dev_env');
      assert.strictEqual(request.path, 'Project/app');
      assert.strictEqual(request.enabled, false);
      assert.strictEqual(request.confirmed, true);
      writeResult(root, request, 'succeeded', { verified: true });
      const result = await process_.completion;
      assert.strictEqual(result.code, 0);
      assert.strictEqual(JSON.parse(result.stdout).status, 'succeeded');
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('rejects invalid lifecycle booleans before creating a request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-lifecycle-invalid-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'setPreload',
      '--workspace', root,
      '--path', 'Project/app/entry.js',
      '--enabled', 'yes',
      '--confirmed',
    ], root);
    try {
      const result = await process_.completion;
      assert.strictEqual(result.code, 64);
      assert.match(result.stderr, /--enabled 必须是 true 或 false/);
      assert.strictEqual(
        fs.existsSync(path.join(root, '.ecode-local', 'agent-cli', 'requests')),
        false,
      );
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('creates a confirmed preload-order request with a normalized number', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-preload-order-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'setPreloadOrder',
      '--workspace', root,
      '--path', 'Project/app',
      '--order', '5.50',
      '--confirmed',
      '--timeout', '5',
    ], root);
    try {
      const request = await waitForRequest(root, item => item.action === 'setPreloadOrder');
      assert.strictEqual(request.path, 'Project/app');
      assert.strictEqual(request.preStateOrder, '5.5');
      assert.strictEqual(request.confirmed, true);
      writeResult(root, request, 'succeeded', { verified: true });
      const result = await process_.completion;
      assert.strictEqual(result.code, 0);
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('creates a lifecycle-only change set request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-change-set-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'createChangeSet',
      '--workspace', root,
      '--lifecycle-record-id', 'LIFECYCLE-first',
      '--lifecycle-record-id', 'LIFECYCLE-second',
      '--name', '生命周期发布',
      '--timeout', '5',
    ], root);
    try {
      const request = await waitForRequest(root, item => item.action === 'createChangeSet');
      assert.deepStrictEqual(request.pushRecordIds, []);
      assert.deepStrictEqual(request.lifecycleRecordIds, [
        'LIFECYCLE-first',
        'LIFECYCLE-second',
      ]);
      writeResult(root, request, 'succeeded', { id: 'CS-lifecycle' });
      assert.strictEqual((await process_.completion).code, 0);
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('reports timeout as unknown and can wait for the original request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-wait-'));
    initializeConfiguredWorkspace(root);
    const first = startCli(cli, [
      'getState',
      '--workspace', root,
      '--request-id', 'cli_wait_001',
      '--timeout', '0.2',
    ], root);
    try {
      const request = await waitForRequest(root, item => item.id === 'cli_wait_001');
      const timeout = await first.completion;
      assert.strictEqual(timeout.code, 124);
      assert.strictEqual(JSON.parse(timeout.stdout).status, 'unknown');
      assert.match(timeout.stderr, /不要创建新请求/);

      writeResult(root, request, 'succeeded', { activeEnvironment: undefined });
      const second = startCli(cli, [
        'wait',
        '--workspace', root,
        '--request-id', request.id,
        '--timeout', '2',
      ], root);
      const resumed = await second.completion;
      assert.strictEqual(resumed.code, 0);
      assert.strictEqual(JSON.parse(resumed.stdout).id, request.id);
    } finally {
      first.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('returns pending for an interactive request and waits for its final result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-interactive-'));
    initializeConfiguredWorkspace(root);
    const process_ = startCli(cli, [
      'configure',
      '--workspace', root,
      '--request-id', 'cli_configure_001',
      '--timeout', '0.2',
    ], root);
    try {
      const request = await waitForRequest(root, item => item.id === 'cli_configure_001');
      assert.ok(Date.parse(request.expiresAt) - Date.parse(request.createdAt) >= 3_500_000);
      const submitted = await process_.completion;
      const result = JSON.parse(submitted.stdout) as {
        status: string;
        data?: { interactive?: boolean; waitCommand?: string };
      };
      assert.strictEqual(submitted.code, 0);
      assert.strictEqual(result.status, 'pending');
      assert.strictEqual(result.data?.interactive, true);
      assert.match(result.data?.waitCommand ?? '', /wait --request-id cli_configure_001/);
      assert.strictEqual(submitted.stderr, '');

      writeResult(root, request, 'cancelled', undefined, '用户取消配置');
      const wait = startCli(cli, [
        'wait',
        '--workspace', root,
        '--request-id', request.id,
        '--timeout', '2',
      ], root);
      const completed = await wait.completion;
      assert.strictEqual(completed.code, 4);
      assert.strictEqual(JSON.parse(completed.stdout).status, 'cancelled');
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });

  test('refuses an unconfigured workspace without creating .ecode-local', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cli-unconfigured-'));
    const process_ = startCli(cli, ['getState', '--workspace', root], root);
    try {
      const result = await process_.completion;
      assert.strictEqual(result.code, 69);
      assert.match(result.stderr, /先在 VS Code 的 Ecode 侧边栏完成首次配置/);
      assert.strictEqual(fs.existsSync(path.join(root, '.ecode-local')), false);
    } finally {
      process_.child.kill();
      await removeTestDirectory(root);
    }
  });
});

function startCli(cli: string, arguments_: string[], cwd: string): CliProcess {
  const child = spawn(process.execPath, [cli, ...arguments_], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    },
  );
  return { child, completion };
}

async function waitForRequest(
  root: string,
  predicate: (request: FileRequest) => boolean,
): Promise<FileRequest> {
  const requestRoot = path.join(root, '.ecode-local', 'agent-cli', 'requests');
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      for (const name of fs.readdirSync(requestRoot)) {
        if (!name.endsWith('.json')) {
          continue;
        }
        const request = JSON.parse(fs.readFileSync(
          path.join(requestRoot, name),
          'utf8',
        )) as FileRequest;
        if (predicate(request)) {
          return request;
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('CLI request was not created in time');
}

function writeResult(
  root: string,
  request: FileRequest,
  status: string,
  data?: unknown,
  message?: string,
): void {
  const resultRoot = path.join(root, '.ecode-local', 'agent-cli', 'results');
  fs.mkdirSync(resultRoot, { recursive: true });
  fs.writeFileSync(path.join(resultRoot, `${request.id}.json`), JSON.stringify({
    schemaVersion: 2,
    id: request.id,
    action: request.action,
    environmentDirectory: request.environmentDirectory,
    processedAt: new Date().toISOString(),
    status,
    data,
    message,
  }), 'utf8');
}

function initializeConfiguredWorkspace(root: string): void {
  const localRoot = path.join(root, '.ecode-local');
  fs.mkdirSync(localRoot, { recursive: true });
  fs.writeFileSync(path.join(localRoot, 'environments.json'), JSON.stringify({
    schemaVersion: 2,
    activeEnvironmentId: 'env_test',
    environments: [{
      version: 2,
      id: 'env_test',
      name: '测试环境',
      directory: 'dev_env',
      serverUrl: 'http://localhost:8099',
      username: 'tester',
    }],
  }), 'utf8');
}

async function removeTestDirectory(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '') || attempt === 9) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
