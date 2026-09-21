#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import type { BountyConfig } from './config.js';
import { loadConfig } from './config.js';
import { readEnv, startGhAppServer } from './app/server.js';
import { checkAi, checkConfig, checkConfigError, checkGit, checkNodeVersion, hasFailure, renderChecks, type Check } from './doctor.js';
import { parseDiff, type ParsedDiff } from './diff.js';
import {
  collectGitChanges,
  collectStagedChanges,
  runGit
} from './git-scan.js';
import {
  fetchPrDiff,
  parseRepoSlug,
  resolvePrNumber,
  toAnnotations,
  upsertStickyComment,
  writeSummaryFile
} from './github.js';
import { matchGlob } from './glob.js';
import { installPreCommitHook, uninstallPreCommitHook } from './hooks.js';
import { loadProvider } from './llm/provider.js';
import { startMcpServer } from './mcp/server.js';
import { renderMarkdownReport, renderReport, renderSarif, shouldFail, type ReportMeta } from './report.js';
import { reviewFindings } from './review.js';
import { scanDiff } from './scanner.js';
import { SEVERITIES, type Finding, type Severity } from './types.js';

const require = createRequire(import.meta.url);
const VERSION: string = require('../package.json').version;

const USAGE_HINT = '请指定扫描来源：--git（扫描未提交变更）或 --diff <file>（扫描 diff 文件）';
const FORMATS: readonly string[] = ['text', 'sarif', 'json'];

/** 用法类错误：输出友好提示并以退出码 2 结束 */
class UsageError extends Error {}

/** 校验 --fail-on 取值；无值时回退配置文件 */
function resolveFailOn(config: BountyConfig, value?: string): Severity {
  if (!value) return config.failOn;
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new UsageError(`--fail-on 取值无效：${value}（可选 ${SEVERITIES.join(' | ')}）`);
  }
  return value as Severity;
}

/** 把「扫描来源 + 配置 + 可选 AI 复核」组装为一次完整扫描（scan / MCP / 各形态共用） */

interface ScanOutcome {
  findings: Finding[];
  scannedFiles: number;
  addedLines: number;
  review?: ReportMeta['review'];
}

/** 解析并扫描 diff，按需执行 LLM 复核（scan 与 pr-comment 共用）。
 * upgradeOff：--ai 显式启用时把 provider=off 升级为 openai-compatible；
 * 仅配置启用时保持用户配置（off 仍是纯规则）。 */
async function scanAndReview(
  diff: ParsedDiff,
  config: BountyConfig,
  wantAi: boolean,
  upgradeOff: boolean
): Promise<ScanOutcome> {
  let findings = scanDiff(diff, {
    ignore: config.ignore,
    skipTests: !config.scanTests,
    disabledRules: config.disabledRules
  });
  const scannable = diff.files.filter((f) => !f.isBinary && !matchGlob(f.path, config.ignore));
  const addedLines = scannable.reduce(
    (sum, f) => sum + f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0),
    0
  );

  let review: ReportMeta['review'];
  if (wantAi) {
    const effective =
      upgradeOff && config.ai.provider === 'off'
        ? { ...config, ai: { ...config.ai, enabled: true, provider: 'openai-compatible' as const } }
        : config;
    const loaded = loadProvider(effective);
    if (loaded.degraded) {
      console.log(`ℹ️ ${loaded.reason}\n`);
    } else {
        const outcome = await reviewFindings(findings, loaded.provider);
        findings = outcome.findings;
        review = {
          provider: loaded.provider.name,
          confirmed: outcome.findings.length,
          filtered: outcome.filtered,
          downgraded: outcome.downgraded,
          unreviewed: outcome.unreviewed
        };
    }
  }
  return { findings, scannedFiles: scannable.length, addedLines, review };
}

const program = new Command();

program
  .name('bounty-guard')
  .description('AI 代码安全审查助手 —— 规则引擎初筛 + LLM 复核，守住每一行 diff')
  .version(VERSION);

program
  .command('scan')
  .description('扫描代码变更中的安全问题（规则初筛；LLM 复核可选）')
  .option('--git', '扫描当前仓库的未提交变更')
  .option('--staged', '只扫描已暂存变更（需搭配 --git；pre-commit 场景）')
  .option('--diff <file>', '从 unified diff 文件扫描')
  .option('--ai', '启用 LLM 复核（无 API Key 时自动降级为纯规则模式）')
  .option('--fail-on <severity>', '门禁等级：high | medium | low | info（覆盖配置文件）')
  .option('-f, --format <fmt>', '输出格式：text | sarif | json（默认 text）')
  .action(async (options: { git?: boolean; staged?: boolean; diff?: string; ai?: boolean; failOn?: string; format?: string }) => {
    try {
      if (!options.git && !options.diff) throw new UsageError(USAGE_HINT);
      if (options.git && options.diff) throw new UsageError('两种扫描来源互斥，只能二选一');
      if (options.staged && !options.git) throw new UsageError('--staged 需要与 --git 搭配使用');
      const format = options.format ?? 'text';
      if (!(FORMATS as readonly string[]).includes(format)) {
        throw new UsageError(`--format 取值无效：${format}（可选 ${FORMATS.join(' | ')}）`);
      }
      const config = loadConfig();
      const failOn = resolveFailOn(config, options.failOn);

      const cwd = process.cwd();
      let diff: ParsedDiff;
      let source: string;
      try {
        if (options.diff) {
          diff = parseDiff(readFileSync(options.diff, 'utf8'));
          source = `diff 文件 ${options.diff}`;
        } else if (options.staged) {
          diff = await collectStagedChanges(cwd);
          source = 'git 已暂存变更';
        } else {
          diff = await collectGitChanges(cwd);
          source = 'git 未提交变更';
        }
      } catch (err) {
        throw new UsageError(`获取扫描来源失败：${err instanceof Error ? err.message : String(err)}`);
      }

      const outcome = await scanAndReview(diff, config, Boolean(options.ai), Boolean(options.ai));
      const meta = {
        source,
        scannedFiles: outcome.scannedFiles,
        addedLines: outcome.addedLines,
        review: outcome.review
      };
      if (format === 'sarif') {
        console.log(JSON.stringify(renderSarif(outcome.findings, meta), null, 2));
      } else if (format === 'json') {
        console.log(JSON.stringify({ ...meta, findings: outcome.findings }, null, 2));
      } else {
        console.log(renderReport(outcome.findings, meta));
      }
      process.exitCode = shouldFail(outcome.findings, failOn) ? 1 : 0;
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  });

program
  .command('pr-comment')
  .description('扫描 GitHub PR 并发布/更新粘性评论（供 Action 调用）')
  .option('--pr <number>', 'PR 编号（缺省从 GITHUB_PR_NUMBER / GITHUB_REF 推断）')
  .option('--repo <slug>', '仓库 owner/name（缺省 GITHUB_REPOSITORY）')
  .option('--fail-on <severity>', '门禁等级：high | medium | low | info（覆盖配置文件）')
  .option('--ai', '启用 LLM 复核（无 API Key 时自动降级为纯规则模式）')
  .option('--annotations', '输出 Actions 告警标注（::error/::warning）')
  .option('--summary', '把 Markdown 报告写入暂存文件，供 Action 步骤追加到 Job Summary')
  .action(async (options: { pr?: string; repo?: string; failOn?: string; ai?: boolean; annotations?: boolean; summary?: boolean }) => {
    try {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new UsageError('缺少 GITHUB_TOKEN 环境变量');
      const repoInput = options.repo ?? process.env.GITHUB_REPOSITORY;
      if (!repoInput) throw new UsageError('无法确定仓库：用 --repo owner/name 或设置 GITHUB_REPOSITORY');
      let repo: string;
      try {
        const { owner, name } = parseRepoSlug(repoInput);
        repo = `${owner}/${name}`;
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      const prNumber = resolvePrNumber(options.pr);
      if (!prNumber) throw new UsageError('无法确定 PR 编号：用 --pr <n> 或在 pull_request 事件中运行');
      const config = loadConfig();
      const failOn = resolveFailOn(config, options.failOn);

      const ctx = { token, repo };
      let diffText: string;
      try {
        diffText = await fetchPrDiff(ctx, prNumber);
      } catch (err) {
        throw new UsageError(`读取 PR #${prNumber} diff 失败：${err instanceof Error ? err.message : String(err)}`);
      }
      const outcome = await scanAndReview(parseDiff(diffText), config, Boolean(options.ai), Boolean(options.ai));
      const markdown = renderMarkdownReport(outcome.findings, {
        source: `PR #${prNumber}（${repo}）`,
        scannedFiles: outcome.scannedFiles,
        addedLines: outcome.addedLines,
        review: outcome.review
      });
      let result: 'created' | 'updated';
      try {
        result = await upsertStickyComment(ctx, prNumber, markdown);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/HTTP 403/.test(msg)) {
          throw new UsageError(
            `发布评论失败：${msg}。常见原因：fork PR 的默认令牌为只读（可改用 PAT），或 workflow 缺少 pull-requests: write 权限`
          );
        }
        throw err;
      }
      console.log(`✅ 已${result === 'created' ? '创建' : '更新'} PR #${prNumber} 的粘性评论`);
      if (options.annotations) for (const line of toAnnotations(outcome.findings)) console.log(line);
      if (options.summary) console.log(`📄 Job Summary 内容已写入 ${writeSummaryFile(markdown)}`);
      process.exitCode = shouldFail(outcome.findings, failOn) ? 1 : 0;
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  });

const aiProbe = async (baseUrl: string, apiKey: string): Promise<Omit<Check, 'name'>> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const res = await fetch(new URL('models', base), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) return { status: 'ok', detail: `模型服务连通（${base}models）` };
    if (res.status === 401) return { status: 'fail', detail: 'API Key 无效（401）' };
    if (res.status === 404) {
      return { status: 'warn', detail: '端点未提供 /models，无法自动验证——可跑一次 --ai 实测' };
    }
    return { status: 'warn', detail: `HTTP ${res.status}（不影响使用，仅无法自动验证）` };
  } catch (err) {
    return { status: 'fail', detail: `无法连接模型服务：${err instanceof Error ? err.message : String(err)}` };
  }
};

program
  .command('doctor')
  .description('体检配置与环境（Node / Git / 配置文件 / AI 供应商连通性）')
  .option('--json', '以 JSON 输出检查结果')
  .action(async (options: { json?: boolean }) => {
    const checks: Check[] = [];
    checks.push(checkNodeVersion(process.versions.node));
    let gitVersion: string | null = null;
    let isRepo = false;
    try {
      const cwd = process.cwd();
      gitVersion = (await runGit(['--version'], cwd)).trim().replace(/^git version /, '');
      isRepo = (await runGit(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true';
    } catch {
      gitVersion = null;
    }
    checks.push(checkGit(gitVersion, isRepo));
    let config: BountyConfig | undefined;
    try {
      config = loadConfig();
      checks.push(checkConfig(config));
    } catch (err) {
      checks.push(checkConfigError(err));
    }
    try {
      const loaded = loadProvider(config ?? loadConfig());
      checks.push(await checkAi(loaded, aiProbe));
    } catch (err) {
      checks.push({
        name: 'AI 复核',
        status: 'warn',
        detail: `跳过：${err instanceof Error ? err.message : String(err)}`
      });
    }
    if (options.json) {
      console.log(JSON.stringify({ ok: !hasFailure(checks), checks }, null, 2));
    } else {
      console.log('bounty-guard doctor 体检报告\n');
      console.log(renderChecks(checks));
      console.log('');
      console.log(hasFailure(checks) ? '✗ 存在需要处理的问题' : '✓ 环境就绪');
    }
    process.exitCode = hasFailure(checks) ? 1 : 0;
  });

program
  .command('init-hooks')
  .description('在当前仓库安装 pre-commit 钩子（提交前自动扫描）')
  .option('--fail-on <severity>', '门禁等级：high | medium | low | info（默认取配置文件）')
  .option('--staged', '只扫描已暂存变更（pre-commit 标准姿势）')
  .option('--force', '覆盖已存在的钩子文件')
  .option('--uninstall', '移除由 bounty-guard 生成的钩子')
  .action(async (options: { failOn?: string; staged?: boolean; force?: boolean; uninstall?: boolean }) => {
    try {
      const cwd = process.cwd();
      let gitDir: string;
      try {
        gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], cwd)).trim();
      } catch {
        throw new UsageError('当前目录不在 git 仓库中，无法安装钩子');
      }
      if (options.uninstall) {
        const removed = uninstallPreCommitHook(gitDir);
        console.log(removed ? '✅ 已移除 bounty-guard 生成的 pre-commit 钩子' : 'ℹ️ 未发现 bounty-guard 生成的钩子');
        return;
      }
      const config = loadConfig();
      const failOn = resolveFailOn(config, options.failOn);
      const path = installPreCommitHook(
        gitDir,
        { failOn, staged: Boolean(options.staged) },
        Boolean(options.force)
      );
      console.log(`✅ pre-commit 钩子已安装：${path}`);
      console.log(
        `   提交前将自动扫描（--fail-on ${failOn}${options.staged ? ' --staged' : ''}）；临时跳过单次提交：BOUNTY_GUARD_SKIP=1 git commit ...`
      );
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  });

program
  .command('mcp')
  .description('以 MCP stdio 服务器运行（供 AI 编程助手作为工具接入）')
  .action(() => {
    // stdout 保留给协议消息；startMcpServer 内部日志全部走 stderr
    startMcpServer();
  });

program
  .command('gh-app')
  .description('以 GitHub App 自托管服务器运行（pull_request webhook 自动扫描评论）')
  .action(() => {
    try {
      startGhAppServer(readEnv(), loadConfig());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    }
  });

// 顶层兜底：UsageError 之外的一切异常收敛为一句错误 + 退出码 1，不裸栈刷屏
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`bounty-guard 异常退出：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
