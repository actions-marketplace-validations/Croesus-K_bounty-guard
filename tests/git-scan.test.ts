import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectGitChanges, collectStagedChanges, GIT_DIFF_FLAGS, runGit } from '../src/git-scan.js';

/** 建一个带污染配置的临时仓库：ANSI 着色强制开启 + 外部 diff 工具指向必败命令 */
const dir = mkdtempSync(join(tmpdir(), 'bg-gitscan-'));
const git = (args: string[]): void => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
};

git(['init', '--quiet']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'test']);
git(['config', 'color.ui', 'always']);
git(['config', 'diff.external', 'definitely-not-a-real-diff-tool']);

writeFileSync(join(dir, 'vuln.js'), 'el.innerHTML = "<b>" + name;\n');
git(['add', 'vuln.js']);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('git diff 采集加固（--no-ext-diff --no-color）', () => {
  it('导出的加固 flag 齐全', () => {
    expect([...GIT_DIFF_FLAGS]).toEqual(['--no-ext-diff', '--no-color']);
  });

  it('color.ui=always + diff.external 配置下，已暂存采集仍输出干净标准 diff', async () => {
    const parsed = await collectStagedChanges(dir);
    const file = parsed.files.find((f) => f.path === 'vuln.js');
    expect(file).toBeDefined();
    const allText = file!.hunks.flatMap((h) => h.lines.map((l) => l.content)).join('\n');
    expect(allText).not.toContain('\u001b['); // 无 ANSI 转义
    expect(allText).toContain('el.innerHTML');
  });

  it('未提交变更采集同样干净（含未跟踪文件路径）', async () => {
    writeFileSync(join(dir, 'extra.js'), 'eval(userInput);\n');
    const parsed = await collectGitChanges(dir);
    const paths = parsed.files.map((f) => f.path);
    expect(paths).toContain('extra.js');
    for (const f of parsed.files) {
      for (const h of f.hunks) {
        for (const l of h.lines) expect(l.content).not.toContain('\u001b[');
      }
    }
  });

  it('runGit 在非仓库目录仍可用（--version 等纯命令）', async () => {
    const version = await runGit(['--version'], dir);
    expect(version).toContain('git version');
  });
});
