/**
 * Ecode Local 配置常量
 *
 * 存放不可通过 VSCode 设置变更的固定配置值。
 * 用户可配置的选项仍在 package.json contributes.configuration 中定义。
 */

/** 本地同步目录（相对于工作区根目录，固定值） */
export const LOCAL_SYNC_DIR = 'ecode';

/** git 基线分支名 */
export const MAIN_BRANCH = 'main';

/** 单文件行级别 diff 最大输出行数（变更行 + 上下文行），超出则截断 */
export const DIFF_MAX_LINES_PER_FILE = 30;
