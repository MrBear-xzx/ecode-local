import * as fs from 'fs';
import * as path from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { DIFF_MAX_LINES_PER_FILE, LOCAL_SYNC_DIR, MAIN_BRANCH } from '../constants';
import type { FileLineDiff, LineChange, LineDiffHunk } from './api/types';

/**
 * Git 仓库管理器
 *
 * 封装 simple-git，提供仓库初始化、分支管理、差异比较、提交等功能。
 * diff 基线永远是 main 分支。
 */
export class GitManager {
  private git: SimpleGit;
  private workspaceRoot: string;
  private ecodeDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.git = simpleGit(workspaceRoot);
    this.ecodeDir = path.join(workspaceRoot, LOCAL_SYNC_DIR);
  }

  // ==================== 环境检查 ====================

  /** 检查系统是否安装了 git */
  static async isGitInstalled(): Promise<boolean> {
    try {
      const git = simpleGit();
      await git.version();
      return true;
    } catch {
      return false;
    }
  }

  /** 检查当前工作区是否是 git 仓库 */
  async isGitRepo(): Promise<boolean> {
    try {
      await this.git.revparse(['--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  // ==================== 初始化 ====================

  /** git init 并重命名当前分支为 main，同时写入 .gitignore */
  async initRepo(): Promise<void> {
    await this.git.init();
    // 将默认分支重命名为 main
    try {
      await this.git.branch(['-M', MAIN_BRANCH]);
    } catch {
      // 可能当前就是 main，忽略错误
    }
    // 确保 .ecode/ 被 git 忽略
    await this.ensureGitIgnore();
  }

  /**
   * 确保 main 分支存在。
   * 已有仓库但默认分支是 master 时，自动将 master 重命名为 main。
   */
  async ensureMainBranch(): Promise<void> {
    if (await this.hasMainBranch()) {
      // main 已存在，仍确保 .gitignore 已配置
      await this.ensureGitIgnore();
      return;
    }

    // 检查是否存在 master 分支
    try {
      const branches = await this.git.branchLocal();
      if (branches.all.includes('master')) {
        // 先切换到 master 再重命名
        await this.git.checkout('master');
        await this.git.branch(['-M', MAIN_BRANCH]);
        return;
      }
    } catch {
      // 继续尝试其他方式
    }

    // 无 master 也无 main → 创建 main 分支（基于当前 HEAD）
    try {
      await this.git.checkoutLocalBranch(MAIN_BRANCH);
    } catch {
      // 忽略
    }

    // 确保 .gitignore 已配置
    await this.ensureGitIgnore();
  }

  /**
   * 确保工作区 .gitignore 中包含 .ecode/
   * 不存在则创建，已存在但无 .ecode/ 则追加
   */
  private async ensureGitIgnore(): Promise<void> {
    const ignorePath = path.join(this.workspaceRoot, '.gitignore');
    const patterns = ['.ecode/', '.vscode/'];

    try {
      let content = '';
      if (fs.existsSync(ignorePath)) {
        content = fs.readFileSync(ignorePath, 'utf-8');
      }

      const existing = new Set(content.split('\n').map(l => l.trim()));
      const toAdd = patterns.filter(p => !existing.has(p));

      if (toAdd.length > 0) {
        const suffix = content.endsWith('\n') ? '' : '\n';
        fs.appendFileSync(ignorePath, `${suffix}${toAdd.join('\n')}\n`);
      }
    } catch {
      // 权限不足等，忽略
    }
  }

  /** 检查 main 分支是否存在 */
  async hasMainBranch(): Promise<boolean> {
    try {
      const branches = await this.git.branchLocal();
      return branches.all.includes(MAIN_BRANCH);
    } catch {
      return false;
    }
  }

  // ==================== 分支操作 ====================

  /** 获取当前分支名 */
  async getCurrentBranch(): Promise<string> {
    try {
      const result = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return result.trim();
    } catch {
      return 'HEAD';
    }
  }

  /** 从 main 分支创建新的开发分支并切换过去 */
  async createBranch(branchName: string): Promise<void> {
    // 确保 main 分支存在
    if (!(await this.hasMainBranch())) {
      throw new Error(`基线分支 "${MAIN_BRANCH}" 不存在，请先拉取服务器代码`);
    }
    await this.git.checkoutBranch(branchName, MAIN_BRANCH);
  }

  /** 切换到指定分支 */
  async checkoutBranch(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  /** 检查是否有未提交的更改（暂存区 + 工作区） */
  async isDirty(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  // ==================== 差异比较 ====================

  /**
   * 获取当前分支相对于 main 的变更文件列表
   * 等价于: git diff main..HEAD --name-only -- ecode/
   */
  async getChangedFiles(): Promise<string[]> {
    try {
      const output = await this.git.diff([
        `${MAIN_BRANCH}..HEAD`,
        '--name-only',
        '--',
        LOCAL_SYNC_DIR,
      ]);
      if (!output) { return []; }
      return output.trim().split('\n').filter(Boolean);
    } catch {
      // main 分支可能不存在
      return [];
    }
  }

  /**
   * 获取当前分支相对于 main 的原始 unified diff
   * 等价于: git diff main..HEAD -- ecode/
   */
  async getRawDiff(): Promise<string> {
    try {
      return await this.git.diff([
        `${MAIN_BRANCH}..HEAD`,
        '--',
        LOCAL_SYNC_DIR,
      ]);
    } catch {
      return '';
    }
  }

  /**
   * 获取结构化的行级别差异摘要
   * 解析 git diff 输出为 FileLineDiff[]
   */
  async getDiffSummary(): Promise<FileLineDiff[]> {
    const raw = await this.getRawDiff();
    if (!raw) { return []; }
    return this.parseUnifiedDiff(raw);
  }

  // ==================== 提交 ====================

  /**
   * 提交 ecode/ 目录的所有更改
   */
  async commit(message: string): Promise<void> {
    await this.git.add([`${LOCAL_SYNC_DIR}/`, '.gitignore']);
    try {
      await this.git.commit(message);
    } catch {
      // nothing to commit 时忽略
    }
  }

  // ==================== unified diff 解析器 ====================

  /**
   * 解析 git diff 统一格式输出为结构化差异数据
   *
   * 格式:
   *   diff --git a/path b/path
   *   new file mode ...
   *   --- a/path
   *   +++ b/path
   *   @@ -a,b +c,d @@
   *    context
   *   +added
   *   -removed
   */
  private parseUnifiedDiff(raw: string): FileLineDiff[] {
    const result: FileLineDiff[] = [];

    // 按文件分割 diff 输出
    const fileBlocks = this.splitDiffByFile(raw);

    for (const block of fileBlocks) {
      const fileDiff = this.parseFileBlock(block);
      if (fileDiff) {
        result.push(fileDiff);
      }
    }

    return result;
  }

  /** 按 "diff --git " 行分割每个文件的 diff 块 */
  private splitDiffByFile(raw: string): string[] {
    const blocks: string[] = [];
    let current: string[] = [];

    for (const line of raw.split('\n')) {
      if (line.startsWith('diff --git ') && current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }

    if (current.length > 0) {
      blocks.push(current.join('\n'));
    }

    return blocks;
  }

  /** 解析单个文件的 diff 块 */
  private parseFileBlock(block: string): FileLineDiff | null {
    const lines = block.split('\n');

    // 提取文件路径
    const headerMatch = lines[0]?.match(/diff --git a\/(.*) b\/(.*)/);
    if (!headerMatch) { return null; }

    const filePath = headerMatch[2]; // 新文件路径

    // 判断状态：新增 / 删除 / 修改
    let status: 'added' | 'modified' | 'deleted' = 'modified';
    let isBinary = false;

    for (const line of lines) {
      if (line.startsWith('new file mode')) { status = 'added'; break; }
      if (line.startsWith('deleted file mode')) { status = 'deleted'; break; }
      if (line.startsWith('Binary files')) { isBinary = true; break; }
    }

    if (isBinary) {
      return {
        path: filePath,
        status,
        additions: 0,
        deletions: 0,
        hunks: [],
        truncated: false,
      };
    }

    // 解析 hunks
    const hunks: LineDiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    let totalLines = 0;
    let truncated = false;

    let hunkStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const hunkHeaderMatch = lines[i].match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (hunkHeaderMatch) {
        // 先处理上一个 hunk
        if (hunkStart >= 0 && !truncated) {
          const hunkLines = this.parseHunkLines(lines, hunkStart, i, () => {
            if (totalLines >= DIFF_MAX_LINES_PER_FILE) {
              truncated = true;
            }
            return !truncated;
          });
          if (hunkLines) {
            for (const l of hunkLines.lines) {
              if (l.kind === 'add') { additions++; }
              else if (l.kind === 'remove') { deletions++; }
              totalLines++;
            }
            hunks.push(hunkLines);
          }
        }

        hunkStart = i;
      }
    }

    // 处理最后一个 hunk
    if (hunkStart >= 0 && !truncated) {
      const hunkLines = this.parseHunkLines(lines, hunkStart, lines.length, () => {
        if (totalLines >= DIFF_MAX_LINES_PER_FILE) {
          truncated = true;
        }
        return !truncated;
      });
      if (hunkLines) {
        for (const l of hunkLines.lines) {
          if (l.kind === 'add') { additions++; }
          else if (l.kind === 'remove') { deletions++; }
          totalLines++;
        }
        hunks.push(hunkLines);
      }
    }

    return {
      path: filePath,
      status,
      additions,
      deletions,
      hunks,
      truncated,
    };
  }

  /** 解析 hunk 内的行变更 */
  private parseHunkLines(
    lines: string[],
    start: number,
    end: number,
    shouldContinue: () => boolean,
  ): LineDiffHunk | null {
    const headerMatch = lines[start]?.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (!headerMatch) { return null; }

    const oldStart = parseInt(headerMatch[1], 10);
    const oldCount = parseInt(headerMatch[2] || '1', 10);
    const newStart = parseInt(headerMatch[3], 10);
    const newCount = parseInt(headerMatch[4] || '1', 10);

    const lineChanges: LineChange[] = [];
    let oldLine = oldStart;
    let newLine = newStart;

    for (let i = start + 1; i < end; i++) {
      if (!shouldContinue()) { break; }

      const line = lines[i];
      if (line.length === 0) { continue; }

      const prefix = line[0];
      const content = line.slice(1);

      switch (prefix) {
        case ' ':
          lineChanges.push({ kind: 'context', content, oldLine: oldLine++, newLine: newLine++ });
          break;
        case '-':
          lineChanges.push({ kind: 'remove', content, oldLine: oldLine++ });
          break;
        case '+':
          lineChanges.push({ kind: 'add', content, newLine: newLine++ });
          break;
        case '\\':
          // "\ No newline at end of file" — 跳过
          break;
        default:
          // 可能是不带前缀的上下文行，忽略
          break;
      }
    }

    return {
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: lineChanges,
    };
  }
}
