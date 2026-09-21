/**
 * GitHub App 自托管服务器形态：
 * 接收 pull_request webhook → installation token → 扫描 PR diff → 粘性评论。
 *
 * 环境变量：BG_APP_ID / BG_PRIVATE_KEY（PEM 全文）/ BG_WEBHOOK_SECRET / BG_PORT（默认 8080）。
 * 部署：任意可公网访问的 Node 主机；在 GitHub 注册 App 时：
 *   - Webhook URL 填 https://<host>/api/github/webhook
 *   - 订阅 Pull requests 事件，权限 Pull requests: Read & write
 *   - Webhook secret 与 BG_WEBHOOK_SECRET 一致（用于验签）
 */
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { loadConfig, type BountyConfig } from '../config.js';
import { fetchPrDiff, upsertStickyComment } from '../github.js';
import { matchGlob } from '../glob.js';
import { parseDiff } from '../diff.js';
import { loadProvider } from '../llm/provider.js';
import { renderMarkdownReport, type ReportMeta } from '../report.js';
import { reviewFindings } from '../review.js';
import { scanDiff } from '../scanner.js';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** GitHub App JWT（RS256，10 分钟有效期），供 installation token 交换 */
export function appJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

/** webhook 验签：x-hub-signature-256（HMAC-SHA256，长度安全比较） */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const given = signatureHeader.slice('sha256='.length);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export interface PrEvent {
  repo: string;
  pr: number;
  installationId: number;
  action: string;
}

/** 解析 pull_request 事件；非相关动作或缺字段返回 null */
export function readPullRequestEvent(payload: Record<string, unknown>): PrEvent | null {
  const action = typeof payload.action === 'string' ? payload.action : '';
  if (!['opened', 'synchronize', 'reopened'].includes(action)) return null;
  const pull = (payload.pull_request ?? {}) as { number?: number };
  const repository = (payload.repository ?? {}) as { full_name?: string };
  const installation = (payload.installation ?? {}) as { id?: number };
  if (
    typeof pull.number !== 'number' ||
    typeof repository.full_name !== 'string' ||
    typeof installation.id !== 'number'
  ) {
    return null;
  }
  return { repo: repository.full_name, pr: pull.number, installationId: installation.id, action };
}

/** installation token 交换的确定性超时——不假设 fetch 遵守 abort signal（与 github.ts 同一原则） */
const INSTALL_TOKEN_TIMEOUT_MS = 10_000;

/** 以 App JWT 换取 installation 的操作令牌（带确定性超时，公网部署必须收敛） */
export async function installationToken(
  jwt: string,
  installationId: number,
  timeoutMs: number = INSTALL_TOKEN_TIMEOUT_MS
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`获取 installation token 超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    const pending = fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    pending.catch(() => {}); // 防 timeout 赢得竞速后出现未处理拒绝
    const res = (await Promise.race([pending, timeout])) as Response;
    if (!res.ok) throw new Error(`获取 installation token 失败：HTTP ${res.status}`);
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error('installation token 响应缺少 token 字段');
    return data.token;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GhAppEnv {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
}

export function readEnv(): GhAppEnv {
  const appId = process.env.BG_APP_ID;
  const privateKey = process.env.BG_PRIVATE_KEY;
  const webhookSecret = process.env.BG_WEBHOOK_SECRET;
  const port = Number(process.env.BG_PORT ?? 8080);
  if (!appId || !privateKey || !webhookSecret) {
    throw new Error('缺少环境变量：BG_APP_ID / BG_PRIVATE_KEY / BG_WEBHOOK_SECRET');
  }
  return { appId, privateKey, webhookSecret, port };
}

/** 处理 pull_request webhook（导出供测试）：验签 → 采集 → 规则扫描 →（配置了 Key 则）LLM 复核 → 粘性评论 */
export async function processWebhook(
  env: GhAppEnv,
  config: BountyConfig,
  body: string,
  headers: IncomingHttpHeaders
): Promise<void> {
  const signature = headers['x-hub-signature-256'];
  const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
  if (!verifyWebhookSignature(env.webhookSecret, body, signatureHeader)) {
    process.stderr.write('[bounty-guard] webhook 验签失败，忽略\n');
    return;
  }
  if (headers['x-github-event'] !== 'pull_request') return;
  const event = readPullRequestEvent(JSON.parse(body) as Record<string, unknown>);
  if (!event) return;

  const jwt = appJwt(env.appId, env.privateKey);
  const token = await installationToken(jwt, event.installationId);
  const diffText = await fetchPrDiff({ token, repo: event.repo }, event.pr);
  const diff = parseDiff(diffText);
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
  // 与 CLI / Action 形态对齐：配置了复核（ai.enabled 且非 off）就自动执行，永远只复核已有发现
  const loaded = loadProvider(config);
  let review: ReportMeta['review'];
  if (!loaded.degraded) {
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
  const meta: ReportMeta = {
    source: `PR #${event.pr}（${event.repo}）`,
    scannedFiles: scannable.length,
    addedLines,
    review
  };
  const markdown = renderMarkdownReport(findings, meta);
  await upsertStickyComment({ token, repo: event.repo }, event.pr, markdown);
  process.stderr.write(
    `[bounty-guard] PR #${event.pr} 扫描完成：${findings.length} 条告警${review ? `（${review.provider} 复核）` : ''}\n`
  );
}

/** webhook 请求体上限：pull_request 事件极少超过 1MB，超限直接 413（公网部署防内存打爆） */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

/** 启动服务器；返回 Server 实例（测试用 ephemeral 端口），日志走 stderr */
export function startGhAppServer(env: GhAppEnv, config: BountyConfig): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/github/webhook') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (rejected) return;
      if (received > MAX_WEBHOOK_BODY_BYTES) {
        rejected = true;
        chunks.length = 0; // 立刻丢弃已缓冲内容，不再为超大请求累计内存
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('payload too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok'); // webhook 先应答，扫描异步进行
      void processWebhook(env, config, body, req.headers).catch((err) => {
        process.stderr.write(`[bounty-guard] ${err instanceof Error ? err.message : String(err)}\n`);
      });
    });
  });
  server.listen(env.port, () => {
    process.stderr.write(`bounty-guard GitHub App 服务器已启动：0.0.0.0:${env.port}\n`);
  });
  return server;
}
