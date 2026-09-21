/**
 * 终端报告渲染与 CI 门禁判定。
 */
import { languageOf } from './review.js';
import { SEVERITY_RANK } from './types.js';
import type { Finding, Severity } from './types.js';

/** 粘性评论的识别标记：更新而非新建全靠它 */
export const COMMENT_MARKER = '<!-- bounty-guard-report -->';

/** 各严重度的中文标签（终端、Markdown 与告警标注共用） */
export const LABELS: Record<Severity, string> = {
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示'
};

/** CI 门禁：任一告警达到 failOn 档即应非零退出 */
export function shouldFail(findings: Finding[], failOn: Severity): boolean {
  const threshold = SEVERITY_RANK[failOn];
  return findings.some((f) => SEVERITY_RANK[f.severity] >= threshold);
}

export interface ReportMeta {
  /** 扫描来源描述，如「git 未提交变更」 */
  source: string;
  scannedFiles: number;
  addedLines: number;
  /** LLM 复核汇总（未开启复核时缺省） */
  review?: { provider: string; confirmed: number; filtered: number; downgraded: number; unreviewed?: number };
}

/** 命中这些规则的片段在终端/Markdown 展示时做脱敏——扫描器绝不能成为泄露放大器 */
const REDACTED_RULE_IDS = new Set(['hardcoded-secret']);

/**
 * 片段脱敏（只对密钥类规则启用，宁可多遮不漏）：
 * ① 引号包裹、长度 ≥8 的字符串字面量 → 占位符；
 * ② 无引号的裸 token（≥16 位的密钥形字符串，常见于 LLM 复核建议转述）→ 占位符。
 */
export function redactSnippet(ruleId: string, text: string): string {
  if (!REDACTED_RULE_IDS.has(ruleId)) return text;
  return text
    .replace(/(["'`])[\s\S]{8,}?\1/g, (m) => `${m[0]}***（已脱敏）***${m[0]}`)
    .replace(/\b[A-Za-z0-9_+=/.~-]{16,}\b/g, '***（已脱敏）***');
}

/** 渲染中文终端报告，按文件分组 */
export function renderReport(findings: Finding[], meta: ReportMeta): string {
  const out: string[] = [];
  out.push('bounty-guard 扫描报告');
  out.push(`来源：${meta.source} ｜ 扫描文件 ${meta.scannedFiles} 个 ｜ 新增行 ${meta.addedLines} 行`);
  if (meta.review) {
    const r = meta.review;
    out.push(
      `LLM 复核（${r.provider}）：确认 ${r.confirmed} · 误报过滤 ${r.filtered} · 严重度下调 ${r.downgraded}${r.unreviewed ? ` · 未复核 ${r.unreviewed}（保留规则原判）` : ''}`
    );
  }
  out.push('');

  if (findings.length === 0) {
    out.push('✅ 未发现问题');
  } else {
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = byFile.get(f.file);
      if (list) list.push(f);
      else byFile.set(f.file, [f]);
    }
    for (const [file, list] of byFile) {
      out.push(file);
      for (const f of list) {
        const suffix = f.review
          ? f.review.verdict === 'unsure'
            ? ' · LLM 未能确证，保留原判'
            : f.review.severity
              ? ' · 严重度经复核下调'
              : ''
          : '';
        out.push(`  [${LABELS[f.severity]}] ${f.ruleId} · 第 ${f.line} 行${suffix}`);
        out.push(`    ${redactSnippet(f.ruleId, f.snippet.trim())}`);
        out.push(`    ⚠ ${f.message}`);
        if (f.review?.fixSuggestion) out.push(`    💡 修复建议（复核）：${redactSnippet(f.ruleId, f.review.fixSuggestion)}`);
        else if (f.fixHint) out.push(`    💡 ${f.fixHint}`);
      }
      out.push('');
    }
  }

  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  out.push(`汇总：高危 ${count('high')} · 中危 ${count('medium')} · 低危 ${count('low')} · 提示 ${count('info')}`);
  return out.join('\n');
}

const MD_ICONS: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: '🔵' };

/** Markdown 版报告：PR 粘性评论与 Job Summary 共用 */
export function renderMarkdownReport(findings: Finding[], meta: ReportMeta): string {
  const out: string[] = [];
  out.push('## 🛡 bounty-guard 扫描报告');
  out.push('');
  out.push(`来源：${meta.source} ｜ 扫描文件 ${meta.scannedFiles} 个 ｜ 新增行 ${meta.addedLines} 行`);
  if (meta.review) {
    const r = meta.review;
    out.push('');
    out.push(
      `**LLM 复核（${r.provider}）**：确认 ${r.confirmed} · 误报过滤 ${r.filtered} · 严重度下调 ${r.downgraded}${r.unreviewed ? ` · 未复核 ${r.unreviewed}（保留规则原判）` : ''}`
    );
  }
  out.push('');
  if (findings.length === 0) {
    out.push('✅ **未发现安全问题**');
  } else {
    const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
    out.push(
      `发现 **${findings.length}** 个问题：${LABELS.high} ${count('high')} · ${LABELS.medium} ${count('medium')} · ${LABELS.low} ${count('low')} · ${LABELS.info} ${count('info')}`
    );
    out.push('');
    for (const f of findings) {
      out.push(`### ${MD_ICONS[f.severity]} \`${f.file}:${f.line}\` — ${LABELS[f.severity]} · \`${f.ruleId}\``);
      out.push('');
      // 代码块围栏升级：片段本身含三反引号时用四反引号包裹
      const fence = f.snippet.includes('```') ? '````' : '```';
      const lang = languageOf(f.file);
      out.push(fence + (lang === 'unknown' ? '' : lang));
      out.push(redactSnippet(f.ruleId, f.snippet));
      out.push(fence);
      out.push('');
      out.push(`- ⚠️ ${f.message}`);
      if (f.review?.fixSuggestion) out.push(`- 💡 复核建议：${redactSnippet(f.ruleId, f.review.fixSuggestion)}`);
      else if (f.fixHint) out.push(`- 💡 ${f.fixHint}`);
      if (f.review?.verdict === 'unsure') out.push('- ❓ LLM 未能确证，保留原判');
      out.push('');
    }
  }
  out.push('---');
  out.push(
    `<sub>🤖 由 <a href="https://github.com/Croesus-K/bounty-guard">bounty-guard</a> 自动生成 · 规则初筛${meta.review ? ' + LLM 复核' : ''} · 粘性评论，重复扫描只更新本条</sub>`
  );
  out.push('');
  out.push(COMMENT_MARKER);
  return out.join('\n');
}

/** SARIF 级别映射：high → error，medium → warning，low/info → note */function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  return severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'note';
}

/** SARIF 2.1.0 输出：可直接对接 GitHub code-scanning（actions/upload-sarif） */
export function renderSarif(
  findings: Finding[],
  meta: Pick<ReportMeta, 'source' | 'scannedFiles' | 'addedLines'>
): Record<string, unknown> {
  const rules = new Map<
    string,
    { id: string; shortDescription: { text: string }; defaultConfiguration: { level: string } }
  >();
  const results = findings.map((f) => {
    if (!rules.has(f.ruleId)) {
      rules.set(f.ruleId, {
        id: f.ruleId,
        shortDescription: { text: f.message },
        defaultConfiguration: { level: sarifLevel(f.severity) }
      });
    }
    return {
      ruleId: f.ruleId,
      level: sarifLevel(f.severity),
      message: { text: f.review?.fixSuggestion ? `${f.message}。${f.review.fixSuggestion}` : f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file.replace(/\\/g, '/') },
            region: { startLine: f.line }
          }
        }
      ]
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'bounty-guard',
            informationUri: 'https://github.com/Croesus-K/bounty-guard',
            rules: [...rules.values()]
          }
        },
        results,
        properties: { source: meta.source, scannedFiles: meta.scannedFiles, addedLines: meta.addedLines }
      }
    ]
  };
}

export interface MetricsRow {
  pr: string;
  addedLines: number;
  findings: string[];
}

/** 周报表格：配合 scripts/weekly-report.ts 定时生成 docs/metrics.md；failures 为扫描失败被跳过的样本 */
export function renderMetricsTable(rows: MetricsRow[], date: string, failures: string[] = []): string {
  const totalAdded = rows.reduce((n, r) => n + r.addedLines, 0);
  const totalFindings = rows.reduce((n, r) => n + r.findings.length, 0);
  const out = [
    '# 误报率周报',
    '',
    `> 自动生成于 ${date} · 来源清单 \`scripts/metrics-prs.txt\` · 样本 ${rows.length} 个真实 PR`,
    '',
    '| 指标 | 数值 |',
    '|---|---|',
    `| 新增行 | ${totalAdded} |`,
    `| 命中 | ${totalFindings} |`,
    '',
    '| PR | 新增行 | 命中 |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.pr} | ${r.addedLines} | ${r.findings.length === 0 ? '0' : r.findings.join('<br>')} |`),
    ''
  ];
  if (failures.length > 0) {
    out.push(`> ⚠ 本周跳过 ${failures.length} 个无法扫描的样本：`);
    for (const f of failures) out.push(`> - ${f}`);
    out.push('');
  }
  out.push('<sub>由 bounty-guard 自动生成，每周五更新</sub>', '');
  return out.join('\n');
}
