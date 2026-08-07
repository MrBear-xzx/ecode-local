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
  'skills/ecode-local/SKILL.md',
  'skills/ecode-local/agents/openai.yaml',
  'skills/ecode-local/references/actions.md',
  'skills/ecode-local/scripts/ecode-agent.cjs',
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
    private readonly extensionRoot: string,
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
      ...await this.loadSkillFiles(),
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
    await removeEmptyDirectories([
      path.join(directory, 'skills', 'ecode-local', 'agents'),
      path.join(directory, 'skills', 'ecode-local', 'references'),
      path.join(directory, 'skills', 'ecode-local', 'scripts'),
      path.join(directory, 'skills', 'ecode-local'),
      path.join(directory, 'skills'),
      directory,
    ]);
  }

  guideUri(workspaceFolder: string): vscode.Uri {
    return vscode.Uri.file(path.join(
      commonAiDirectory(workspaceFolder),
      'ecode-ai-guide.md',
    ));
  }

  skillUri(workspaceFolder: string): vscode.Uri {
    return vscode.Uri.file(path.join(
      commonAiDirectory(workspaceFolder),
      'skills',
      'ecode-local',
      'SKILL.md',
    ));
  }

  cliUri(workspaceFolder: string): vscode.Uri {
    return vscode.Uri.file(path.join(
      commonAiDirectory(workspaceFolder),
      'skills',
      'ecode-local',
      'scripts',
      'ecode-agent.cjs',
    ));
  }

  private async loadSkillFiles(): Promise<Record<string, string>> {
    const sourceRoot = path.join(
      this.extensionRoot,
      'resources',
      'skills',
      'ecode-local',
    );
    const entries = [
      ['skills/ecode-local/SKILL.md', 'SKILL.md'],
      ['skills/ecode-local/agents/openai.yaml', 'agents/openai.yaml'],
      ['skills/ecode-local/references/actions.md', 'references/actions.md'],
      ['skills/ecode-local/scripts/ecode-agent.cjs', 'scripts/ecode-agent.cjs'],
    ] as const;
    return Object.fromEntries(await Promise.all(entries.map(async ([target, source]) => [
      target,
      await fs.readFile(path.join(sourceRoot, ...source.split('/')), 'utf8'),
    ])));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function updateManagedAgentsContent(
  current: string | undefined,
  environmentDirectory: string,
): string {
  const block = [
    AGENTS_START,
    '## Ecode 项目说明',
    '',
    '这是一个泛微 E-cology 9 Ecode 前端扩展项目。',
    '',
    'Ecode 是运行在 E-cology 浏览器环境中的前端扩展平台，不是独立的 '
      + 'Node.js、React CLI 或普通 Web 项目。源码由 Ecode 平台加载、编译和执行。',
    '',
    '### AI 工作入口',
    '',
    '- 处理 Ecode 环境、同步、冲突、前置加载、文件夹发布、推送记录、'
      + '变更集、API/组件知识或 AI 支持时，'
      + '必须先阅读 `.ecode-local/common/ecode-ai/skills/ecode-local/SKILL.md`。',
    '- 所有扩展功能统一通过 Skill 提供的 `scripts/ecode-agent.cjs` 调用。',
    `- 当前活动环境源码目录是 \`${environmentDirectory}/\`。`,
    `- 当前环境项目知识位于 \`.ecode-local/${environmentDirectory}/ecode-ai/\`。`,
    '- 公共 API 与组件知识位于 `.ecode-local/common/ecode-ai/`。',
    '',
    '### 不可绕过的边界',
    '',
    '- 业务代码修改限制在活动环境源码目录，除非用户明确要求其他文件。',
    '- 不直接读写 `.ecode-local/agent-cli/` 或其他内部状态；由 CLI 负责通信。',
    '- 用户要求只读时仍可运行 CLI，但只能调用只读 action。',
    '- 不把 `.ecode-local/`、`AGENTS.md` 或工作区其他文件推送到 Ecode。',
    '- 不自动执行远端推送、删除、冲突处理、生命周期状态变更或变更集应用；'
      + '每次操作都需要当前任务授权。',
    '- 推送必须有单独、明确的当前任务授权；代码修改或测试通过不等于推送授权。',
    '- 需要确认的 CLI action 必须先取得当前任务授权，再添加 `--confirmed`；VS Code 不会重复确认。',
    '- 拉取无需确认；不绕过远端冲突检查、编译/GBK 校验和写后回读验证。',
    '- `ecodeSDK`、`WfForm`、`ModeForm`、`ModeList`、`ecCom` 和 `antd` '
      + '由 Ecode 运行时提供，不因缺少 import 而安装依赖。',
    '- JavaScript 语法兼容能力以 Babel 7.5.5 为准。',
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

async function removeEmptyDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    try {
      await fs.rmdir(directory);
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT') && !isFileSystemError(error, 'ENOTEMPTY')) {
        throw error;
      }
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
