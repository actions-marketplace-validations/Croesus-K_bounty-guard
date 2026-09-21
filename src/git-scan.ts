/**
 * git 扫描来源：把「未提交 / 已暂存变更」组装成 ParsedDiff。
 * CLI、MCP 服务器等形态共用的采集层。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseDiff, unquoteGitPath, type DiffLine, type ParsedDiff, type ParsedFile } from './diff.js';

/** 以子进程运行 git（参数列表形式，不经 shell），非零退出时以 stderr 文本抛错 */
export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr.trim() || `git 以退出码 ${code ?? '未知'} 异常结束`));
    });
  });
}

/**
 * diff 读取加固：禁用外部 diff 工具与 ANSI 着色。
 * 用户配置 diff.external 或 color.ui=always 时，输出会混入非标准内容导致解析错乱。
 */
export const GIT_DIFF_FLAGS = ['--no-ext-diff', '--no-color'] as const;

/** 未跟踪文件 → 整文件皆视为新增行 */
function fileToParsedFile(path: string, content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const diffLines: DiffLine[] = lines.map((content, i) => ({ type: 'add', content, newLine: i + 1 }));
  return {
    path,
    isBinary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: diffLines.length, lines: diffLines }]
  };
}

/** 组装「未提交变更」：git diff HEAD（首次提交前回退索引对比）+ 未跟踪文件 */
export async function collectGitChanges(cwd: string): Promise<ParsedDiff> {
  let text: string;
  try {
    text = await runGit(['diff', ...GIT_DIFF_FLAGS, 'HEAD'], cwd);
  } catch {
    // 尚无首次提交时 HEAD 不存在，改用索引对比（新仓库的变更通常已暂存）
    text = await runGit(['diff', ...GIT_DIFF_FLAGS, '--cached'], cwd);
  }
  const parsed = parseDiff(text);
  const status = await runGit(['status', '--porcelain', '-uall'], cwd);
  for (const line of status.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    const file = unquoteGitPath(line.slice(3));
    if (!file || file.endsWith('/')) continue;
    let content: string;
    try {
      content = readFileSync(`${cwd}/${file}`, 'utf8');
    } catch {
      continue; // 读不到（权限/编码）就放过，宁漏报不崩溃
    }
    if (content.includes('\u0000')) continue; // 二进制内容跳过
    parsed.files.push(fileToParsedFile(file, content));
  }
  return parsed;
}

/** 组装「已暂存变更」：git diff --cached（pre-commit 场景，不含未跟踪文件） */
export async function collectStagedChanges(cwd: string): Promise<ParsedDiff> {
  return parseDiff(await runGit(['diff', ...GIT_DIFF_FLAGS, '--cached'], cwd));
}
