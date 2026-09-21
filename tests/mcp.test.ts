import { describe, expect, it } from 'vitest';
import { callTool, handleRpc } from '../src/mcp/server.js';

const SAMPLE_DIFF = [
  'diff --git a/src/x.js b/src/x.js',
  '--- a/src/x.js',
  '+++ b/src/x.js',
  '@@ -1 +1 @@',
  '-ok',
  "+el.innerHTML = '<b>' + name;",
  ''
].join('\n');

describe('MCP 服务器（JSON-RPC over stdio）', () => {
  it('initialize 返回协议版本与服务器信息', async () => {
    const res = JSON.parse(
      (await handleRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))) ?? '{}'
    );
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.serverInfo.name).toBe('bounty-guard');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('tools/list 返回 4 个工具', async () => {
    const res = JSON.parse(
      (await handleRpc(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))) ?? '{}'
    );
    expect(res.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'scan_git',
      'scan_diff',
      'list_rules',
      'doctor'
    ]);
  });

  it('tools/call scan_diff 命中 XSS 并返回中文报告', async () => {
    const res = JSON.parse(
      (await handleRpc(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'scan_diff', arguments: { diff: SAMPLE_DIFF } }
        })
      )) ?? '{}'
    );
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].type).toBe('text');
    expect(res.result.content[0].text).toContain('xss-inner-html');
    expect(res.result.content[0].text).toContain('汇总：高危 1');
  });

  it('tools/call list_rules 列出全部规则（含 Python 子集）', async () => {
    const res = JSON.parse(
      (await handleRpc(
        JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_rules', arguments: {} } })
      )) ?? '{}'
    );
    expect(res.result.content[0].text).toContain('xss-inner-html');
    expect(res.result.content[0].text).toContain('py-dangerous-eval');
  });

  it('未知方法返回 -32601；非法 JSON 行静默忽略', async () => {
    const res = JSON.parse(
      (await handleRpc(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'nope', params: {} }))) ?? '{}'
    );
    expect(res.error.code).toBe(-32601);
    expect(await handleRpc('{not json')).toBeNull();
  });

  it('ping 心跳返回空结果而非 -32601', async () => {
    const res = JSON.parse(
      (await handleRpc(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }))) ?? '{}'
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});
  });

  it('callTool doctor 返回配置摘要', async () => {
    const { text } = await callTool('doctor', {});
    expect(text).toContain('Node：');
    expect(text).toContain('failOn：high');
  });
});
