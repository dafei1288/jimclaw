# JimClaw: 拟人化多智能体协作进化系统

JimClaw 是一个借鉴了 Claude Code、OpenClaw 和 OpenCode 设计理念的智能体系统。它通过拟人化的角色设定、执着的循环迭代（Sisyphus 协议）以及架构师仲裁机制，实现高度自主的代码开发与维护。

## 核心特性

### 拟人化团队协作
| 角色 | 名字 | 职责 |
|------|------|------|
| PM | 观止 | 任务契约定义、子任务拆解、复盘总结 |
| Architect | 独孤 | 技术设计、API 契约、冲突仲裁 |
| Coder | 星河 | 代码实现、文件级自纠错 |
| QA | 清扬 | 结构化失败分析、质量评估 |

### Sisyphus 协议（编写-运行-修复闭环）
- **文件级自纠错**：每个文件独立重试最多 3 次，失败立即触发 LSP 诊断和重写。
- **定向修复**：QA 返回结构化失败信息（`failedFiles` / `testErrors` / `failedTestNames`），coder 只重跑失败文件，跳过已通过文件。
- **package.json 哈希**：检测依赖变化，无变化时跳过 `npm install`，提升重试效率。

### 架构师仲裁机制（新）
当 coder 自救失败 2 轮后，架构师（独孤）自动介入：
1. 全量分析所有文件内容 + QA 失败报告 + API 契约。
2. 输出绑定性 `MediationDirective[]`，精确到每个文件的字段/函数/返回值。
3. Coder 后续迭代强制执行这些指令，直到通过或达到 `maxRetries`。

典型解决场景：`package.json` 缺少测试依赖、API 路径不一致、HTTP 状态码与测试预期不符等跨文件契约冲突。

### 多端实时监控
- **TUI**：终端彩色实时仪表盘，每个节点输出结构化摘要。
- **Web 看板**：Socket.io + React，展示阶段进度、子任务状态、QA 失败详情、仲裁指令（橙色面板）。

### 进化型长期记忆
- 每次任务结束后自动复盘，经验写入 `KNOWLEDGE.md`。
- 每个 Agent 启动时读取知识库，持续学习历史教训。

---

## 工作流

```
pm → architect → contract_sync → [approval] → orchestrator → coder → infra_setup → terminal → qa
                                                                 ↑         ↑                    |
                                                                 |         └─ architect_mediation|
                                                                 |           (retryCount >= 2,   |
                                                                 |            首次触发)           |
                                                                 └──── 继续重试至 maxRetries ─────┘
                                                                                                  ↓
                                                                                    deploy → post_mortem → persistence
```

**QA 路由规则：**
- 通过 → `deploy`
- `retryCount >= maxRetries` → `post_mortem`（放弃）
- `retryCount >= 2` 且未仲裁 → `architect_mediation`（首次仲裁）
- 其他 → `coder`（继续重试）

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 核心编排 | LangGraph.js（状态机） |
| Agent 框架 | LangChain（多模型支持） |
| 类型校验 | Zod（运行时 Schema 验证） |
| 语言 | TypeScript / Node.js |
| 终端 UI | chalk（彩色输出） |
| Web UI | Express + Socket.io + React + TailwindCSS |
| 代码诊断 | LSP Diagnose Skill + Lint Fix Skill |

---

## 快速开始

### 1. 配置环境

```bash
cp .env.example .env
# 填写 ANTHROPIC_API_KEY 等密钥
```

### 2. 安装依赖

```bash
npm install
```

### 3. 运行

```bash
# 推荐：终端实时监控
npx ts-node src/tui.ts "实现一个 todo list REST API，带完整测试"

# 从 checkpoint 恢复并继续执行
npx ts-node src/index.ts --replay workspace/run_xxx coder_final-r2

# Web 看板（访问 http://localhost:3000）
npx ts-node src/server.ts

# 标准命令行
npx ts-node src/index.ts "你的任务需求"
```

---

## 项目结构

```
src/
  core/
    graph.ts      # 完整状态机定义（节点、边、所有状态类型）
    agent.ts      # BaseAgent 基类（Persona + 模型 + 记忆注入）
    skill.ts      # Skill<T> 泛型工具封装
  agents/
    team.ts       # 四个 Agent 实例定义
  skills/
    file_read.ts / file_write.ts / shell_exec.ts
    docker_exec.ts / playwright_exec.ts / health_check.ts
    lsp_diagnose.ts / lint_fix.ts
  utils/
    models.ts     # ModelManager（读取 jimclaw.config.json）
  tui.ts          # 终端实时界面
  server.ts       # Web 后端 + Socket.io
  index.ts        # 标准 CLI 入口
public/
  index.html      # React Web 看板（单文件，含仲裁指令面板）
workspace/        # 每次运行的隔离产物目录（gitignored，含 boulder.json / trace-index.json / token-usage.json / checkpoints/ / nodes/）
KNOWLEDGE.md      # 自动进化的知识库（post_mortem 节点写入）
jimclaw.config.json  # 模型配置、maxRetries、workspace 路径
```

---

## 配置说明

**`jimclaw.config.json`** 主要字段：

```json
{
  "maxRetries": 5,
  "workspace": "workspace",
  "evolution": true,
  "models": {
    "anthropic_strong": { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022" },
    "minmax": { ... },
    "glm": { ... }
  }
}
```

智谱相关配置请通过环境变量提供，避免把密钥写入仓库：

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
```

---

## 当前优先级

当前路线已调整为先补执行完整性，再扩展新能力：

1. 执行完整性与回归测试：补齐坏文件拦截、状态一致性、失败 run 摘要与纪要保底
2. 状态追踪增强：已补 `trace-index.json` 和 `checkpoints/` 作为基础索引与成功节点锚点，后续继续扩展任务溯源图谱和分支回溯入口
3. 编排能力增强：容器资源配额配置化、并行子任务、多 workspace 会话
4. 前端生态扩展：Vue / React / Svelte 支持、组件测试、E2E 测试

当前还提供了两个恢复预览接口：

- `GET /api/workspace/checkpoints`：列出当前 run 的 checkpoint
- `GET /api/workspace/checkpoint?id=<checkpointId>`：返回 checkpoint 的 replay 预览状态

另外支持 CLI 续跑：

- `npx ts-node src/index.ts --replay <workspacePath> <checkpointId>`：从指定 checkpoint 继续执行，并复用原 workspace 与 trace 链

Web 端的 workspace 页也提供了 checkpoint 列表和“继续”按钮，可直接从当前 run 的锚点续跑；续跑不会新建 `run_*`，而是在原 workspace 内继续写入 `boulder.json / trace-index.json / checkpoints/`。
另外，核心工具层已经补了 workspace 产物一致性校验，用于检查 `boulder.json / trace-index.json / checkpoints` 之间的 trace、节点和 round 是否对齐，以及 `subTasks` 和 `trace-index.files` 是否联动一致，后续回放和溯源图谱会直接复用这套规则。
针对最新 run 暴露出的工具链问题，`lint_fix` 现在会把 `prettier` 的安装/网络不可用识别为非阻塞环境告警，不再把这类瞬时工具问题误判成代码失败；但真正的 `prettier` 解析/语法错误仍然会阻塞。
另外，`coder` 现在会遵守 `orchestrator` 产出的文件依赖顺序，只处理依赖已完成的子任务，避免先写 controller、后补 model/service 这类跨文件契约漂移。
现在还新增了“阻塞即停”策略：当 `coder` 在某个文件上遇到结构校验失败、持久化失败等阻塞错误时，会立即停止本轮后续文件生成，并直接路由到 `qa`，不再继续消耗 token 乱写后续文件。
与之配套，`qa` 对 `[Coder 阻塞失败]` 走确定性收敛路径，只围绕真实阻塞文件生成工单，不再把仍处于 `pending` 的文件一并扩散成缺陷。
另外，Agent 基础层已增加模型 fallback：当当前 mode 的模型遇到 429、5xx 或网络类可重试故障时，会自动切到同一 Agent 的其他可用 mode 继续调用，并在审计日志里记录切换过程。
`fix_plan` 还增加了节点级降级：如果 `coder` / `qa` 的模型都因额度或资源问题不可用，会直接生成规则化修复计划，避免修复链路整体崩溃。
根据智谱 Coding Plan 的官方说明，复杂代码生成/诊断任务已统一切到 `coding` mode：`coder_node`、`qa_node` 深度审计、`fix_plan` 的 coder/qa 协商都走 `coding_plan -> glm-5`，普通产品/架构分析仍保留默认模型。
另外，系统现在会按 run 记录 token 用量：每次模型调用都会写入 `workspace/run_xxx/token-usage.json`，`trace-index.json` 里也会保留聚合后的 `tokenUsage` 汇总，可按 agent 查看调用次数和 token 消耗。
Web 看板的“决策与质量看板”页现已重构为“指挥台”布局：顶部只显示当前节点 / 阻塞信息 / token 成本，右侧单独显示节点时间线，下方单独显示文件产出与项目共识；任务进度仅以 `subTasks` 为准，token 仅以 `token-usage.json` / `trace-index.tokenUsage` 为准，避免页面出现多套互相冲突的进度口径。服务端同时提供 `GET /api/workspace/metrics` 供页面刷新时拉取最新指标。
另外，QA 放行规则已经收紧为“证据优先”：只要 `testResults` 中仍有 `Verifier 预检失败`、测试失败、编译失败、部署失败或 `Coder 阻塞失败` 的明确证据，就不会被视为通过；即使 LLM 返回空 issue，也会生成兜底工单，禁止出现“日志失败但 QA 放行”的歧义状态。
关键节点的结构化纪要也已补齐到 `workspace/run_xxx/nodes/`：`infra_setup`、`terminal`、`verifier`、`qa`、`deploy` 现在都会写结论纪要，`trace-index.json.timeline` 可直接串起“环境是否就绪、测试是否通过、Verifier 为什么拦截、Deploy 为什么失败”这一整条链路。
另外，核心测试现在不只覆盖 node 级逻辑，还补了 workflow replay harness：会用固定场景回放完整 graph，验证 `Verifier 失败不得误放行到 deploy`、`deploy 失败必须落证据并归因到 deploy`，避免以后节点各自看起来都对、串起来又犯同样的错。
另外，workspace 一致性校验器现在也升级成“证据链真相校验”：不仅检查 `boulder.json / trace-index.json / checkpoints`，还会校验 `meetingNotes` 文件是否存在、`lastFailure` 是否能在对应纪要里找到，以及关键失败节点是否在对应 `audit/*.md` 里留下证据，避免出现“状态说失败了，但纪要和审计对不上”的半可追溯状态。
为了解决“有日志但难以程序化追溯”的盲区，系统现在还会把关键事件同步写入 `workspace/run_xxx/audit/events.jsonl`：其中包含 `agent-message`、`state-update`、`task-finished`、`task-error` 等结构化事件，可直接作为后续溯源、统计和 fixture 提取的事实源。
另外补了失败 run 提炼工具：可执行 `node scripts/extract_run_fixture.js <workspace/run_xxx> [outputFile]`，把 `boulder.json`、`trace-index.json`、`token-usage.json`、`nodes/*.md`、`audit/*` 收敛成单个 fixture 文件，供 workflow replay 和前端快照测试复用。
前端可观测性这边也补了 dashboard snapshot harness：固定 session 快照渲染指挥台页面，强制校验“节点时间线、文件产出、token 成本、项目共识”四条信息带不串口径，避免页面再次出现节点、日志、文件进度彼此对不上的回归。
另外，部署链路已完成一轮真正的端到端收口：`infra_setup` 现在会在非 compose 路径下先 `npm install` 再按需执行 `npm run build`；compose 路径改为先 `docker-compose build`，再启动空闲测试容器，避免业务容器自启动干扰测试；`deploy` 会把后台启动进程的 PID 和启动日志写入 `/tmp/jimclaw/server.pid` 与 `/tmp/jimclaw/server.log`，健康检查优先使用 API 契约中的 GET 路径，并在宿主机上通过 `127.0.0.1:<allocatedHostPort>` 验证，而对外展示地址仍保留真实 IP。

## 最新验证

- 最新成功闭环 run：`workspace/run_1774415632972`
- 结果：`pm -> architect -> orchestrator -> coder -> env_guard -> infra_setup -> terminal -> verifier -> deploy` 全链路通过
- 对外访问地址：[http://100.74.126.56:4001](http://100.74.126.56:4001)
- 当前核心回归：`npx tsc --noEmit` 通过，`npm run test:core` 为 `51/51`

---

## 进度

详见 [TODO.md](./TODO.md)
## 2026-03-24 Note

- Latest false-negative root cause was not dependency ordering anymore.
- A transient `lint_fix` / `prettier` failure could remain sticky and mark a task failed even after `write_file` produced valid final code.
- `coder_node` now trusts the final structurally valid code path over that earlier transient tool failure.
- `coder_node` now also writes per-file recovery intents before snapshot persistence, and the graph replays them on startup or `SIGINT` / `SIGTERM`, so interrupted runs no longer lose already-written file progress as easily.
- `coder_node` now also stops the round immediately on a blocking file failure and routes to `qa`, instead of continuing to generate later files and wasting tokens.
- `qa_node` now keeps `[Coder 阻塞失败]` focused on the actual blocked file, and no longer treats untouched pending files as defects in that branch.
- `BaseAgent` now has retryable model fallback across available modes, so 429 / 5xx / network failures no longer immediately crash the whole node when another mode is available.
- `fix_plan_node` now degrades to a deterministic repair plan when both LLM calls are blocked by quota/resource failures.

## 2026-03-26 Note

- 引入 `ExecutionProtocol v1`，由 `architect` 产出并进入 state，开始把“给 LLM 看的文字”升级成机器可执行协议。
- 当前已协议化并机器执行的内容：
  - 测试布局：Node/Jest 项目统一到 `tests/`，`verifier` 校验 `roots/testMatch` 是否覆盖声明的业务测试。
  - 文件角色：`route/controller/service/model/middleware/test/config/infra/entry` 进入结构化协议。
  - 依赖角色约束：`coder` 会校验当前文件是否引用了协议不允许的文件角色。
  - 协议摘要注入：`buildSystemContext` 会向下游节点注入 `entryFiles/testRoots/healthCheckPath` 摘要。
- 当前仍未完全协议化的部分：
  - `orchestrator` 坏 DAG 还未完全前移到协议层即打回。
  - `qa` 还未完全以 `ProtocolFailure` 替代自然语言失败摘要。
  - `dashboard / trace-index` 已接入 `protocolFailures / protocolPatches` 可观测化，但尚未把所有质量面板都统一收敛到协议对象。

2026-03-26 可观测化补充：

- `fix_plan / architect_mediation` 现已产出 `ProtocolPatch[]`，并会自动应用到 `executionProtocol`。
- `trace-index.json` 现已包含 `protocolFailures / protocolPatches`，协议失败与协议补丁可以和 `lastFailure / fileChanges / timeline` 一起追溯。
- Web 指挥台新增“执行协议”面板，展示：
  - 当前协议摘要（runtime / testRoots / entryFiles / healthCheckPath）
  - 当前协议失败
  - 当前协议补丁
- 服务端 `session-sync / state-update` 已同步 `executionProtocol / protocolFailures / protocolPatches`，不再只在 state 内部保留。
