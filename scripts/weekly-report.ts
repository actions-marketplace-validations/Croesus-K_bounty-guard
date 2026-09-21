/**
 * 每周误报率周报：读取 scripts/metrics-prs.txt（每行 owner/repo#N），
 * 并发试扫后生成 docs/metrics.md——由 .github/workflows/metrics.yml 每周五定时触发。
 * 用法：GITHUB_TOKEN=xxx npx tsx scripts/weekly-report.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDiff } from '../src/diff.js';
import { fetchPrDiff, parseRepoSlug, type GithubContext } from '../src/github.js';
import { renderMetricsTable } from '../src/report.js';
import { scanDiff } from '../src/scanner.js';

const token = process.env.GITHUB_TOKEN ?? process.env.BOUNTY_GUARD_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  process.exit(2);
}

const LIST_FILE = 'scripts/metrics-prs.txt';
const OUT_FILE = 'docs/metrics.md';
const IGNORE = [
  'node_modules/**',
  'dist/**',
  'coverage/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock'
];

const prs = readFileSync(LIST_FILE, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s !== '' && !s.startsWith('#'));
if (prs.length === 0) {
  console.error('清单为空');
  process.exit(2);
}

interface Row {
  pr: string;
  addedLines: number;
  findings: string[];
}

try {
  const settled = await Promise.allSettled(
    prs.map(async (arg) => {
      const parsed = arg.match(/^(.+)#(\d+)$/);
      if (!parsed) throw new Error(`无法解析 PR 标识：${arg}`);
      const [, repoInput, pr] = parsed;
      const { owner, name } = parseRepoSlug(repoInput);
      const ctx: GithubContext = { token, repo: `${owner}/${name}` };
      const diff = parseDiff(await fetchPrDiff(ctx, Number(pr)));
      const findings = scanDiff(diff, { ignore: IGNORE });
      const addedLines = diff.files.reduce(
        (n, f) => n + f.hunks.reduce((k, h) => k + h.lines.filter((l) => l.type === 'add').length, 0),
        0
      );
      console.error(`已扫 ${arg}：${findings.length} 条命中`);
      return {
        pr: arg,
        addedLines,
        findings: findings.map((f) => `${f.severity}/${f.ruleId}/${f.file}:${f.line}`)
      };
    })
  );

  // 单个样本被删/转私不拖垮全周报告：成功的照常入表，失败的列进注记
  const rows: Row[] = [];
  const failures: string[] = [];
  for (const [i, item] of settled.entries()) {
    if (item.status === 'fulfilled') {
      rows.push(item.value);
    } else {
      const reason = item.reason instanceof Error ? item.reason.message : String(item.reason);
      failures.push(`${prs[i]}：${reason}`);
      console.error(`⚠ 跳过 ${prs[i]}：${reason}`);
    }
  }
  if (rows.length === 0) {
    console.error('全部样本扫描失败，未生成周报');
    process.exit(2);
  }

  const date = new Date().toISOString().slice(0, 10);
  const markdown = renderMetricsTable(rows, date, failures);
  writeFileSync(OUT_FILE, markdown);
  const totalFindings = rows.reduce((n, r) => n + r.findings.length, 0);
  const skipped = failures.length > 0 ? ` / 跳过 ${failures.length}` : '';
  console.log(`✅ 已生成 ${OUT_FILE}（${rows.length} PR${skipped} / 命中 ${totalFindings}）`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
