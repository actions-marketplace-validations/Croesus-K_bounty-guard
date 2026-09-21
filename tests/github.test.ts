import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMENT_BODY_LIMIT,
  resolvePrNumber,
  toAnnotations,
  truncateCommentBody,
  upsertStickyComment,
  writeSummaryFile
} from '../src/github.js';
import { COMMENT_MARKER } from '../src/report.js';
import type { GithubContext } from '../src/github.js';
import { fetchPrDiff, parseRepoSlug } from '../src/github.js';
import type { Finding } from '../src/types.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function finding(severity: Finding['severity'], file = 'src/a.js', line = 3): Finding {
  return {
    ruleId: 'xss-inner-html',
    severity,
    file,
    line,
    snippet: "el.innerHTML = '<b>' + name;",
    message: '存在 XSS 风险',
    fixHint: '用 textContent'
  };
}

type JsonResponder = (path: string, init: RequestInit) => unknown;

/** 按路径响应 JSON 的 fetch 桩，记录全部调用 */
function fetchStub(respond: JsonResponder, calls: Array<{ path: string; init: RequestInit }> = []): GithubContext {
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push({ path, init: init ?? {} });
    const body = respond(path, init ?? {});
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return { token: 'token-x', repo: 'o/r', fetchImpl };
}

describe('parseRepoSlug', () => {
  it('接受合法 owner/name 并拆分', () => {
    expect(parseRepoSlug('Croesus-K/bounty-guard')).toEqual({ owner: 'Croesus-K', name: 'bounty-guard' });
  });

  it('拒绝路径操纵与畸形标识', () => {
    expect(() => parseRepoSlug('../x/y')).toThrow(/仓库标识无效/);
    expect(() => parseRepoSlug('o/r?x=1')).toThrow(/仓库标识无效/);
    expect(() => parseRepoSlug('onlyname')).toThrow(/仓库标识无效/);
    expect(() => parseRepoSlug('')).toThrow(/仓库标识无效/);
  });

  it('fetchPrDiff 拒绝无效仓库标识（SSRF 防线）', async () => {
    const ctx: GithubContext = { token: 't', repo: '../evil' };
    await expect(fetchPrDiff(ctx, 1)).rejects.toThrow(/仓库标识无效/);
  });
});

describe('upsertStickyComment', () => {
  it('无历史评论时创建', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const ctx = fetchStub(() => [], calls);
    const result = await upsertStickyComment(ctx, 7, '报告内容');
    expect(result).toBe('created');
    expect(calls[0].path).toBe('/repos/o/r/issues/7/comments?per_page=100&page=1');
    expect(calls[1].path).toBe('/repos/o/r/issues/7/comments');
    expect(calls[1].init.method).toBe('POST');
    expect(String(calls[1].init.body)).toContain('报告内容');
  });

  it('粘性评论跨页查找：旧评论在第 101 条之后也能更新', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `普通评论 ${i}` }));
    const ctx = fetchStub(
      (path) => (path.includes('page=2') ? [{ id: 999, body: `旧报告 ${COMMENT_MARKER}` }] : page1),
      calls
    );
    const result = await upsertStickyComment(ctx, 7, '新报告');
    expect(result).toBe('updated');
    expect(calls.some((c) => c.path.includes('page=2'))).toBe(true);
    expect(calls[calls.length - 1].path).toBe('/repos/o/r/issues/7/comments/999');
    expect(calls[calls.length - 1].init.method).toBe('PATCH');
  });

  it('API 请求超时抛出可读错误', async () => {
    const hanging = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const ctx: GithubContext = { token: 't', repo: 'o/r', fetchImpl: hanging, timeoutMs: 5 };
    await expect(fetchPrDiff(ctx, 1)).rejects.toThrow(/超时/);
  });

  it('HTTP 错误带响应体摘要与限流提示', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 403, text: async () => '{"message":"rate limit"}' }) as unknown as Response) as typeof fetch;
    const ctx: GithubContext = { token: 't', repo: 'o/r', fetchImpl };
    await expect(fetchPrDiff(ctx, 1)).rejects.toThrow(/403[\s\S]*限流[\s\S]*rate limit/);
  });

  it('已有粘性评论时按 id 更新而非新建', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const ctx = fetchStub(() => [{ id: 42, body: `旧的 ${COMMENT_MARKER}` }], calls);
    const result = await upsertStickyComment(ctx, 7, '新报告');
    expect(result).toBe('updated');
    expect(calls[1].path).toBe('/repos/o/r/issues/7/comments/42');
    expect(calls[1].init.method).toBe('PATCH');
  });

  it('无关评论不会命中粘性标记', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const ctx = fetchStub(() => [{ id: 1, body: '普通评论' }], calls);
    expect(await upsertStickyComment(ctx, 7, '新报告')).toBe('created');
    expect(calls[1].init.method).toBe('POST');
  });
});

describe('truncateCommentBody（评论 64KB 上限防 422）', () => {
  it('未超限原样返回', () => {
    expect(truncateCommentBody('短报告')).toBe('短报告');
  });

  it('超限时截断到上限内，尾部保留说明与粘性标记', () => {
    const huge = 'x'.repeat(COMMENT_BODY_LIMIT + 5000);
    const out = truncateCommentBody(huge);
    expect(out.length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
    expect(out).toContain('已截断');
    expect(out.endsWith(COMMENT_MARKER)).toBe(true);
  });

  it('upsertStickyComment 发送的正文经过截断', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const ctx = fetchStub(() => [{ id: 42, body: `旧的 ${COMMENT_MARKER}` }], calls);
    await upsertStickyComment(ctx, 7, 'y'.repeat(COMMENT_BODY_LIMIT + 1000));
    const sent = String(calls[1].init.body);
    expect(sent.length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT + 30); // JSON 包装的开销
    expect(sent).toContain(COMMENT_MARKER);
  });
});

describe('toAnnotations', () => {
  it('高危/中危输出 error 标注，低危输出 warning', () => {
    const lines = toAnnotations([finding('high'), finding('low')]);
    expect(lines[0]).toContain('::error file=src/a.js,line=3::');
    expect(lines[0]).toContain('[高危] xss-inner-html');
    expect(lines[1]).toContain('::warning file=src/a.js,line=3::');
  });

  it('不超上限时逐条输出', () => {
    expect(toAnnotations([finding('high'), finding('low')])).toHaveLength(2);
  });

  it('超出每步上限时截断为 9+汇总，不被 GitHub 静默吞掉', () => {
    const many = Array.from({ length: 12 }, () => finding('high'));
    const lines = toAnnotations(many);
    expect(lines.filter((l) => l.startsWith('::error'))).toHaveLength(10);
    expect(lines.at(-1)).toContain('另有 3 条高危/中危告警未展示');
  });

  it('error 与 warning 分别计数', () => {
    const many = Array.from({ length: 11 }, () => finding('high')).concat([finding('low')]);
    const lines = toAnnotations(many);
    expect(lines.filter((l) => l.startsWith('::error'))).toHaveLength(10);
    expect(lines.filter((l) => l.startsWith('::warning'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('另有 2 条高危/中危告警未展示'))).toHaveLength(1);
  });
});

describe('resolvePrNumber', () => {
  it('优先级：显式参数 > GITHUB_PR_NUMBER > GITHUB_REF', () => {
    expect(resolvePrNumber('12')).toBe(12);
    vi.stubEnv('GITHUB_PR_NUMBER', '34');
    expect(resolvePrNumber()).toBe(34);
    vi.stubEnv('GITHUB_PR_NUMBER', '');
    vi.stubEnv('GITHUB_REF', 'refs/pull/56/merge');
    expect(resolvePrNumber()).toBe(56);
  });

  it('非法输入返回 undefined', () => {
    vi.stubEnv('GITHUB_PR_NUMBER', '');
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    expect(resolvePrNumber()).toBeUndefined();
    expect(resolvePrNumber('abc')).toBeUndefined();
  });
});

describe('writeSummaryFile', () => {
  it('写入工作目录固定文件并返回绝对路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-summary-'));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const file = writeSummaryFile('# 标题');
      expect(file.startsWith(dir)).toBe(true);
      expect(readFileSync(join(dir, '.bounty-guard-summary.md'), 'utf8')).toBe('# 标题\n');
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
