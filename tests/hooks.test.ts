import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_MARKER, installPreCommitHook, renderPreCommitHook, uninstallPreCommitHook } from '../src/hooks.js';

describe('renderPreCommitHook', () => {
  it('包含跳过开关、扫描命令与门禁等级', () => {
    const hook = renderPreCommitHook({ failOn: 'medium', staged: false });
    expect(hook).toContain('#!/bin/sh');
    expect(hook).toContain('BOUNTY_GUARD_SKIP');
    expect(hook).toContain('npx --no-install bounty-guard scan --git --fail-on medium');
    expect(hook).not.toContain('--staged');
    expect(hook).toContain(HOOK_MARKER);
  });

  it('staged 模式带 --staged 标记', () => {
    expect(renderPreCommitHook({ failOn: 'high', staged: true })).toContain('scan --git --staged --fail-on high');
  });

  it('内置包未安装预检：提示后放行而不是卡死提交', () => {
    const hook = renderPreCommitHook({ failOn: 'high', staged: true });
    expect(hook).toContain('npx --no-install bounty-guard --version >/dev/null 2>&1');
    expect(hook).toContain('本次提交跳过扫描');
    // 预检在扫描命令之前
    expect(hook.indexOf('--version')).toBeLessThan(hook.indexOf('scan --git'));
  });
});

describe('installPreCommitHook / uninstallPreCommitHook', () => {
  it('安装到 gitDir/hooks/pre-commit 并可卸载', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'bg-hooks-'));
    try {
      const path = installPreCommitHook(gitDir, { failOn: 'high', staged: false });
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(HOOK_MARKER);
      expect(uninstallPreCommitHook(gitDir)).toBe(true);
      expect(() => readFileSync(path)).toThrow();
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it('已存在非 bounty-guard 钩子时拒绝覆盖，--force 可覆盖', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'bg-hooks-'));
    try {
      installPreCommitHook(gitDir, { failOn: 'high', staged: false }); // 先建 hooks 目录
      const path = join(gitDir, 'hooks', 'pre-commit');
      writeFileSync(path, '#!/bin/sh\necho foreign\n'); // 构造非本工具的既有钩子
      expect(() => installPreCommitHook(gitDir, { failOn: 'high', staged: false })).toThrow(/--force/);
      expect(installPreCommitHook(gitDir, { failOn: 'high', staged: false }, true)).toBe(path);
      expect(readFileSync(path, 'utf8')).toContain(HOOK_MARKER);
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it('uninstall 对非 bounty-guard 钩子不动作', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'bg-hooks-'));
    try {
      installPreCommitHook(gitDir, { failOn: 'high', staged: false });
      const path = join(gitDir, 'hooks', 'pre-commit');
      writeFileSync(path, '#!/bin/sh\necho foreign\n');
      expect(uninstallPreCommitHook(gitDir)).toBe(false);
      expect(readFileSync(path, 'utf8')).toContain('foreign');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });
});
