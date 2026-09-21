# bounty-guard

[![CI](https://github.com/Croesus-K/bounty-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Croesus-K/bounty-guard/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/bounty-guard.svg)](https://www.npmjs.com/package/bounty-guard)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-bounty--guard-blue?logo=github)](https://github.com/marketplace/actions/bounty-guard)

> AI 代码安全审查助手 —— 规则引擎初筛 + LLM 复核，守住每一行 diff。

这个项目始于一次真实的踩坑：我给自己的上一个项目修 XSS 时，被安全扫描器提示 `Math.random` 弱随机——提示是对的，但我更在意的是：为什么没有工具在我**提交那行危险代码的时候**就拦住我？市面上的扫描器要么重如全量 AST 分析，要么误报多到没人看。bounty-guard 只做一件事：**盯住每一行新增代码**，规则初筛、LLM 复核降噪，结果留在 PR 评论里。

上一个项目「赏金契约」守的是契约，这一个猎的是 bug：发现安全问题，就是赏金。

## 它怎么工作

```
CLI（npm 包）──────────┐
                      ├→ Diff 解析器 → 规则引擎初筛 → LLM 复核（可选）→ 报告
GitHub Action（薄壳）──┘
```

同一引擎，**五种使用形态**：CLI / GitHub Action / pre-commit 钩子 / MCP Server（AI 助手接入）/ VS Code 扩展（另有 GitHub App 自托管服务器，见下文）。

- **只审新增行**——成本控制的根基，也是"守住每一行 diff"的字面含义
- **LLM 永远只复核、不发明**——每条告警必须挂在真实代码行上、有规则命中佐证（防幻觉根基）
- **无 API Key 优雅降级**——纯规则模式完整可用，CI 里零成本跑
- **严重度只降不升**——提示词禁止上调 → 解析层丢弃上调建议 → 流水线双保险
- **粘性评论**——重复扫描只更新一条评论，不刷屏

## 真实验证数据

| 场景 | 结果 |
|---|---|
| 回滚「赏金契约」项目到修复 XSS 之前的版本（129 新增行） | 命中当年那个存储型 XSS（`index.html:524`），0 误报 |
| 靶场 PR（故意引入 3 个问题） | 3/3 精准命中，门禁红灯 |
| 误报治理 | 三轮安全工具误伤自己的案例，见 [docs/PLAN.md](docs/PLAN.md) 素材库 |

靶场实拍：[bounty-guard-playground PR #1](https://github.com/Croesus-K/bounty-guard-playground/pull/1)（demo GIF 待补）

<!-- TODO: 录制 demo GIF：PR 评论 + 门禁红灯 -->

## 快速开始

```bash
npm i -g bounty-guard    # 全局安装；或免安装直接 npx
```

### CLI 扫描

```bash
# 扫描未提交变更（diff 驱动，只审新增行）
npx bounty-guard scan --git

# 扫描 diff 文件，发现高危即非零退出（CI 门禁）
npx bounty-guard scan --diff pr.diff --fail-on high

# 输出 SARIF（可对接 GitHub code-scanning）或 JSON
npx bounty-guard scan --diff pr.diff --format sarif

# pre-commit 场景：只扫已暂存变更
npx bounty-guard scan --git --staged --fail-on high

# 启用 LLM 复核（无 Key 自动降级为纯规则模式）
BOUNTY_GUARD_API_KEY=sk-xxx npx bounty-guard scan --git --ai
```

### 体检与本地钩子

```bash
npx bounty-guard doctor        # 体检：Node / Git / 配置 / AI 供应商连通性（--json 可机读）
npx bounty-guard init-hooks    # 安装 pre-commit 钩子：提交前自动扫描，红灯阻断提交
npx bounty-guard init-hooks --uninstall   # 移除钩子
BOUNTY_GUARD_SKIP=1 git commit # 临时跳过一次钩子
```

### 误报率周报

`scripts/weekly-report.ts` + 定时任务每周五自动扫描 `scripts/metrics-prs.txt` 清单里的真实 PR，
生成 [docs/metrics.md](docs/metrics.md) 并自动提交——**持续更新的真实误报率仪表盘**，
也可本地手动触发：`GITHUB_TOKEN=xxx npx tsx scripts/weekly-report.ts`。

### MCP Server（给 AI 编程助手用）

把 bounty-guard 作为 MCP 工具暴露给 ZCode / Cursor / Claude Code 等 agent——在写码瞬间调用扫描：

```json
{ "mcpServers": { "bounty-guard": { "command": "npx", "args": ["-y", "bounty-guard", "mcp"] } } }
```

工具：`scan_git`（未提交/暂存变更）、`scan_diff`（diff 文本）、`list_rules`（规则清单）、`doctor`（配置摘要）。零依赖实现，协议 2024-11-05。

### GitHub App（自托管服务器）

比 composite action 更实时、支持私有仓库、一次安装多仓库复用：

```bash
BG_APP_ID=1 BG_PRIVATE_KEY="$(cat app-key.pem)" BG_WEBHOOK_SECRET=*** BG_PORT=8080 \
  npx bounty-guard gh-app
```

注册 App（Webhook URL → `https://<host>/api/github/webhook`，订阅 Pull requests，权限 Pull requests: Read & write）后，
服务器自动验签 → 换 installation token → 扫描 PR → 粘性评论。与 CLI/Action 形态一致：`.bountyrc.json` 配置了 LLM 复核
（`ai.enabled` 且非 off）时自动复核，未配置则纯规则；webhook 请求体超 5MB 直接 413。

### VS Code 扩展

`ide/vscode/`：诊断面板 + 编辑器内波浪线，保存自动刷新，零依赖纯 JS。调试与打包见 [ide/vscode/README.md](ide/vscode/README.md)。

### GitHub Action

在目标仓库放一个 workflow：

```yaml
name: bounty-guard
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Croesus-K/bounty-guard@main
        with:
          fail-on: high   # high | medium | low | info
          # ai: 'true'    # 启用 LLM 复核，需在 job 级配置 BOUNTY_GUARD_API_KEY
```

Action 会：读取 PR diff → 规则初筛 →（可选）LLM 复核 → 发布/更新一条粘性评论 → 输出 `::error file,line` 标注 → 按 `fail-on` 决定 Job 红绿灯。

### 配置 `.bountyrc.json`

```json
{
  "ignore": ["node_modules/**", "dist/**", "coverage/**"],
  "failOn": "high",
  "scanTests": false,
  "ai": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "maxTokens": 500
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `ignore` | `node_modules` / `dist` / `coverage` | **整体替换**默认值——自定义时建议把默认三项一并写上 |
| `failOn` | `high` | 门禁等级 high / medium / low / info，非法值在启动时报错（不静默放行） |
| `scanTests` | `false` | 是否扫描测试文件（tests/、\_\_tests\_\_/、\*.test.\*、\*.spec.\*） |
| `disabledRules` | `[]` | 按 id 关闭单条规则，如 `["plain-http"]` |
| `ai.enabled` | `false` | 启用 LLM 复核（也可用 `--ai` 临时开启） |
| `ai.provider` | `off` | `openai-compatible` / `mock` / `off`，非法值在启动时报错 |
| `ai.baseUrl` / `ai.model` | OpenAI 官方 / `gpt-4o-mini` | DeepSeek、GLM 等换 baseUrl 即可切换 |
| `ai.maxTokens` | `500` | 单条复核输出长度上限（成本闸） |

环境变量：`BOUNTY_GUARD_API_KEY`（或 `OPENAI_API_KEY`）、`BOUNTY_GUARD_BASE_URL`（或 `OPENAI_BASE_URL`）、`BOUNTY_GUARD_MODEL`。

## 内置规则（JS 10 条 + Python 4 条）

| 规则 | 严重度 | 说明 |
|---|---|---|
| `xss-inner-html` | 高危 | innerHTML 拼接不可信输入（支持跨行赋值拼接） |
| `xss-react-html` | 高危 | React dangerouslySetInnerHTML 注入动态内容（sanitize 豁免） |
| `xss-html-sink` | 高危 | document.write / jQuery .html() 写入动态内容 |
| `weak-random-crypto` | 中危 | 加密/凭证场景使用 Math.random |
| `hardcoded-secret` | 高危 | 硬编码密钥 / API Key（豁免环境变量与占位符） |
| `dangerous-eval` | 高危 | 动态代码执行 |
| `weak-hash-password` | 高危 | MD5/SHA1 用于密码（上下文感知） |
| `sql-concat` | 高危 | SQL 字符串拼接 |
| `cmd-exec-concat` | 高危 | shell 命令拼接、spawn 交 shell 的动态 -c 参数 |
| `plain-http` | 低危 | 对外明文 http 请求（豁免 localhost） |

规则设计原则：**宁可漏报不可误报**，每条规则都配正反用例（142 项测试全绿）。

**Python 子集**（`.py` 文件，多语言第一步）：

| 规则 | 严重度 | 说明 |
|---|---|---|
| `py-dangerous-eval` | 高危 | eval / exec / compile 动态执行 |
| `py-weak-hash-password` | 高危 | MD5/SHA1 用于密码（上下文感知） |
| `py-sql-concat` | 高危 | SQL 拼接（+ / % 元组 / .format / f-string） |
| `py-hardcoded-secret` | 高危 | 硬编码密钥常量（豁免 os.environ 与占位符） |

误报豁免两级开关：单行在行尾加 `// bounty-guard-ignore` 注释即可跳过；测试文件（tests/、`*.test.*`、`*.spec.*`）默认整体跳过，`scanTests: true` 可开启；单条规则可用 `disabledRules` 按 id 关闭。

## 开发

```bash
npm ci
npm run dev -- scan --git   # 本地跑 CLI
npm test                     # 142 项测试
npm run lint                 # tsc --noEmit
```

每周五 dogfood：用自己的代码喂自己的扫描器。

## Roadmap

- [x] Week 1 规则引擎（diff 解析器 + 8 条种子规则）
- [x] Week 2 LLM 复核层（OpenAI 兼容 + 优雅降级）
- [x] Week 3 GitHub Action（粘性评论 + 门禁）
- [x] Week 4 发布（npm / v0.1.0 / 误报率数据）
- [ ] v0.2 AST 分析、多语言
- [ ] v0.3 自动修复 PR

## License

MIT
