/**
 * pre-commit 钩子形态：把 bounty-guard 装进开发者本地 git 提交流程。
 * 生成的钩子提交前自动扫描未提交（或已暂存）变更，发现门禁级问题即
 * 以非零码退出、阻断提交；单次跳过用 BOUNTY_GUARD_SKIP=1。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOOK_MARKER = '由 bounty-guard 生成';

export interface PreCommitHookOptions {
  /** 门禁等级（high | medium | low | info） */
  failOn: string;
  /** 只扫描已暂存变更（pre-commit 的标准姿势） */
  staged: boolean;
  /** 跳过开关的环境变量名，默认 BOUNTY_GUARD_SKIP */
  skipEnv?: string;
}

export function renderPreCommitHook(options: PreCommitHookOptions): string {
  const skipEnv = options.skipEnv ?? 'BOUNTY_GUARD_SKIP';
  const stagedFlag = options.staged ? ' --staged' : '';
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER}（bounty-guard init-hooks）—— 更新请重新执行 init-hooks --force`,
    `[ -n "$${skipEnv}" ] && exit 0`,
    '# 预检：目标仓库没装 bounty-guard 时明确提示并放行，不让提交卡死在 npm 报错上',
    'if ! npx --no-install bounty-guard --version >/dev/null 2>&1; then',
    '  echo "bounty-guard 未安装（在仓库内运行 npm i -D bounty-guard 或 npx bounty-guard init-hooks），本次提交跳过扫描" >&2',
    '  exit 0',
    'fi',
    `npx --no-install bounty-guard scan --git${stagedFlag} --fail-on ${options.failOn}`,
    ''
  ].join('\n');
}

/** 安装 pre-commit 钩子到指定 git 目录；已存在非本工具生成的钩子时拒绝（--force 可覆盖） */
export function installPreCommitHook(
  gitDir: string,
  options: PreCommitHookOptions,
  force = false
): string {
  const path = join(gitDir, 'hooks', 'pre-commit');
  mkdirSync(join(gitDir, 'hooks'), { recursive: true }); // 全新临时仓库可能没有 hooks 目录
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.includes(HOOK_MARKER) && !force) {
      throw new Error(`已存在非 bounty-guard 生成的 pre-commit 钩子：${path}（确认覆盖请加 --force）`);
    }
  }
  writeFileSync(path, renderPreCommitHook(options));
  chmodSync(path, 0o755);
  return path;
}

/** 移除由 bounty-guard 生成的钩子；不存在或不属于本工具时返回 false */
export function uninstallPreCommitHook(gitDir: string): boolean {
  const path = join(gitDir, 'hooks', 'pre-commit');
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, 'utf8');
  if (!existing.includes(HOOK_MARKER)) return false;
  rmSync(path);
  return true;
}
