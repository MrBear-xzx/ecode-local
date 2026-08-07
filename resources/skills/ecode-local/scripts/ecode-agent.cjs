#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 200;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const INTERACTIVE_REQUEST_TTL_MS = 60 * 60 * 1000;
const INTERACTIVE_ACTIONS = new Set([
  'configure',
  'addEnvironment',
]);
const WORKSPACE_ACTIONS = new Set([
  'getState',
  'getKnowledge',
  'configure',
  'addEnvironment',
]);
const ACTIONS = new Set([
  'getState',
  'getLifecycleState',
  'refreshChanges',
  'listPushRecords',
  'listChangeSets',
  'getKnowledge',
  'configure',
  'addEnvironment',
  'switchEnvironment',
  'deleteEnvironment',
  'pull',
  'push',
  'setPreload',
  'setPreloadOrder',
  'setFolderRelease',
  'rollbackPushFile',
  'renamePushRecord',
  'deletePushRecord',
  'revertChange',
  'resolveConflict',
  'createChangeSet',
  'applyChangeSet',
  'deleteChangeSet',
]);
const CONFIRMATION_ACTIONS = new Set([
  'switchEnvironment',
  'deleteEnvironment',
  'push',
  'setPreload',
  'setPreloadOrder',
  'setFolderRelease',
  'rollbackPushFile',
  'deletePushRecord',
  'revertChange',
  'resolveConflict',
  'applyChangeSet',
  'deleteChangeSet',
]);
const OPTION_KEYS = new Map([
  ['--workspace', 'workspace'],
  ['--environment-directory', 'environmentDirectory'],
  ['--environment-id', 'environmentId'],
  ['--path', 'path'],
  ['--enabled', 'enabled'],
  ['--order', 'preStateOrder'],
  ['--push-record-id', 'pushRecordId'],
  ['--change-set-id', 'changeSetId'],
  ['--name', 'name'],
  ['--resolution', 'resolution'],
  ['--request-id', 'requestId'],
  ['--timeout', 'timeout'],
  ['--confirmed', 'confirmed'],
]);

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }

  const workspaceFolder = resolveWorkspaceFolder(parsed.values.workspace?.[0]);
  const configuration = await requireConfiguredWorkspace(workspaceFolder);
  const timeoutMs = parseTimeout(parsed.values.timeout?.[0]);
  if (parsed.action === 'wait') {
    const used = new Set(['workspace', 'timeout']);
    const requestId = one(parsed.values, used, 'requestId', '--request-id');
    assertNoUnused('wait', parsed.values, used);
    const result = await waitForExistingRequest(workspaceFolder, requestId, timeoutMs);
    writeResult(result);
    return;
  }
  const invocation = buildInvocation(parsed.action, parsed.values);
  let environmentDirectory = parsed.values.environmentDirectory?.[0];
  if (!environmentDirectory) {
    environmentDirectory = WORKSPACE_ACTIONS.has(parsed.action)
      ? 'workspace'
      : resolveActiveEnvironment(configuration);
  }
  const result = await invoke(
    workspaceFolder,
    invocation,
    environmentDirectory,
    timeoutMs,
    parsed.values.requestId?.[0],
    !INTERACTIVE_ACTIONS.has(parsed.action),
  );
  writeResult(result);
}

function parseArguments(arguments_) {
  if (
    arguments_.length === 0
    || arguments_[0] === 'help'
    || arguments_[0] === '--help'
    || arguments_[0] === '-h'
  ) {
    return { help: true, values: {} };
  }
  const action = arguments_[0];
  if (!ACTIONS.has(action) && action !== 'wait') {
    throw new CliError(`不支持的 action：${action}。使用 --help 查看可用命令`, 64);
  }
  const values = {};
  for (let index = 1; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') {
      return { help: true, values: {} };
    }
    const separator = argument.indexOf('=');
    const option = separator > 0 ? argument.slice(0, separator) : argument;
    const key = OPTION_KEYS.get(option);
    if (!key) {
      throw new CliError(`未知参数：${option}`, 64);
    }
    if (key === 'confirmed') {
      if (separator > 0) {
        throw new CliError('--confirmed 是无值标记，不接受参数值', 64);
      }
      (values[key] ??= []).push('true');
      continue;
    }
    const value = separator > 0 ? argument.slice(separator + 1) : arguments_[++index];
    if (!value || (separator < 0 && value.startsWith('--'))) {
      throw new CliError(`参数 ${option} 缺少值`, 64);
    }
    (values[key] ??= []).push(value);
  }
  for (const key of ['workspace', 'environmentDirectory', 'requestId', 'timeout', 'confirmed']) {
    if ((values[key]?.length ?? 0) > 1) {
      throw new CliError(`参数 --${toKebabCase(key)} 只能提供一次`, 64);
    }
  }
  return { action, help: false, values };
}

function buildInvocation(action, values) {
  const used = new Set(['workspace', 'environmentDirectory', 'requestId', 'timeout']);
  const invocation = { action };
  switch (action) {
    case 'switchEnvironment':
    case 'deleteEnvironment':
      invocation.environmentId = one(values, used, 'environmentId', '--environment-id');
      break;
    case 'push':
      invocation.paths = many(values, used, 'path', '--path');
      break;
    case 'setPreload':
    case 'setFolderRelease':
      invocation.path = one(values, used, 'path', '--path');
      invocation.enabled = parseBooleanOption(
        one(values, used, 'enabled', '--enabled'),
        '--enabled',
      );
      break;
    case 'setPreloadOrder':
      invocation.path = one(values, used, 'path', '--path');
      invocation.preStateOrder = parsePreStateOrderOption(
        one(values, used, 'preStateOrder', '--order'),
      );
      break;
    case 'rollbackPushFile':
      invocation.pushRecordId = one(values, used, 'pushRecordId', '--push-record-id');
      invocation.path = one(values, used, 'path', '--path');
      break;
    case 'renamePushRecord':
      invocation.pushRecordId = one(values, used, 'pushRecordId', '--push-record-id');
      invocation.name = one(values, used, 'name', '--name');
      break;
    case 'deletePushRecord':
      invocation.pushRecordId = one(values, used, 'pushRecordId', '--push-record-id');
      break;
    case 'revertChange':
      invocation.path = one(values, used, 'path', '--path');
      break;
    case 'resolveConflict':
      invocation.path = one(values, used, 'path', '--path');
      invocation.resolution = one(values, used, 'resolution', '--resolution');
      break;
    case 'createChangeSet':
      invocation.pushRecordIds = many(values, used, 'pushRecordId', '--push-record-id');
      invocation.name = one(values, used, 'name', '--name');
      break;
    case 'applyChangeSet':
    case 'deleteChangeSet':
      invocation.changeSetId = one(values, used, 'changeSetId', '--change-set-id');
      break;
    default:
      break;
  }
  if (CONFIRMATION_ACTIONS.has(action)) {
    used.add('confirmed');
    if (values.confirmed?.length !== 1) {
      throw new CliError(
        `action ${action} 会改变状态；先向用户说明具体操作和目标，取得明确授权后再添加 --confirmed`,
        64,
      );
    }
    invocation.confirmed = true;
  }
  assertNoUnused(action, values, used);
  return invocation;
}

function assertNoUnused(action, values, used) {
  const unused = Object.keys(values).filter(key => !used.has(key));
  if (unused.length > 0) {
    throw new CliError(
      `action ${action} 不接受参数：${unused.map(key => `--${toKebabCase(key)}`).join('、')}`,
      64,
    );
  }
}

function one(values, used, key, option) {
  used.add(key);
  const items = values[key];
  if (!items || items.length !== 1) {
    throw new CliError(`${option} 必须提供一次`, 64);
  }
  return items[0];
}

function many(values, used, key, option) {
  used.add(key);
  const items = values[key];
  if (!items || items.length === 0) {
    throw new CliError(`${option} 至少提供一次`, 64);
  }
  return items;
}

function parseBooleanOption(value, option) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new CliError(`${option} 必须是 true 或 false`, 64);
}

function parsePreStateOrderOption(value) {
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new CliError('--order 必须是整数或最多两位小数', 64);
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER / 100) {
    throw new CliError('--order 数值过大', 64);
  }
  return Object.is(numeric, -0) ? '0' : String(numeric);
}

function resolveActiveEnvironment(configuration) {
  const directory = configuration.environments.find(
    item => item.id === configuration.activeEnvironmentId,
  )?.directory;
  if (typeof directory !== 'string' || !directory) {
    throw new CliError('当前没有活动环境，请先执行 configure', 69);
  }
  return directory;
}

async function invoke(
  workspaceFolder,
  invocation,
  environmentDirectory,
  timeoutMs,
  preferredId,
  waitForCompletion = true,
) {
  const requestRoot = path.join(workspaceFolder, '.ecode-local', 'agent-cli', 'requests');
  const resultRoot = path.join(workspaceFolder, '.ecode-local', 'agent-cli', 'results');
  await fs.promises.mkdir(requestRoot, { recursive: true });
  const id = preferredId ?? createRequestId(invocation.action);
  validateIdentifier(id, 'request ID');
  const requestFile = path.join(requestRoot, `${id}.json`);
  const resultFile = path.join(resultRoot, `${id}.json`);
  const temporaryRequestFile = path.join(
    requestRoot,
    `.${id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const request = {
    schemaVersion: SCHEMA_VERSION,
    id,
    ...invocation,
    environmentDirectory,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(
      timeoutMs,
      INTERACTIVE_ACTIONS.has(invocation.action) ? INTERACTIVE_REQUEST_TTL_MS : 0,
    )).toISOString(),
  };
  try {
    await fs.promises.writeFile(temporaryRequestFile, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.promises.link(temporaryRequestFile, requestFile);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new CliError(`请求 ID 已存在：${id}`, 64);
    }
    throw error;
  } finally {
    await fs.promises.rm(temporaryRequestFile, { force: true });
  }
  if (!waitForCompletion) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      action: invocation.action,
      environmentDirectory,
      status: 'pending',
      message: '请求已提交，正在等待 VS Code 中的用户操作；完成或取消后使用 wait 续查',
      data: {
        requestId: id,
        waitCommand: `wait --request-id ${id}`,
        interactive: true,
      },
    };
  }
  return waitForResult(resultFile, id, invocation.action, timeoutMs);
}

async function waitForResult(resultFile, id, action, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.promises.stat(resultFile);
      if (stat.size > MAX_RESULT_BYTES) {
        throw new CliError(`结果文件超过 ${MAX_RESULT_BYTES} 字节`, 69);
      }
      const raw = await fs.promises.readFile(resultFile, 'utf8');
      const result = JSON.parse(raw);
      if (result.schemaVersion !== SCHEMA_VERSION || result.id !== id || result.action !== action) {
        throw new CliError(`结果与请求不匹配：${resultFile}`, 69);
      }
      return result;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  const interactiveHint = INTERACTIVE_ACTIONS.has(action)
    ? '；VS Code 表单可能仍在等待用户提交或取消'
    : '';
  const message = `等待 action ${action} 结果超时，结果仍未知${interactiveHint}`
    + `；不要创建新请求，请使用 wait --request-id ${id} 续查`;
  throw new CliError(message, 124, {
    schemaVersion: SCHEMA_VERSION,
    id,
      action,
      status: 'unknown',
      message,
      data: {
        requestId: id,
        waitCommand: `wait --request-id ${id}`,
        interactive: INTERACTIVE_ACTIONS.has(action),
      },
  });
}

async function waitForExistingRequest(workspaceFolder, id, timeoutMs) {
  validateIdentifier(id, 'request ID');
  const requestFile = path.join(
    workspaceFolder,
    '.ecode-local',
    'agent-cli',
    'requests',
    `${id}.json`,
  );
  let request;
  try {
    request = JSON.parse(await fs.promises.readFile(requestFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(`请求不存在：${id}`, 69);
    }
    throw error;
  }
  if (request.schemaVersion !== SCHEMA_VERSION || request.id !== id || !ACTIONS.has(request.action)) {
    throw new CliError(`请求文件无效：${requestFile}`, 69);
  }
  return waitForResult(
    path.join(workspaceFolder, '.ecode-local', 'agent-cli', 'results', `${id}.json`),
    id,
    request.action,
    timeoutMs,
  );
}

function resolveWorkspaceFolder(explicitWorkspace) {
  if (explicitWorkspace) {
    const resolved = path.resolve(explicitWorkspace);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`工作区目录不存在：${resolved}`);
    }
    return resolved;
  }
  return findWorkspaceFrom(process.cwd())
    ?? findWorkspaceFrom(__dirname)
    ?? (() => { throw new Error('找不到包含 .ecode-local 的工作区，请使用 --workspace'); })();
}

function findWorkspaceFrom(start) {
  let current = path.resolve(start);
  while (true) {
    if (path.basename(current) === '.ecode-local') {
      return path.dirname(current);
    }
    if (fs.existsSync(path.join(current, '.ecode-local'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function requireConfiguredWorkspace(workspaceFolder) {
  const configurationFile = path.join(
    workspaceFolder,
    '.ecode-local',
    'environments.json',
  );
  let configuration;
  try {
    configuration = JSON.parse(await fs.promises.readFile(configurationFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(
        '当前工作区尚未配置 Ecode 环境；请先在 VS Code 的 Ecode 侧边栏完成首次配置',
        69,
      );
    }
    throw new CliError(`无法读取环境配置：${error.message ?? error}`, 69);
  }
  if (
    configuration?.schemaVersion !== 2
    || !Array.isArray(configuration.environments)
    || configuration.environments.length === 0
    || typeof configuration.activeEnvironmentId !== 'string'
    || !configuration.environments.some(item => item?.id === configuration.activeEnvironmentId)
  ) {
    throw new CliError('当前工作区没有有效的活动 Ecode 环境，请先在 VS Code 中完成配置', 69);
  }
  return configuration;
}

function parseTimeout(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    throw new CliError('--timeout 必须是大于 0 且不超过 3600 的秒数', 64);
  }
  return Math.ceil(seconds * 1000);
}

function createRequestId(action) {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${action}_${Date.now().toString(36)}_${suffix}`.slice(0, 64);
}

function validateIdentifier(value, label) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new CliError(`${label} 只能包含英文字母、数字、下划线和横线，最长 64 位`, 64);
  }
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = {
    succeeded: 0,
    pending: 0,
    partial: 3,
    cancelled: 4,
    rejected: 5,
    failed: 6,
  }[result.status] ?? 69;
}

class CliError extends Error {
  constructor(message, exitCode, payload) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

function helpText() {
  return `Ecode Local 通用 Agent CLI\n\n`
    + `用法：\n`
    + `  node ecode-agent.cjs <action> [参数]\n\n`
    + `首次使用：\n`
    + `  工作区至少配置一个 Ecode 环境后才会生成本 CLI。首次配置请使用 VS Code 的 Ecode 侧边栏。\n\n`
    + `通用参数：\n`
    + `  --workspace <目录>               工作区目录；默认自动查找\n`
    + `  --environment-directory <目录>   覆盖自动查询的活动环境\n`
    + `  --request-id <ID>                指定唯一请求 ID\n`
    + `  --timeout <秒>                   等待结果时间，默认 600，最大 3600\n\n`
    + `Agent 授权：\n`
    + `  ${[...CONFIRMATION_ACTIONS].join('、')} 必须先取得用户明确授权，再添加 --confirmed。\n`
    + `  pull 不需要确认，也不接受 --confirmed。VS Code 不会为 Agent CLI 重复弹出确认框。\n\n`
    + `交互式 action：\n`
    + `  configure、addEnvironment 提交后立即返回 pending；\n`
    + `  原请求保留一小时，用户在 VS Code 中完成或取消后使用 wait 续查，禁止创建重复请求。\n\n`
    + `续查超时请求：\n  node ecode-agent.cjs wait --request-id <ID> [--timeout <秒>]\n\n`
    + `Action 参数：\n`
    + `  switchEnvironment|deleteEnvironment --environment-id <ID>\n`
    + `  push --path <路径> [--path <路径> ...]\n`
    + `  setPreload|setFolderRelease --path <路径> --enabled <true|false>\n`
    + `  setPreloadOrder --path <根文件夹路径> --order <整数或最多两位小数>\n`
    + `  rollbackPushFile --push-record-id <ID> --path <路径>\n`
    + `  renamePushRecord --push-record-id <ID> --name <名称>\n`
    + `  deletePushRecord --push-record-id <ID>\n`
    + `  revertChange --path <路径>\n`
    + `  resolveConflict --path <路径> --resolution <值>\n`
    + `  createChangeSet --push-record-id <ID> [--push-record-id <ID> ...] --name <名称>\n`
    + `  applyChangeSet|deleteChangeSet --change-set-id <ID>\n\n`
    + `无专用参数的 action：\n  ${[...ACTIONS].filter(action => ![
      'switchEnvironment', 'deleteEnvironment', 'push', 'rollbackPushFile', 'renamePushRecord',
      'setPreload', 'setPreloadOrder', 'setFolderRelease',
      'deletePushRecord', 'revertChange',
      'resolveConflict', 'createChangeSet', 'applyChangeSet', 'deleteChangeSet',
    ].includes(action)).join('、')}\n`;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CliError && error.payload) {
    process.stdout.write(`${JSON.stringify(error.payload, null, 2)}\n`);
  }
  process.stderr.write(`ecode-agent: ${message}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : 69;
});
