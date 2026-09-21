import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appJwt,
  installationToken,
  readPullRequestEvent,
  verifyWebhookSignature
} from '../src/app/server.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('appJwt', () => {
  it('生成可用 RSA-SHA256 公钥验证的 JWT（iss=appId）', () => {
    const token = appJwt('12345', PEM, 1_700_000_000);
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBe(600);
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);
  });
});

describe('verifyWebhookSignature', () => {
  const body = '{"action":"opened"}';
  const good = 'sha256=' + createHmac('sha256', 'sec').update(body).digest('hex');

  it('正确签名通过；篡改、错密钥、缺前缀、缺失头均失败', () => {
    expect(verifyWebhookSignature('sec', body, good)).toBe(true);
    expect(verifyWebhookSignature('sec', body + 'x', good)).toBe(false);
    expect(verifyWebhookSignature('sec2', body, good)).toBe(false);
    expect(verifyWebhookSignature('sec', body, 'no-prefix')).toBe(false);
    expect(verifyWebhookSignature('sec', body, undefined)).toBe(false);
  });
});

describe('readPullRequestEvent', () => {
  const payload = {
    action: 'opened',
    pull_request: { number: 7 },
    repository: { full_name: 'o/r' },
    installation: { id: 42 }
  };

  it('opened / synchronize / reopened 解析为 PR 事件', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      expect(readPullRequestEvent({ ...payload, action })).toEqual({
        repo: 'o/r',
        pr: 7,
        installationId: 42,
        action
      });
    }
  });

  it('其它动作或缺字段返回 null', () => {
    expect(readPullRequestEvent({ ...payload, action: 'closed' })).toBeNull();
    expect(readPullRequestEvent({ action: 'opened' })).toBeNull();
    expect(readPullRequestEvent({})).toBeNull();
  });
});

describe('installationToken（确定性超时）', () => {
  it('挂起的交换请求在超时后以可读错误收敛', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
    try {
      const start = Date.now();
      await expect(installationToken('jwt', 1, 30)).rejects.toThrow(/超时/);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('成功交换返回 token；HTTP 错误抛可读失败', async () => {
    const jsonResponse = (body: unknown, ok = true, status = 200) =>
      ({ ok, status, json: async () => body }) as unknown as Response;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ token: 'tok-1' })) as typeof fetch;
    try {
      await expect(installationToken('jwt', 42)).resolves.toBe('tok-1');
      globalThis.fetch = (async () => jsonResponse({}, false, 404)) as typeof fetch;
      await expect(installationToken('jwt', 42)).rejects.toThrow(/HTTP 404/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('startGhAppServer（webhook 请求体上限）', () => {
  it('超过 MAX_WEBHOOK_BODY_BYTES 的请求直接 413，正常请求先应答 200', async () => {
    const { startGhAppServer, MAX_WEBHOOK_BODY_BYTES } = await import('../src/app/server.js');
    const { DEFAULT_CONFIG } = await import('../src/config.js');
    const server = startGhAppServer(
      { appId: '1', privateKey: PEM, webhookSecret: 'sec', port: 0 },
      DEFAULT_CONFIG
    );
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (typeof address !== 'object' || !address) throw new Error('无监听地址');
      const url = `http://127.0.0.1:${address.port}/api/github/webhook`;

      const big = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 97).toString('utf8');
      const rejected = await fetch(url, { method: 'POST', body: big });
      expect(rejected.status).toBe(413);

      const small = await fetch(url, { method: 'POST', body: '{"action":"opened"}' });
      expect(small.status).toBe(200);
      expect(await small.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});

describe('processWebhook（AI 复核贯通）', () => {
  const DIFF = [
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '@@ -1,1 +1,2 @@',
    " el.innerHTML = '静态';",
    "+el.innerHTML = '<b>' + name;",
    ''
  ].join('\n');

  const payload = JSON.stringify({
    action: 'opened',
    pull_request: { number: 9 },
    repository: { full_name: 'o/r' },
    installation: { id: 42 }
  });
  const signature = 'sha256=' + createHmac('sha256', 'sec').update(payload).digest('hex');
  const headers = { 'x-hub-signature-256': signature, 'x-github-event': 'pull_request' };

  const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it('配置 mock 复核时报告带 LLM 汇总并发布评论', async () => {
    const { processWebhook } = await import('../src/app/server.js');
    const original = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/app/installations/')) return jsonResponse({ token: 'tok' });
      if (path.includes('/pulls/9')) return new Response(DIFF, { status: 200 });
      if (path.includes('/comments')) {
        const body = String(init?.body ?? '');
        if (body) bodies.push(body); // 只记录写请求（GET 列表无正文）
        return jsonResponse([]);
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    try {
      const env = { appId: '1', privateKey: PEM, webhookSecret: 'sec', port: 0 };
      const config = {
        ...DEFAULT_CONFIG,
        ai: { enabled: true, provider: 'mock' as const }
      };
      await processWebhook(env, config, payload, headers);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('LLM 复核（mock）');
      expect(bodies[0]).toContain('xss-inner-html');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('复核未配置时保持纯规则报告', async () => {
    const { processWebhook } = await import('../src/app/server.js');
    const original = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/app/installations/')) return jsonResponse({ token: 'tok' });
      if (path.includes('/pulls/9')) return new Response(DIFF, { status: 200 });
      if (path.includes('/comments')) {
        const body = String(init?.body ?? '');
        if (body) bodies.push(body); // 只记录写请求（GET 列表无正文）
        return jsonResponse([]);
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    try {
      const env = { appId: '1', privateKey: PEM, webhookSecret: 'sec', port: 0 };
      await processWebhook(env, DEFAULT_CONFIG, payload, headers);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain('LLM 复核');
      expect(bodies[0]).toContain('xss-inner-html');
    } finally {
      globalThis.fetch = original;
    }
  });
});
