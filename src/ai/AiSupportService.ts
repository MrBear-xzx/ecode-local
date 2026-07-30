import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ECODE_COMMON_DIRECTORY,
  ECODE_AI_DIRECTORY,
  ECODE_LOCAL_DIRECTORY,
} from '../domain/constants';
import { resolveEnvironmentSourceRoot } from '../domain/paths';
import { hashText } from '../domain/text';
import type { ConnectionProfile } from '../domain/types';
import type { WorkspaceComponentRegistry } from '../language/WorkspaceComponentRegistry';
import type {
  WorkspaceFormMetadataRegistry,
} from '../language/WorkspaceFormMetadataRegistry';
import {
  generateAiGuide,
  generateComponentDeclarations,
  generateGlobalDeclarations,
  generateWorkspaceComponents,
  generateWorkspaceFormMetadata,
} from './AiSupportGenerator';

const AGENTS_START = '<!-- ecode-local:ai-start -->';
const AGENTS_END = '<!-- ecode-local:ai-end -->';
const COMMON_MANAGED_FILES = [
  'ecode-globals.d.ts',
  'ecode-components.d.ts',
  'ecode-ai-guide.md',
  'manifest.json',
] as const;
const ENVIRONMENT_MANAGED_FILES = [
  'workspace-components.md',
  'workspace-form-metadata.md',
  'manifest.json',
] as const;

export interface AiSupportRefreshResult {
  directory: string;
  commonDirectory: string;
  changedFiles: readonly string[];
}

export class AiSupportService {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: WorkspaceComponentRegistry,
    private readonly formRegistry: WorkspaceFormMetadataRegistry,
    private readonly extensionVersion: string,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  isEnabled(workspaceFolder: string): boolean {
    return vscode.workspace
      .getConfiguration('ecode', vscode.Uri.file(workspaceFolder))
      .get<boolean>('aiSupport.enabled', true);
  }

  refresh(profile: ConnectionProfile): Promise<AiSupportRefreshResult> {
    return this.enqueue(() => this.refreshNow(profile));
  }

  private async refreshNow(
    profile: ConnectionProfile,
  ): Promise<AiSupportRefreshResult> {
    if (!this.isEnabled(profile.workspaceFolder)) {
      return {
        directory: environmentAiDirectory(profile),
        commonDirectory: commonAiDirectory(profile.workspaceFolder),
        changedFiles: [],
      };
    }
    const sourceRoot = resolveEnvironmentSourceRoot(
      profile.workspaceFolder,
      profile.environmentDirectory,
    );
    await this.registry.refreshSourceRoot(sourceRoot);
    const calls = await this.registry.getSnapshot(sourceRoot);
    const commonGenerated: Record<string, string> = {
      'ecode-globals.d.ts': generateGlobalDeclarations(),
      'ecode-components.d.ts': generateComponentDeclarations(),
      'ecode-ai-guide.md': generateAiGuide(),
    };
    commonGenerated['manifest.json'] = generatedManifest(
      this.extensionVersion,
      commonGenerated,
    );
    const environmentGenerated: Record<string, string> = {
      'workspace-components.md': generateWorkspaceComponents(
        profile.workspaceFolder,
        calls,
        profile.environmentDirectory,
      ),
      'workspace-form-metadata.md': generateWorkspaceFormMetadata(
        this.formRegistry.getSnapshot(),
        profile.environmentDirectory,
      ),
    };
    environmentGenerated['manifest.json'] = generatedManifest(
      this.extensionVersion,
      environmentGenerated,
    );

    const commonDirectory = commonAiDirectory(profile.workspaceFolder);
    const directory = environmentAiDirectory(profile);
    const changedFiles: string[] = [];
    for (const [targetDirectory, generated] of [
      [commonDirectory, commonGenerated],
      [directory, environmentGenerated],
    ] as const) {
      await fs.mkdir(targetDirectory, { recursive: true });
      for (const [name, content] of Object.entries(generated)) {
        const file = path.join(targetDirectory, name);
        if (await writeIfChanged(file, content)) {
          changedFiles.push(file);
        }
      }
    }

    const agentsFile = path.join(profile.workspaceFolder, 'AGENTS.md');
    const currentAgents = await readOptionalFile(agentsFile);
    const nextAgents = updateManagedAgentsContent(
      currentAgents,
      profile.environmentDirectory,
    );
    if (nextAgents !== currentAgents && await writeIfChanged(agentsFile, nextAgents)) {
      changedFiles.push(agentsFile);
    }
    if (changedFiles.length > 0) {
      this.output.info(
        `AI coding support refreshed: ${changedFiles
          .map(file => path.relative(profile.workspaceFolder, file))
          .join(', ')}`,
      );
    }
    return { directory, commonDirectory, changedFiles };
  }

  remove(
    profile: ConnectionProfile,
    environmentDirectories: readonly string[] = [profile.environmentDirectory],
  ): Promise<void> {
    return this.enqueue(() => this.removeNow(profile, environmentDirectories));
  }

  private async removeNow(
    profile: ConnectionProfile,
    environmentDirectories: readonly string[],
  ): Promise<void> {
    await this.removeManagedDirectory(
      commonAiDirectory(profile.workspaceFolder),
      COMMON_MANAGED_FILES,
    );
    for (const environmentDirectory of new Set(environmentDirectories)) {
      await this.removeManagedDirectory(
        environmentAiDirectory({ ...profile, environmentDirectory }),
        ENVIRONMENT_MANAGED_FILES,
      );
    }

    const agentsFile = path.join(profile.workspaceFolder, 'AGENTS.md');
    const currentAgents = await readOptionalFile(agentsFile);
    if (currentAgents !== undefined) {
      const nextAgents = removeManagedAgentsContent(currentAgents);
      if (nextAgents !== currentAgents) {
        await writeIfChanged(agentsFile, nextAgents);
      }
    }
  }

  private async removeManagedDirectory(
    directory: string,
    managedFiles: readonly string[],
  ): Promise<void> {
    for (const name of managedFiles) {
      await removeOptionalFile(path.join(directory, name));
    }
    try {
      await fs.rmdir(directory);
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT') && !isFileSystemError(error, 'ENOTEMPTY')) {
        throw error;
      }
    }
  }

  guideUri(workspaceFolder: string): vscode.Uri {
    return vscode.Uri.file(path.join(
      commonAiDirectory(workspaceFolder),
      'ecode-ai-guide.md',
    ));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function updateManagedAgentsContent(
  current: string | undefined,
  environmentDirectory = '环境目录',
): string {
  const environmentAiRoot = `.ecode-local/${environmentDirectory}/ecode-ai`;
  const block = [
    AGENTS_START,
    '## Ecode 项目说明',
    '',
    '这是一个泛微 E-cology 9 Ecode 前端扩展项目。',
    '',
    'Ecode 是运行在 E-cology 浏览器环境中的前端扩展平台，不是独立的 '
      + 'Node.js、React CLI 或普通 Web 项目。源码由 Ecode 平台加载、编译和执行。',
    '',
    '### 目录约定',
    '',
    `- \`${environmentDirectory}/\`：当前活动环境的 Ecode 业务源码目录。`,
    '- `.ecode-local/common/ecode-ai/`：公共 API 与组件知识，不属于业务源码。',
    `- \`.ecode-local/${environmentDirectory}/\`：当前环境的同步状态、字段缓存、快照、`
      + '冲突、恢复副本及项目知识，不属于业务源码。',
    '- `.ecode-local/promotion/`：推送记录、跨环境变更集、源码快照与应用记录。',
    '- 不要直接修改 `.ecode-local/` 中的文件；唯一例外是下述 AI 推送请求文件。',
    '- 不要把 `.ecode-local/`、`AGENTS.md` 或工作区其他文件当作 Ecode 远端源码。',
    '',
    '### 运行时约定',
    '',
    '以下对象通常由 Ecode/E-cology 运行时全局提供，无须 npm 安装或 import：',
    '',
    '- `ecodeSDK`',
    '- `WfForm`',
    '- `ModeForm`',
    '- `ModeList`',
    '- `ecCom`',
    '- `antd`',
    '- 对应的 `window.*` 对象',
    '',
    '不要因为源码中没有 import 就擅自添加 npm 依赖、模拟实现或替代封装。',
    '',
    'Ecode JavaScript 编译兼容能力以 Babel 7.5.5 为准。'
      + '生成代码时避免使用目标环境无法支持的新语法和新运行时 API。',
    '',
    '### 修改代码前',
    '',
    '1. 阅读 `.ecode-local/common/ecode-ai/ecode-ai-guide.md`。',
    '2. API、参数和返回值以 `.ecode-local/common/ecode-ai/ecode-globals.d.ts` 为准。',
    '3. PC 组件和 props 以 `.ecode-local/common/ecode-ai/ecode-components.d.ts` 为准。',
    `4. 表单字段以 \`${environmentAiRoot}/workspace-form-metadata.md\` 为准。`,
    `5. 使用 \`ecodeSDK.getCom\` 前，检查 \`${environmentAiRoot}/workspace-components.md\` `
      + '中是否存在对应的 `setCom` 注册。',
    `6. 优先搜索 \`${environmentDirectory}/\` 中已有的同类调用和项目编码模式。`,
    '7. 类型为 `unknown` 表示资料不足，需要从现有源码或用户信息继续确认，不得自行编造参数。',
    '',
    '### 修改边界',
    '',
    `- 业务代码修改应限制在 \`${environmentDirectory}/\` 中，`
      + '除非用户明确要求修改工作区配置或文档。',
    '- 不要直接编辑生成的 AI 文件。',
    '- 不要假设业务工作区使用 Git。',
    '- 不要自动执行远端推送、删除或发布操作。',
    '',
    '### AI 推送请求接口',
    '',
    '- 只有用户在当前任务中明确要求推送时，AI 才能创建推送请求；代码修改、测试通过或此前授权都不等于推送授权。',
    `- 请求写入 \`.ecode-local/ai-requests/<id>.json\`，其中环境目录必须是当前活动目录 \`${environmentDirectory}\`。`,
    '- `<id>` 只能包含英文字母、数字、下划线和横线，最长 64 位；每次请求使用新的 id，禁止覆盖旧请求。',
    '- `paths` 使用相对于环境源码目录的 `/` 分隔路径，只能包含本次明确要求推送的文件，最多 100 个。',
    '- 扩展会校验文件状态、弹出人工确认、执行远端冲突检查和回读验证；AI 不得绕过确认或直接调用 E-cology 接口。',
    '- 处理结果位于 `.ecode-local/ai-results/<id>.json`。读取结果并向用户报告；不要修改请求或结果文件。',
    '',
    '```json',
    '{',
    '  "schemaVersion": 1,',
    '  "id": "push_20260730_001",',
    '  "action": "push",',
    `  "environmentDirectory": "${environmentDirectory}",`,
    '  "paths": ["Type/example.js"],',
    '  "createdAt": "2026-07-30T12:00:00.000Z"',
    '}',
    '```',
    AGENTS_END,
  ].join('\n');
  if (current === undefined || current.length === 0) {
    return `${block}\n`;
  }
  const range = managedRange(current);
  if (!range) {
    return `${current.replace(/\s+$/, '')}\n\n${block}\n`;
  }
  return `${current.slice(0, range.start)}${block}${current.slice(range.end)}`;
}

export function removeManagedAgentsContent(current: string): string {
  const range = managedRange(current, true);
  if (!range) {
    return current;
  }
  let before = current.slice(0, range.start);
  let after = current.slice(range.end);
  before = before.replace(/(\r?\n)\r?\n$/, '$1');
  after = after.replace(/^\r?\n/, '');
  return `${before}${after}`;
}

function managedRange(
  current: string,
  allowMissing = false,
): { start: number; end: number } | undefined {
  const starts = allIndexes(current, AGENTS_START);
  const ends = allIndexes(current, AGENTS_END);
  if (starts.length === 0 && ends.length === 0) {
    return undefined;
  }
  if (
    starts.length !== 1
    || ends.length !== 1
    || starts[0] > ends[0]
  ) {
    throw new Error(
      `AGENTS.md 中的 ${AGENTS_START} / ${AGENTS_END} 标记残缺、重复或顺序错误，已停止覆盖`,
    );
  }
  const end = ends[0] + AGENTS_END.length;
  if (!allowMissing && current.slice(starts[0] + AGENTS_START.length, ends[0])
    .includes(AGENTS_START)) {
    throw new Error('AGENTS.md 中的 Ecode 管理区块存在嵌套标记，已停止覆盖');
  }
  return { start: starts[0], end };
}

function allIndexes(value: string, search: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= value.length) {
    const index = value.indexOf(search, offset);
    if (index < 0) {
      return indexes;
    }
    indexes.push(index);
    offset = index + search.length;
  }
  return indexes;
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if (await readOptionalFile(file) === content) {
    return false;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  try {
    await fs.rename(temporary, file);
  } catch (error: unknown) {
    await removeOptionalFile(temporary);
    throw error;
  }
  return true;
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    if (isFileSystemError(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

async function removeOptionalFile(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error: unknown) {
    if (!isFileSystemError(error, 'ENOENT')) {
      throw error;
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function commonAiDirectory(workspaceFolder: string): string {
  return path.join(
    workspaceFolder,
    ECODE_LOCAL_DIRECTORY,
    ECODE_COMMON_DIRECTORY,
    ECODE_AI_DIRECTORY,
  );
}

function environmentAiDirectory(profile: ConnectionProfile): string {
  return path.join(
    profile.workspaceFolder,
    ECODE_LOCAL_DIRECTORY,
    profile.environmentDirectory,
    ECODE_AI_DIRECTORY,
  );
}

function generatedManifest(
  extensionVersion: string,
  generated: Record<string, string>,
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    generatorVersion: extensionVersion,
    knowledgeHash: hashText(Object.entries(generated)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, content]) => `${name}\0${content}`)
      .join('\0')),
  }, null, 2)}\n`;
}
