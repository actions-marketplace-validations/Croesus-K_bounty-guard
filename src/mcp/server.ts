/**
 * MCP（Model Context Protocol）stdio 服务器形态：
 * 任何 AI 编程助手都可作为 MCP 客户端接入 bounty-guard，在写码瞬间调用扫描。
 * 协议：stdin/stdout 上的换行分隔 JSON-RPC 2.0（零依赖实现）。
 * 注意：stdout 只承载协议消息——一切日志一律走 stderr。
 */
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { loadConfig } from '../config.js';
import { collectGitChanges, collectStagedChanges } from '../git-scan.js';
import { matchGlob } from '../glob.js';
import { loadProvider } from '../llm/provider.js';
import { renderReport } from '../report.js';
import { reviewFindings } from '../review.js';
import { scanDiff } from '../scanner.js';
import { ALL_RULES } from '../rules/index.js';
import { parseDiff, type ParsedDiff } from '../diff.js';

const require2 = createRequire(import.meta.url);
const VERSION: string = require2('../../package.json').version;

const PROTOCOL_VERSION = '2024-11-05';

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function resp(id: RpcRequest['id'], result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errResp(id: RpcRequest['id'], code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const TOOL_DEFS = [
  {
    name: 'scan_git',
    description: '扫描指定目录的未提交/已暂存变更（只审新增行），返回中文安全报告与门禁结论',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '项目目录，缺省为当前工作目录' },
        staged: { type: 'boolean', description: '只扫描已暂存变更' },
        ai: { type: 'boolean', description: '启用 LLM 复核（需已配置 Key）' }
      }
    }
  },
  {
    name: 'scan_diff',
    description: '扫描一段 unified diff 文本，返回中文安全报告',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'unified diff 全文' },
        ai: { type: 'boolean', description: '启用 LLM 复核' }
      },
      required: ['diff']
    }
  },
  {
    name: 'list_rules',
    description: '列出全部内置安全规则（id、严重度、说明）',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'doctor',
    description: '查看当前目录的 bounty-guard 配置摘要',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } }
  }
];

/** 扫描并渲染为文本报告（MCP 内容载荷） */
async function scanToText(diff: ParsedDiff, cwd: string, wantAi: boolean, source: string): Promise<string> {
  const config = loadConfig(cwd);
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
  let review;
  if (wantAi) {
    const loaded = loadProvider(config);
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
  }
  return renderReport(findings, {
    source,
    scannedFiles: scannable.length,
    addedLines,
    review
  });
}

/** MCP 工具实现（可独立测试） */
export async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string }> {
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  if (name === 'scan_git') {
    const diff = args.staged === true ? await collectStagedChanges(cwd) : await collectGitChanges(cwd);
    return {
      text: await scanToText(diff, cwd, args.ai === true, args.staged === true ? 'git 已暂存变更' : 'git 未提交变更')
    };
  }
  if (name === 'scan_diff') {
    if (typeof args.diff !== 'string' || args.diff.trim() === '') {
      throw new Error('缺少 diff 参数（unified diff 文本）');
    }
    return { text: await scanToText(parseDiff(args.diff), cwd, args.ai === true, 'diff 文本') };
  }
  if (name === 'list_rules') {
    const lines = ALL_RULES.map((r) => `- [${r.severity}] ${r.id}：${r.message}`);
    return { text: `bounty-guard 共 ${ALL_RULES.length} 条规则：\n${lines.join('\n')}` };
  }
  if (name === 'doctor') {
    const config = loadConfig(cwd);
    return {
      text: [
        `Node：${process.versions.node}`,
        `failOn：${config.failOn} · scanTests：${config.scanTests} · 禁用规则：${config.disabledRules?.length ?? 0} 条`,
        `AI：${config.ai.enabled ? `已启用（${config.ai.provider}）` : '未启用（纯规则模式）'}${config.ai.model ? ` · 模型 ${config.ai.model}` : ''}`
      ].join('\n')
    };
  }
  throw new Error(`未知工具：${name}`);
}

/** 处理一行 JSON-RPC 请求，返回响应行；无需响应（通知/非法输入）返回 null */
export async function handleRpc(raw: string): Promise<string | null> {
  let req: RpcRequest;
  try {
    req = JSON.parse(raw) as RpcRequest;
  } catch {
    return null; // 非法行静默忽略（协议健壮性）
  }
  if (typeof req.method !== 'string') return null;
  if (req.method === 'initialize') {
    return JSON.stringify(
      resp(req.id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bounty-guard', version: VERSION }
      })
    );
  }
  if (req.method.startsWith('notifications/')) return null;
  // 协议心跳：个别客户端（如官方 Inspector 部分版本）连接后会先 ping，缺实现会报 -32601
  if (req.method === 'ping') return JSON.stringify(resp(req.id ?? null, {}));
  if (req.method === 'tools/list') return JSON.stringify(resp(req.id ?? null, { tools: TOOL_DEFS }));
  if (req.method === 'tools/call') {
    const params = req.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const { text } = await callTool(name, args);
      return JSON.stringify(resp(req.id ?? null, { content: [{ type: 'text', text }], isError: false }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify(resp(req.id ?? null, { content: [{ type: 'text', text: message }], isError: true }));
    }
  }
  if (req.id !== undefined && req.id !== null) {
    return JSON.stringify(errResp(req.id, -32601, `未知方法：${req.method}`));
  }
  return null;
}

/** 启动 stdio 服务器：stdout 只写协议消息，日志走 stderr */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleRpc(trimmed).then((out) => {
      if (out) process.stdout.write(`${out}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write(`bounty-guard MCP 服务器已启动（stdio，协议 ${PROTOCOL_VERSION}）\n`);
}
