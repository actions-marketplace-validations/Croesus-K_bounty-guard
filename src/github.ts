import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMENT_MARKER, LABELS } from './report.js';
import type { Finding } from './types.js';

/**
 * GitHub REST 交互（零依赖 fetch 封装）：PR diff 读取、粘性评论、
 * Job Summary 暂存与 Actions 告警标注。fetch 可注入以便测试。
 * 约束：环境变量提供的路径一律不做 fs 读写（防路径注入面）；
 * 所有请求带确定性超时——不假设注入的 fetch 遵守 abort signal。
 */

export interface GithubContext {
  token: string;
  /** 仓库 slug：owner/name */
  repo: string;
  /** fetch 注入点（测试用）；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 单次 API 请求超时（毫秒），默认 30 秒 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 带确定性超时的请求：超时让调用方必然收敛，而不是无限等待 */
async function request(ctx: GithubContext, url: string, init: RequestInit = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`GitHub API 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    const pending = (ctx.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    pending.catch(() => {}); // 防 timeout 赢得竞速后出现未处理拒绝
    return (await Promise.race([pending, timeout])) as Response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 非 2xx 时抛出带响应体摘要的可读错误；403 附常见原因提示 */
async function assertOk(path: string, res: Response): Promise<void> {
  if (res.ok) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  const hint = res.status === 403 ? '（常见原因：令牌权限不足或触发限流）' : '';
  throw new Error(`GitHub API ${path} 失败：HTTP ${res.status}${hint}${body ? `：${body.slice(0, 200)}` : ''}`);
}

async function githubJson<T>(ctx: GithubContext, url: string, init: RequestInit = {}): Promise<T> {
  const res = await request(ctx, url, init);
  const path = url.replace('https://api.github.com', '');
  await assertOk(path, res);
  return (await res.json()) as T;
}

/** 校验并拆分 owner/name——URL 只允许由合法标识构成，杜绝路径被拼出预期范围 */
export function parseRepoSlug(repo: string): { owner: string; name: string } {
  const m = repo.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new Error(`仓库标识无效：${repo}（应为 owner/name 形式）`);
  return { owner: m[1], name: m[2] };
}

function assertPrNumber(prNumber: number): number {
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`PR 编号无效：${prNumber}`);
  return prNumber;
}

/** 仓库级 API URL：标识经 parseRepoSlug 校验 + encodeURIComponent 编码，
 * 且以固定基底构造 URL 对象——host 结构性不可变，请求目标无法被输入改变 */
function repoApiUrl(ctx: GithubContext, sub: string): string {
  const { owner, name } = parseRepoSlug(ctx.repo);
  return new URL(
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${sub}`,
    'https://api.github.com'
  ).toString();
}

/** 读取 PR 的 unified diff（REST 原生支持，无需 git 历史） */
export async function fetchPrDiff(ctx: GithubContext, prNumber: number): Promise<string> {
  const url = repoApiUrl(ctx, `/pulls/${assertPrNumber(prNumber)}`);
  const res = await request(ctx, url, {
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/vnd.github.diff' }
  });
  await assertOk(url.replace('https://api.github.com', ''), res);
  return res.text();
}

interface IssueComment {
  id: number;
  body?: string;
}

/** GitHub 评论正文上限：超出该长度 API 直接 422，评论发不出去还连带门禁失败 */
export const COMMENT_BODY_LIMIT = 65536;

/** 超长评论安全截断：保留头部与粘性标记（更新识别全靠标记），尾部附截断说明 */
export function truncateCommentBody(body: string, limit: number = COMMENT_BODY_LIMIT): string {
  if (body.length <= limit) return body;
  const notice =
    '\n\n> ⚠️ 发现过多，报告超出评论长度上限已截断；完整内容请减少单次变更规模，或在本地运行 `bounty-guard scan --git` 查看。';
  const tail = `${notice}\n${COMMENT_MARKER}`;
  return body.slice(0, Math.max(0, limit - tail.length)) + tail;
}

/** 粘性评论：跨页查找带标记的历史评论，找到则更新，找不到才新建（重复扫描不刷屏） */
export async function upsertStickyComment(
  ctx: GithubContext,
  prNumber: number,
  body: string,
  marker: string = COMMENT_MARKER
): Promise<'created' | 'updated'> {
  const pr = assertPrNumber(prNumber);
  const safeBody = truncateCommentBody(body);
  const base = repoApiUrl(ctx, `/issues/${pr}`);
  let page = 1;
  let existing: IssueComment | undefined;
  for (;;) {
    const comments = await githubJson<IssueComment[]>(
      ctx,
      `${base}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(comments) || comments.length === 0) break;
    existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
    if (existing || comments.length < 100 || page >= 10) break;
    page++;
  }
  if (existing) {
    await githubJson(ctx, `${base}/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: safeBody })
    });
    return 'updated';
  }
  await githubJson(ctx, `${base}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: safeBody })
  });
  return 'created';
}

/** 每步标注上限：GitHub 仅接受 10 条 error + 10 条 warning，超出部分被静默丢弃 */
const ANNOTATION_CAP = 10;

/** 生成 Actions 告警标注（高危/中危 error，低危及以下 warning）。
 * 超出上限时保留前 9 条、第 10 条用作汇总，确保溢出信息可见而不是被吞掉。 */
export function toAnnotations(findings: Finding[]): string[] {
  const lines: string[] = [];
  const emit = (list: Finding[], level: 'error' | 'warning', scope: string) => {
    const head = list.slice(0, ANNOTATION_CAP - 1);
    const dropped = list.length - head.length;
    for (const f of head) {
      lines.push(`::${level} file=${f.file},line=${f.line}::[${LABELS[f.severity]}] ${f.ruleId}：${f.message}`);
    }
    if (dropped > 0) {
      lines.push(`::${level} title=bounty-guard::另有 ${dropped} 条${scope}告警未展示，完整列表见 PR 评论`);
    }
  };
  emit(
    findings.filter((f) => f.severity === 'high' || f.severity === 'medium'),
    'error',
    '高危/中危'
  );
  emit(
    findings.filter((f) => f.severity === 'low' || f.severity === 'info'),
    'warning',
    '低危/提示'
  );
  return lines;
}

/** Job Summary 暂存文件名（工作目录下固定文件，由 Action 步骤追加到 $GITHUB_STEP_SUMMARY） */
export const SUMMARY_FILE = '.bounty-guard-summary.md';

/** 将 Markdown 报告写入工作目录的固定暂存文件，返回绝对路径 */
export function writeSummaryFile(markdown: string): string {
  writeFileSync(SUMMARY_FILE, `${markdown}\n`);
  return resolve(SUMMARY_FILE);
}

/** 解析 PR 编号：显式参数 → GITHUB_PR_NUMBER → GITHUB_REF。
 * 注：不读取 GITHUB_EVENT_PATH 事件文件（env 提供的路径一律不做 fs 操作），
 * Actions 的 pull_request 事件里 GITHUB_REF 必为 refs/pull/<n>/merge，已足够。 */
export function resolvePrNumber(explicit?: string): number | undefined {
  if (explicit) {
    const n = Number(explicit);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const envNumber = Number(process.env.GITHUB_PR_NUMBER);
  if (Number.isInteger(envNumber) && envNumber > 0) return envNumber;
  const fromRef = (process.env.GITHUB_REF ?? '').match(/^refs\/pull\/(\d+)\/merge$/);
  if (fromRef) return Number(fromRef[1]);
  return undefined;
}
