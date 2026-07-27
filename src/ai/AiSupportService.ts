import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ECODE_AI_DIRECTORY } from '../domain/constants';
import { resolveEcodeSourceRoot } from '../domain/paths';
import { hashText } from '../domain/text';
import type { ConnectionProfile } from '../domain/types';
import type { WorkspaceComponentRegistry } from '../language/WorkspaceComponentRegistry';
import {
  generateAiGuide,
  generateComponentDeclarations,
  generateGlobalDeclarations,
  generateWorkspaceComponents,
} from './AiSupportGenerator';

const AGENTS_START = '<!-- ecode-local:ai-start -->';
const AGENTS_END = '<!-- ecode-local:ai-end -->';
const MANAGED_FILES = [
  'ecode-globals.d.ts',
  'ecode-components.d.ts',
  'ecode-ai-guide.md',
  'workspace-components.md',
  'manifest.json',
] as const;

export interface AiSupportRefreshResult {
  directory: string;
  changedFiles: readonly string[];
}

export class AiSupportService {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: WorkspaceComponentRegistry,
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
        directory: path.join(profile.workspaceFolder, ECODE_AI_DIRECTORY),
        changedFiles: [],
      };
    }
    const sourceRoot = resolveEcodeSourceRoot(profile.workspaceFolder);
    await this.registry.refreshSourceRoot(sourceRoot);
    const calls = await this.registry.getSnapshot(sourceRoot);
    const generated: Record<string, string> = {
      'ecode-globals.d.ts': generateGlobalDeclarations(),
      'ecode-components.d.ts': generateComponentDeclarations(),
      'ecode-ai-guide.md': generateAiGuide(),
      'workspace-components.md': generateWorkspaceComponents(
        profile.workspaceFolder,
        calls,
      ),
    };
    generated['manifest.json'] = `${JSON.stringify({
      schemaVersion: 1,
      generatorVersion: this.extensionVersion,
      knowledgeHash: hashText(Object.entries(generated)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, content]) => `${name}\0${content}`)
        .join('\0')),
    }, null, 2)}\n`;

    const directory = path.join(profile.workspaceFolder, ECODE_AI_DIRECTORY);
    await fs.mkdir(directory, { recursive: true });
    const changedFiles: string[] = [];
    for (const [name, content] of Object.entries(generated)) {
      const file = path.join(directory, name);
      if (await writeIfChanged(file, content)) {
        changedFiles.push(file);
      }
    }

    const agentsFile = path.join(profile.workspaceFolder, 'AGENTS.md');
    const currentAgents = await readOptionalFile(agentsFile);
    const nextAgents = updateManagedAgentsContent(currentAgents);
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
    return { directory, changedFiles };
  }

  remove(workspaceFolder: string): Promise<void> {
    return this.enqueue(() => this.removeNow(workspaceFolder));
  }

  private async removeNow(workspaceFolder: string): Promise<void> {
    const directory = path.join(workspaceFolder, ECODE_AI_DIRECTORY);
    for (const name of MANAGED_FILES) {
      await removeOptionalFile(path.join(directory, name));
    }
    try {
      await fs.rmdir(directory);
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT') && !isFileSystemError(error, 'ENOTEMPTY')) {
        throw error;
      }
    }

    const agentsFile = path.join(workspaceFolder, 'AGENTS.md');
    const currentAgents = await readOptionalFile(agentsFile);
    if (currentAgents !== undefined) {
      const nextAgents = removeManagedAgentsContent(currentAgents);
      if (nextAgents !== currentAgents) {
        await writeIfChanged(agentsFile, nextAgents);
      }
    }
  }

  guideUri(workspaceFolder: string): vscode.Uri {
    return vscode.Uri.file(path.join(
      workspaceFolder,
      ECODE_AI_DIRECTORY,
      'ecode-ai-guide.md',
    ));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function updateManagedAgentsContent(current: string | undefined): string {
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
    '- `ecode/`：唯一的 Ecode 业务源码目录。',
    '- `.ecode-ai/`：由 Ecode Local 自动生成的 AI 知识资料，不属于业务源码。',
    '- 不要直接修改 `.ecode-ai/` 中的文件。',
    '- 不要把 `.ecode-ai/`、`AGENTS.md` 或工作区其他文件当作 Ecode 远端源码。',
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
    '1. 阅读 `.ecode-ai/ecode-ai-guide.md`。',
    '2. API、参数和返回值以 `.ecode-ai/ecode-globals.d.ts` 为准。',
    '3. PC 组件和 props 以 `.ecode-ai/ecode-components.d.ts` 为准。',
    '4. 使用 `ecodeSDK.getCom` 前，检查 `.ecode-ai/workspace-components.md` '
      + '中是否存在对应的 `setCom` 注册。',
    '5. 优先搜索 `ecode/` 中已有的同类调用和项目编码模式。',
    '6. 类型为 `unknown` 表示资料不足，需要从现有源码或用户信息继续确认，不得自行编造参数。',
    '',
    '### 修改边界',
    '',
    '- 业务代码修改应限制在 `ecode/` 中，除非用户明确要求修改工作区配置或文档。',
    '- 不要直接编辑生成的 AI 文件。',
    '- 不要假设业务工作区使用 Git。',
    '- 不要自动执行远端推送、删除或发布操作。',
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
