import { describe, expect, it } from 'vitest';
import {
  redactSnippet,
  renderMarkdownReport,
  renderMetricsTable,
  renderReport,
  renderSarif,
  shouldFail
} from '../src/report.js';
import type { Finding, Severity } from '../src/types.js';

function finding(severity: Severity, file = 'src/a.js', line = 3): Finding {
  return {
    ruleId: 'r-1',
    severity,
    file,
    line,
    snippet: 'const x = bad();',
    message: '问题',
    fixHint: '建议'
  };
}

describe('renderReport', () => {
  it('包含来源、统计与命中的关键字段', () => {
    const text = renderReport([finding('high')], {
      source: 'git 未提交变更',
      scannedFiles: 2,
      addedLines: 10
    });
    expect(text).toContain('bounty-guard 扫描报告');
    expect(text).toContain('git 未提交变更');
    expect(text).toContain('扫描文件 2 个');
    expect(text).toContain('新增行 10 行');
    expect(text).toContain('src/a.js');
    expect(text).toContain('[高危]');
    expect(text).toContain('r-1');
    expect(text).toContain('第 3 行');
    expect(text).toContain('const x = bad();');
    expect(text).toContain('⚠ 问题');
    expect(text).toContain('💡 建议');
    expect(text).toContain('汇总：高危 1 · 中危 0 · 低危 0 · 提示 0');
  });

  it('无告警时输出未发现问题', () => {
    const text = renderReport([], { source: 'diff 文件 x.diff', scannedFiles: 1, addedLines: 5 });
    expect(text).toContain('✅ 未发现问题');
    expect(text).toContain('汇总：高危 0 · 中危 0 · 低危 0 · 提示 0');
  });

  it('按文件分组展示', () => {
    const text = renderReport([finding('low', 'a.js'), finding('info', 'b.js')], {
      source: 's',
      scannedFiles: 2,
      addedLines: 2
    });
    expect(text.indexOf('a.js')).toBeLessThan(text.indexOf('b.js'));
    expect(text).toContain('[低危]');
    expect(text).toContain('[提示]');
  });

  it('复核结果参与渲染：汇总行、下调标注与 LLM 修复建议优先', () => {
    const f = finding('medium');
    f.review = { verdict: 'confirmed', severity: 'low', explanation: '影响有限', fixSuggestion: '改用参数化查询' };
    const text = renderReport([f], {
      source: 's',
      scannedFiles: 1,
      addedLines: 1,
      review: { provider: 'openai-compatible:test-model', confirmed: 1, filtered: 2, downgraded: 1 }
    });
    expect(text).toContain('LLM 复核（openai-compatible:test-model）');
    expect(text).toContain('确认 1 · 误报过滤 2 · 严重度下调 1');
    expect(text).toContain('严重度经复核下调');
    expect(text).toContain('💡 修复建议（复核）：改用参数化查询');
  });

  it('未确证告警标注保留原判，无 LLM 建议时回退规则提示', () => {
    const f = finding('high');
    f.review = { verdict: 'unsure', explanation: '证据不足' };
    const text = renderReport([f], { source: 's', scannedFiles: 1, addedLines: 1 });
    expect(text).toContain('LLM 未能确证，保留原判');
    expect(text).toContain('💡 建议');
  });

  it('复核汇总可携带未复核计数', () => {
    const text = renderReport([], {
      source: 's',
      scannedFiles: 0,
      addedLines: 0,
      review: { provider: 'p', confirmed: 0, filtered: 0, downgraded: 0, unreviewed: 3 }
    });
    expect(text).toContain('未复核 3（保留规则原判）');
  });
});

describe('renderMarkdownReport', () => {
  it('包含标题、统计、发现详情与粘性标记', () => {
    const f = finding('high');
    f.review = { verdict: 'confirmed', severity: 'medium', explanation: '影响可控', fixSuggestion: '改用 textContent' };
    const text = renderMarkdownReport([f], {
      source: 'PR #7（o/r）',
      scannedFiles: 2,
      addedLines: 9,
      review: { provider: 'openai-compatible:m', confirmed: 1, filtered: 1, downgraded: 1 }
    });
    expect(text).toContain('## 🛡 bounty-guard 扫描报告');
    expect(text).toContain('PR #7（o/r）');
    expect(text).toContain('**LLM 复核（openai-compatible:m）**：确认 1 · 误报过滤 1 · 严重度下调 1');
    expect(text).toContain('🔴 `src/a.js:3`');
    expect(text).toContain('```javascript');
    expect(text).toContain('const x = bad();');
    expect(text).toContain('- 💡 复核建议：改用 textContent');
    expect(text).toContain('粘性评论');
    expect(text).toContain('<!-- bounty-guard-report -->');
  });

  it('无告警时输出未发现问题；片段含围栏时升级为四反引号', () => {
    const empty = renderMarkdownReport([], { source: 's', scannedFiles: 1, addedLines: 1 });
    expect(empty).toContain('✅ **未发现安全问题**');
    const f = finding('low');
    f.snippet = 'const s = ```; // 含围栏的行';
    const text = renderMarkdownReport([f], { source: 's', scannedFiles: 1, addedLines: 1 });
    expect(text).toContain('````');
  });
});

describe('renderSarif', () => {
  it('输出 SARIF 2.1.0 结构：工具、规则去重、位置与级别映射', () => {
    const f1 = finding('high');
    const f2 = finding('high', 'src/a.js', 9);
    const f3 = finding('low');
    f3.ruleId = 'r-2';
    const sarif = renderSarif([f1, f2, f3], {
      source: 's',
      scannedFiles: 2,
      addedLines: 3
    }) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          level: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
        }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('bounty-guard');
    expect(sarif.runs[0].tool.driver.rules.map((r) => r.id)).toEqual(['r-1', 'r-2']);
    expect(sarif.runs[0].results).toHaveLength(3);
    expect(sarif.runs[0].results[0].level).toBe('error');
    expect(sarif.runs[0].results[2].level).toBe('note');
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(3);
  });
});

describe('renderMetricsTable', () => {
  it('生成周报表格：汇总、明细与生成日期', () => {
    const text = renderMetricsTable(
      [
        { pr: 'expressjs/express#7437', addedLines: 400, findings: [] },
        { pr: 'axios/axios#11175', addedLines: 120, findings: ['low/plain-http/src/a.js:3'] }
      ],
      '2026-08-31'
    );
    expect(text).toContain('# 误报率周报');
    expect(text).toContain('自动生成于 2026-08-31');
    expect(text).toContain('| 新增行 | 520 |');
    expect(text).toContain('| 命中 | 1 |');
    expect(text).toContain('| expressjs/express#7437 | 400 | 0 |');
    expect(text).toContain('low/plain-http/src/a.js:3');
    expect(text).not.toContain('跳过');
  });

  it('有失败样本时附跳过注记，不影响成功样本统计', () => {
    const text = renderMetricsTable(
      [{ pr: 'expressjs/express#7437', addedLines: 400, findings: [] }],
      '2026-09-04',
      ['axios/axios#11175：HTTP 404']
    );
    expect(text).toContain('本周跳过 1 个无法扫描的样本');
    expect(text).toContain('axios/axios#11175：HTTP 404');
    expect(text).toContain('| 新增行 | 400 |');
  });
});

describe('redactSnippet（密钥类告警展示脱敏）', () => {
  const secretSnippet = 'const apiKey = "sk-live-abcdef1234567890";';

  it('hardcoded-secret 片段中的长字面量被替换为占位符', () => {
    const redacted = redactSnippet('hardcoded-secret', secretSnippet);
    expect(redacted).not.toContain('sk-live-abcdef1234567890');
    expect(redacted).toContain('const apiKey');
    expect(redacted).toContain('***（已脱敏）***');
  });

  it('短字面量与非密钥规则不受影响', () => {
    expect(redactSnippet('hardcoded-secret', 'const port = "8080";')).toBe('const port = "8080";');
    expect(redactSnippet('xss-inner-html', secretSnippet)).toBe(secretSnippet);
  });

  it('终端报告不回显密钥明文，修复建议同样脱敏', () => {
    const f = finding('high');
    f.ruleId = 'hardcoded-secret';
    f.snippet = secretSnippet;
    f.review = { verdict: 'confirmed', explanation: '真密钥', fixSuggestion: '删除 sk-live-abcdef1234567890 并轮换' };
    const text = renderReport([f], { source: 's', scannedFiles: 1, addedLines: 1 });
    expect(text).not.toContain('sk-live-abcdef1234567890');
    expect(text).toContain('💡 修复建议（复核）：删除 ***（已脱敏）*** 并轮换');
  });

  it('Markdown 报告（PR 评论）同样脱敏', () => {
    const f = finding('high');
    f.ruleId = 'hardcoded-secret';
    f.snippet = secretSnippet;
    const md = renderMarkdownReport([f], { source: 'PR #1', scannedFiles: 1, addedLines: 1 });
    expect(md).not.toContain('sk-live-abcdef1234567890');
    expect(md).toContain('***（已脱敏）***');
  });
});

describe('shouldFail', () => {
  it('failOn=high：仅低危放行，高危拦截', () => {
    expect(shouldFail([finding('low')], 'high')).toBe(false);
    expect(shouldFail([finding('high')], 'high')).toBe(true);
  });

  it('failOn=medium：低危放行，中危及以上拦截', () => {
    expect(shouldFail([finding('low')], 'medium')).toBe(false);
    expect(shouldFail([finding('medium')], 'medium')).toBe(true);
    expect(shouldFail([finding('high')], 'medium')).toBe(true);
  });

  it('failOn=info：任何告警都拦截，无告警放行', () => {
    expect(shouldFail([finding('info')], 'info')).toBe(true);
    expect(shouldFail([], 'info')).toBe(false);
  });
});
