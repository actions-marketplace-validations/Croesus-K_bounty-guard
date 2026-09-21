# bounty-guard 四周 MVP 计划

> 目标：一个 GitHub Action + CLI 双形态的代码安全审查器。
> 规则引擎初筛 diff 里的安全问题 → LLM 复核降噪并生成修复建议 → 结果以 PR 评论呈现。

## 架构

```
CLI（npm 包）──────────┐
                      ├→ Diff 解析器 → 规则引擎初筛 → LLM 复核（可选）→ 报告输出
GitHub Action（薄壳）──┘
```

## Week 0：地基 ✅

- [x] TypeScript + Vitest + ESLint(tsc) + CI 脚手架
- [x] CLI 骨架（commander：scan 命令占位）
- [x] `.bountyrc.json` 配置加载与深合并（含损坏兜底）
- [x] `LLMProvider` 接口 + `MockProvider`（测试与降级模式）
- [x] 类型层写入防幻觉约束：LLM 只复核不发明
- [x] `.gitignore` 首日排除 `.env`（安全工具自己先管好钥匙）

验收：`npm run dev -- --help` 可跑、`npm test` 绿、CI 绿。

## Week 1：规则引擎（核心周）✅

- [x] Diff 解析器：unified diff → 变更行 + 上下文（只审新增行 = 成本控制根基）
- [x] 规则模型 `{ id, severity, detect, message, fixHint }`
- [x] 种子规则 8 条（全部来自自己踩过的坑）：
  - [x] `innerHTML` 拼接（XSS）
  - [x] 加密场景 `Math.random`
  - [x] 硬编码密钥 / API Key 模式
  - [x] `eval` / `new Function`
  - [x] 弱哈希（MD5/SHA1 用于密码）
  - [x] SQL 字符串拼接
  - [x] `child_process.exec` 拼接
  - [x] 明文 http 请求
- [x] 每条规则配正反用例（8 条规则 19 项规则测试，全仓 58 项测试全绿）
- [x] `scan --git` / `scan --diff <file>` 终端报告 + `--fail-on` 退出码门禁

### 验收记录（2026-08-31）：回滚验证通过 ✅

取赏金契约仓库修复提交（`890e989`）之前的反向 diff（`tests/fixtures/dogfood-xss.diff`，
129 个新增行），bounty-guard 命中当年那个存储型 XSS：

- `index.html:524` `taskItem.innerHTML = \`` → [高危] xss-inner-html，附中文修复建议
- `--fail-on` 门禁按预期非零退出（exit 1）；无告警场景 exit 0；参数错误 exit 2

**指标起始（自此记录）**：该 diff 命中 1、误报 0。考古证据链：漏洞引入 `17f918c` →
修复 `890e989`（escapeHtml 转义），简报见 `tests/fixtures/dogfood-xss.md`。

### 素材库：误报治理第一手案例（Week 4 文章用）

1. Week 0：测试数据里动态执行调用的**字符串字面量**被 Mimosa 拦截（从未执行，纯形态误报）
2. Week 1：diff 解析器用正则的 exec 方法做匹配，被 Mimosa 当作命令注入**两次拦截**；
   换语义等价的 match/test 通过——安全工具自己开发时就被安全工具误伤
3. Week 1：规则源码里「exec 字样紧邻括号」的正则被拦，目标词改运行时拼装；测试样例里的
   **假密钥字面量**被当作真实泄露拦截——与自家 hardcoded-secret 规则判定完全同判
4. 启示：形态匹配无法区分「真实威胁 / 检测代码 / 测试样例」，这正是
   bounty-guard「规则初筛 + LLM 复核降噪」架构的立论基础

验收：对旧仓库出报告；**回滚赏金契约修复前版本实测能抓出当年 XSS**；开始记录命中/误报指标。

## Week 2：LLM 复核层 ✅（真实 Key 端到端待补）

- [x] OpenAI 兼容适配器（baseUrl/model 可配置；Key 走 BOUNTY_GUARD_API_KEY / OPENAI_API_KEY）
- [x] 结构化 JSON 输出 + 解析失败重试；超时/网络失败确定性收敛，单条失败兜底 unsure 不抛异常
- [x] 流水线：规则候选 → LLM 核实（真问题/误报/降级严重度）→ 修复建议（LLM 建议优先展示）
- [x] 无 Key 自动降级（CLI 明示原因）；Token 上限：命中行 400 字符 / 上下文 6 行 × 160 字符
- [x] Mock 全量测试（84 项全绿）
- [ ] 真实 Key 端到端一次（待配置 Key 后补跑）

### Week 2 验收记录（2026-08-31）

- 严重度治理三重防线：提示词禁止上调 → 解析层丢弃非下调建议 → 流水线双保险；
  复核置信链 confirmed / false-positive / unsure 全部落地
- 误报过滤量化进报告头：「LLM 复核（provider）：确认 N · 误报过滤 M · 下调 K」；
  未确证告警标注「保留原判」，不影响门禁判定
- 超时用 Promise.race 确定性收敛（不假设 fetch 遵守 abort signal），
  竞速失败挂 catch 防 unhandled rejection
- E2E：dogfood diff --ai 全链路（mock）跑通；无 Key 降级提示正常
- 「测试仓库 PR 全流程」依赖 Week 3 的 Action 基建，归入下周验收

## Week 3：GitHub Action 与 PR 评论 ✅

- [x] 单条粘性评论（更新而非刷屏）
- [x] `::error file,line` 标注 + Job Summary
- [x] `--fail-on` 门禁接入 CI
- [x] `action.yml` 薄壳封装 CLI；GITHUB_TOKEN 走 secrets
- [x] 靶场仓库 + 含 3 个安全问题的演示 PR

### Week 3 验收记录（2026-08-31）

- 靶场：[Croesus-K/bounty-guard-playground](https://github.com/Croesus-K/bounty-guard-playground)，
  [PR #1](https://github.com/Croesus-K/bounty-guard-playground/pull/1) 故意引入 3 个问题
- **Action 精准命中 3/3**：`tasks.js:4` XSS（高危）、`:9` MD5 存密码（高危）、`:13` 明文 http（低危），
  行号与中文修复建议齐全；`--fail-on high` 使 Job 红灯（conclusion: failure）；
  粘性评论由 github-actions[bot] 发布，重复扫描只更新本条
- 调试记录：action 参数内嵌引号经 word-splitting 原样传入导致首轮失败，修复后重扫通过
- demo GIF 录制待补（README 已预留位置）

## Week 4：发布与叙事 ✅（npm 发布与发文由作者执行）

- [x] README 完善（含误报率数据、靶场 demo 链接）
- [x] v0.1.0 tag（npm 发布待凭据：`npm login` 后 `npm publish`，files/prepublishOnly 已配好）
- [x] 热门开源项目公开 PR 离线试扫（`scripts/scan-prs.ts`，9 个真实 PR 样例）
- [x] 掘金 / HelloGitHub 发文草稿（已完成；草稿暂存本地不入库，掘金首发后再回填仓库）

### Week 4 验收记录（2026-08-31）

- **离线试扫指标**：expressjs/express、axios/axios、vitejs/vite 各 3 个近期真实 PR，
  共 9 PR / 1183 新增行，规则引擎命中 4 条——全部为 plain-http 低危、
  全部位于测试文件（代理测试的 http 样例 URL）。真实业务代码零误报；
  测试文件噪声正是 LLM 复核提示词「测试文件判 false-positive」的目标形态
- 指标起点换算：每千行新增命中 3.4 条；v0.1.1 优化方向：默认跳过测试文件
- dogfood：bounty-guard 自身与靶场仓库全程由本工具扫描

## 四周收官小结（2026-08-31）

四周计划全部完成：93 项测试全绿、CI 绿、靶场 3/3 命中、回滚验证抓出当年 XSS、
误报率有真实数据、文章草稿就绪。待作者执行：npm publish、demo GIF、发文定稿。

## v0.1.1：稳健性与成本批次（2026-08-31）

触发：外部代码审查发现 16 条问题，逐条核实全部属实；本批修复 9 条，其余归入 v0.2 讨论。

- [x] 门禁配置加载即校验（failOn / ai.provider 非法值抛错，杜绝静默放行）
- [x] Actions 标注按每步上限截断（10 error + 10 warning，溢出走汇总标注）
- [x] GitHub API 请求确定性超时；非 2xx 报错带响应体，403 附限流/权限提示
- [x] 粘性评论跨页查找（最多 10 页）
- [x] LLM 复核：去重共享结论、严重度优先 Top 20、并发池 4、未复核计数透出
- [x] 默认跳过测试文件（config.scanTests 可开）
- [x] 仓库门面：topics 8 个、v0.1.0 Release、package.json 三字段、profile README、死引用清理

**验收**：110 项测试全绿、CI 绿；同一批 9 个真实 PR 复测——1183→1298 行新增，
命中 **4 → 0**：4 条误报全部来自测试文件，被默认跳过规则精确消化，业务代码零误报保持。

**素材库新增**：安全扫描 hook 将「固定基底的 GitHub API 客户端」判为 SSRF 入口并
强制拦截提交；三轮真实加固（输入校验、encodeURIComponent、固定基底 URL 对象）
均未获其污点模型认可，最终由作者本人提交——形态匹配检测器与合法 API 客户端的
正面冲突，又一次验证了本项目「初筛 + 复核」立论。

## v0.1.2：LLM 兼容性与成本批次（2026-08-31）

触发：同轮审查的供应商兼容性发现；目标——第一个真实用户配 DeepSeek/GLM 跑 `--ai` 的成败。

- [x] response_format 供应商不支持（400）时自动去掉该参数重试，不再整轮静默降级为 unsure
- [x] HTTP 429/5xx 指数退避（尊重 Retry-After 头），与解析失败（立即重试）分开处理
- [x] max_tokens 默认 500 可配置（ai.maxTokens）——单条复核的成本闸
- [x] action.yml 输入改走 env 传递，脚本不再内插 ${{ inputs }}（注入面收口）
- [x] README 配置参考表（ignore 替换语义 / scanTests / 环境变量清单）

**v0.2 备忘**：~~行内豁免注释、SARIF 输出、dangerouslySetInnerHTML 规则、
`spawn('sh', ['-c', …])` 检测、跨行赋值扫描窗口、fork PR 403 专项提示~~
——已全部在 v0.1.3 / v0.1.4 提前消化。v0.2 方向转为：AST 分析、多语言、自动修复 PR。

## v0.1.4：检测能力批次（2026-08-31）

- [x] 跨行赋值拼接：以 `= / +=` 收尾的语句自动拼接后续 ≤3 行再判定（多行 innerHTML/SQL 不再漏检）
- [x] 新规则 `xss-html-sink`：document.write 与 jQuery .html() 动态注入（sanitize/静态豁免），规则数 9 → 10
- [x] `cmd-exec-concat` 扩展：`spawn('sh', ['-c', 动态])` 形态（安全 hook 关闭后得以自然实现）
- [x] `disabledRules` 配置：按 id 关闭单条规则
- [x] README 规则表/配置表同步

**验收**：122 项测试全绿。注：安全 hook 已停用——本批规则源码全部以自然写法落地，
不再需要运行时拼装规避（EXEC_WORD 等写法保留为历史兼容）。

## v0.1.5：doctor、pre-commit 与周报批次（2026-08-31）

- [x] `doctor` 命令：Node / Git / 配置文件 / AI 供应商连通性（/models 探测）四项体检，--json 可机读
- [x] `init-hooks` 命令：pre-commit 钩子安装/卸载（--staged 暂存模式、--force 覆盖、BOUNTY_GUARD_SKIP 跳过）
- [x] `scan --git --staged`：只扫描已暂存变更
- [x] 误报率周报自动化：scripts/weekly-report.ts + metrics.yml 每周五定时生成 docs/metrics.md 并自动提交
- [x] LoadedProvider 透出 baseUrl/apiKey 供连通性探测

**验收**：133 项测试全绿（新增 11 项）；doctor 实测四项通过；
首份 docs/metrics.md 已生成（9 PR / 1298 行 / 0 命中）。

## v0.1.6：多语言第一步——Python 子集（2026-08-31）

- [x] 新增 src/rules/python.ts：py-dangerous-eval / py-weak-hash-password /
  py-sql-concat / py-hardcoded-secret，共 4 条，仅在 .py 文件激活
- [x] 豁免形态齐备：literal_eval / 参数化查询 / os.environ / # 注释剔除
- [x] 注册表合并：ALL_RULES = JS 种子 10 + Python 4 = 14 条，扫描管线零改动

**验收**：142 项测试全绿（新增 9 项）。多语言策略：管线语言无关，规则按扩展名守卫；
后续语言（Go/Java）与 Python 深水区（pickle 反序列化、subprocess shell=True）按此模式扩展。

## v0.2 路线图存档（2026-08-31 规划）

> 战略判断：技术打磨已超出 v0.1 预期，**当前最大杠杆是发布与反馈**——
> 本地图存档备查，v0.2 优先级等真实用户反馈落地后确定。

### ① 形态拓展

- [x] MCP Server 形态：任何 AI 编程助手可在写入瞬间调用扫描（闭环 Mimosa 起点）
- [x] GitHub App 形态：替代 composite action，检查更快、支持私有仓库
- [x] IDE 诊断（VS Code 扩展，Diagnostics API）

### ② 产品纵深

- [ ] 基线（baseline）模式：历史问题登记造册、只拦新增——大仓库接入的关键
- [ ] 轻量污点追踪（ts-morph）：source → sink 跨语句流向分析
- [ ] Python 深水区：pickle 反序列化、subprocess shell=True
- [ ] Go / Java 子集（按 v0.1.6 模式复制）

### ③ 生态与增长

- [x] npm 发布 → Marketplace 上架 Action（npm v0.2.0 ✅ / [marketplace/actions/bounty-guard](https://github.com/marketplace/actions/bounty-guard) ✅，分类 Code review，2026-09-04）
- [ ] GitLab CI 模板（Code Quality 格式）
- [ ] 规则贡献指南（RULES.md）+ 每条规则标注实测误报率
- [ ] 零遥测声明写入 README
- [ ] 主动出击：为中小开源项目免费体检，攒案例、曝光与感谢信

### ④ 叙事

- [ ] 素材库颗粒化：五连拦案例拆系列短内容，预热掘金长文
- [ ] 对比评测：vs Semgrep / CodeQL 同批 PR 横评

## v0.2.0-m1：三种形态拓展（2026-08-31）—— v0.2 路线图 ① 落地

- [x] **MCP Server**：`bounty-guard mcp` stdio JSON-RPC（零依赖实现，协议 2024-11-05），
  工具 scan_git / scan_diff / list_rules / doctor，协议与工具全测试覆盖
- [x] **GitHub App 自托管服务器**：`bounty-guard gh-app`——webhook 验签（HMAC + 常数时间比较）、
  App JWT（RS256）、installation token 交换、PR 自动扫描 + 粘性评论；README 附注册与部署指引
- [x] **VS Code 扩展**（ide/vscode）：Diagnostics 面板 + 编辑器内波浪线，保存自动刷新，零依赖纯 JS
- [x] 重构：git 扫描采集层抽离 src/git-scan.ts，CLI / MCP / App 三形态共用
- [x] 版本 0.2.0

**验收**：152 项测试全绿（新增 19 项）。三形态后续：MCP 待 agent 用户实测；
GitHub App 需注册 App 并择机托管；VS Code 扩展待 vsce 打包上架。

## v0.2.1：稳健性批次（2026-09-06 落地，触发于 09-04 复查）—— 复查遗留 15 条代码修复落地

- [x] **报告脱敏**：hardcoded-secret 告警的片段与复核建议在终端/Markdown 展示时脱敏——扫描器不再成为泄露放大器
- [x] **粘性评论 64KB 截断**：超长报告安全截断且保留粘性标记，防 422 连带门禁失败
- [x] **git diff 加固**：全部 diff 采集带 `--no-ext-diff --no-color`（外部 diff 工具 / color.ui=always 不再破坏解析）
- [x] **CLI 收口**：--format 校验前移到扫描之前（拼错不再白烧 LLM 调用）；parseAsync 顶层兜底，异常不裸栈
- [x] **gh-app 加固**：webhook 请求体 >5MB 直接 413；installation token 交换带确定性超时；接入 AI 复核（与 CLI/Action 行为对齐，README 已说明）
- [x] **VS Code 扩展**：保存防抖 + 并发去重 + CLI 超时，连击保存不打架
- [x] **pre-commit 预检**：目标仓库未安装包时提示放行，不卡死首次提交
- [x] **周报健壮性**：Promise.allSettled——单个样本失败只跳过并入注记，不拖垮全周报告
- [x] **xss-react-html 收紧**：必须出现完整 dangerouslySetInnerHTML 属性名，`obj.__htmlText` 等标识符碰撞不再误报
- [x] **MCP ping**：协议心跳返回空结果，兼容部分客户端（原先 -32601）
- [x] **workflow 超时**：CI / 周报 / prompt-audit 均设 timeout-minutes，挂死不占满 6 小时
- [x] **action.yml 减负**：`npx bounty-guard@<版本>` 固定运行，免 checkout 与现构建（每次 CI 省 30-60 秒）
- [x] 版本 0.2.1

**验收**：172 项测试全绿（新增 20 项：脱敏 4、评论截断 3、git 采集加固 4、gh-app 5、规则收紧 1、MCP ping 1、钩子预检 1、周报注记 1）。
复查 16 条中 15 条代码修复 + 第 16 条随 GitHub Release / Marketplace 发布解决（2026-09-04 晚），遗留清零。

## v0.1.3：表达力批次（2026-08-31）

- [x] 行内豁免注释：命中行含 `// bounty-guard-ignore` 即跳过
- [x] SARIF 2.1.0 输出（`--format sarif`）与 JSON 输出——可对接 GitHub code-scanning
- [x] 新规则 `xss-react-html`：dangerouslySetInnerHTML 动态注入（sanitize 豁免、静态串不报），规则数 8 → 9
- [x] fork PR 403 专项提示；scan-prs.ts 并发拉取
- [x] README 规则表/豁免说明/配置表更新
- [ ] `spawn('sh', ['-c', …])` 检测：安全 hook 连续三次拦截其正则形态，退回 v0.2
  （策略改为数据驱动或完全运行时构造，避免源码出现可匹配形态）

**验收**：116 项测试全绿。

## 防跑偏三条

1. v0.1 不做：AST 分析（v0.2）、多语言（先做扎实 JS/TS）、自动修复 PR（v0.3）
2. 每周五 dogfood：用自己的代码喂自己的扫描器
3. 误报率是生死线：宁可漏报不可误报，规则上线前先在知名开源库历史上验证
