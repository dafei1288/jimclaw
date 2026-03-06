# JimClaw 架构文档

## 1. 概述

JimClaw 是基于 LangGraph.js 构建的多智能体代码开发系统。核心思路是通过拟人化团队角色分工、结构化状态机编排，以及分级冲突解决机制，实现从需求到部署的全流程自主开发。

所有 LLM 生成的代码在隔离 Docker 容器中执行，宿主机只做文件编写和诊断，杜绝生成代码对系统环境的直接影响。

---

## 2. 工作流全图

```
START
  │
  ▼
 pm ──→ architect ──→ contract_sync ──→ [approval]* ──→ orchestrator
                                                               │
                                                               ▼
                                             ┌─────────────── coder ◄────────────────────┐
                                             │                  │                         │
                                             │          infra_setup                       │
                                             │         (启动 Docker 容器)                 │
                                             │                  │                         │
                                             │              terminal                      │
                                             │           (容器内单元测试)                  │
                                             │                  │                         │
                                             │              verifier ──[失败]──────────────┘
                                             │           (静态预检，无 LLM)
                                             │                  │ [通过]
                                             │                 qa                         │
                                             │           (容器内集成/E2E)                  │
                                             │                  │                         │
                                             │    ┌─────────────┼─────────────┐           │
                                             │    │             │             │           │
                                             │  [pass]   [retry < 2]   [retry >= 2        │
                                             │    │             │        && !mediation]   │
                                             │    ▼             └──────────► architect_mediation
                                             │  deploy                       │           │
                                             │ (容器内启动)                   └───────────┘
                                             │    │                     (继续重试)
                                             │    ▼
                                             └─► post_mortem
                                                    │
                                                    ▼
                                               persistence
                                            (输出访问地址 / 清理容器)
                                                    │
                                                   END
```

`*` approval 节点仅在 `onEvent` 回调存在时激活（Web 模式）。

### QA 条件路由

| 条件 | 下一节点 |
|------|---------|
| `isDone === true` | `deploy` |
| `retryCount >= maxRetries` | `post_mortem` |
| `retryCount >= 2 && !mediationDirectives` | `architect_mediation` |
| 其他 | `coder` |

### Verifier 条件路由

| 条件 | 下一节点 |
|------|---------|
| `testResults` 以 `"[Verifier 预检失败]"` 开头 | `coder`（跳过 QA，直接修复） |
| 其他 | `qa` |

---

## 3. 核心数据类型

### 3.1 JimClawState（完整图状态）

```typescript
{
  messages: BaseMessage[]              // LangChain 消息历史
  teamChatLog: { sender, content }[]   // 拟人化团队对话日志
  userGoal: string                     // 用户原始需求
  contract: TaskContract | null        // PM 输出：任务契约
  spec: TechSpec | null                // Architect 输出：技术规范
  manifest: SystemManifest | null      // Architect 输出：资源清单
  apiContract: ApiContract | null      // Architect 输出：API 契约
  subTasks: SubTask[]                  // Orchestrator 输出：子任务列表
  code: string                         // JSON 字符串，key=文件路径，value=内容
  testResults: string                  // terminal/verifier/QA 输出的测试结果文本
  qaFailures: {                        // QA 结构化失败信息
    failedFiles: string[]
    testErrors: string[]
    failedTestNames: string[]
  } | null
  mediationDirectives: MediationDirective[] | null  // 架构师仲裁指令
  retryCount: number                   // coder→qa 循环次数
  isDone: boolean                      // QA 通过标志
  requiresApproval: boolean            // 人工审批等待标志
  deploymentStatus: { url?, status } | null
  packageJsonHash: string              // package.json MD5，跳过无变化的 npm install
  containerId: string                  // infra_setup 启动的 Docker 容器 ID
  projectBrief: string[]               // 团队共识：各节点累积追加，注入所有 agent
  codeLog: FileChangeEntry[]           // 文件变更记录，前端展示每轮改了哪些文件
}
```

### 3.2 各节点输出类型

```typescript
interface TaskContract {
  title: string
  requirements: string[]
  acceptanceCriteria: string[]
}

interface TechSpec {
  architecture: string
  language: string
  testCommand: string    // 非交互式，如 "node unit_test.js"
  runCommand: string     // 生产启动命令，如 "npx tsc && node dist/server.js"
  entryPoint: string     // 真实 IP + 端口，如 "http://10.1.2.3:4001"
  filesToCreate: string[]
  interfaces: string
}

interface SystemManifest {
  services: { name: string; port?: number; description?: string }[]
  environment: Record<string, string>
  sharedConfig: Record<string, any>
}

interface ApiContract {
  endpoints: {
    path: string          // 必须以 "/" 开头
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
    description: string
    requestBody?: any
    responseBody?: any
    parameters?: any
  }[]
}

interface SubTask {
  id: string
  description: string
  fileTarget: string      // 目标文件路径
  dependencies: string[]
  contextRequirement: string
  status: "pending" | "completed" | "failed"
  lastError?: string
}

interface MediationDirective {
  file: string    // 目标文件，如 "server.ts"
  action: string  // 类型标签，如 "ADD_DEPENDENCY" / "FIX_ENDPOINT"
  detail: string  // 精确到字段/函数/返回值的具体指令
}

interface FileChangeEntry {
  round: number
  file: string
  taskTitle: string
  status: "written" | "skipped" | "error"
  error?: string
}
```

---

## 4. 节点详解

### pm
- 输入：`userGoal`
- 输出：`contract: TaskContract`
- 校验：`TaskContractSchema`（Zod）
- 副作用：写 `workspace/contract.json`

### architect
- 输入：`contract`
- 输出：`spec, manifest, apiContract`
- 校验：`TechSpecSchema`（Zod）；API 端点静态校验（路径格式、方法合法性、重复检测）
- 副作用：写 `spec.json`, `manifest.json`, `api_contract.json`, `README.md`
- 关键约束（共 12 条）：
  - 端口通过 `find_free_port` 工具获取，`entryPoint` 使用真实 IP（`get_server_ip`），禁止 `localhost`
  - express 等运行时依赖进 `dependencies`，开发工具进 `devDependencies`
  - TypeScript 项目：`filesToCreate` 必含 `tsconfig.json`；`runCommand = npx tsc && node dist/server.js`（禁止 ts-node 启动）
  - 前端规则：含"前端/UI/web"关键词时 `filesToCreate` 必含 `public/index.html`；后端必须 `app.use(express.static('public'))`
  - **Docker 规则**：`app.listen(PORT, '0.0.0.0')`（容器需绑定所有网卡）；前端 API 调用用相对路径或 `window.location.origin`，禁止硬编码 IP/端口

### contract_sync
- 输入：`apiContract`
- 输出：修正后的 `apiContract`
- 逻辑：本地静态校验 + QA agent LLM 审查

### orchestrator
- 输入：`spec`
- 输出：`subTasks[]`
- 约束：首任务必须是 `package.json`，第二任务为核心入口文件，必须含测试文件

### coder
- 输入：`subTasks, spec, code, qaFailures, mediationDirectives`
- 输出：`code（更新）, subTasks（状态更新）, retryCount+1, codeLog`
- 内循环（每文件最多 3 次）：
  1. 生成代码（markdown 代码块提取）
  2. **Todo-Enforcer**：扫描 `// TODO` / `// FIXME` / `throw new Error('not implemented')` 等未完成标记，发现则强制重写
  3. LSP 诊断 → 有错误则重试
  4. Lint Fix → 自动格式化
  5. 如是测试文件，立即增量执行验证（容器存在时 `docker exec`，否则宿主机兜底）
- 外层跳过逻辑：retry 时只处理 `qaFailures.failedFiles` 中的文件
- **仲裁指令注入**：`mediationDirectives` 存在时，在 prompt 末尾追加 `[架构师仲裁指令 - 必须严格执行]` 段
- npm install：写入 `package.json` 时，宿主机安装（供 LSP 使用）+ 容器同步安装（供运行使用）

### architect_mediation
- 触发条件：`retryCount >= 2 && !mediationDirectives`（每次 session 最多触发一次）
- 输入：`spec, apiContract, code（所有文件内容）, testResults, qaFailures, retryCount`
- 输出：`mediationDirectives: MediationDirective[]`
- 校验：`MediationDirectiveSchema`（Zod）

### infra_setup
- **核心职责：启动 Docker 隔离容器**
- 镜像选择：`python:3.11-slim`（Python 项目）/ `node:20-alpine`（其他）
- 端口映射：从 `manifest.services[].port` 收集所有端口，全部 `-p port:port` 映射至宿主机
- 容器挂载：`-v WORKSPACE:/app -w /app`，工作目录 `/app`
- 资源限制：`--memory=1g --cpus=2`
- 重试复用：`docker inspect` 检查容器是否仍在运行，存活则复用，避免重复冷启动
- npm install：在容器内执行（`docker exec npm install --silent`）
- 输出：`containerId` 写入 state，供后续所有节点使用

### terminal
- 执行 `spec.testCommand`（NODE_ENV=test，90s 超时）
- 执行位置：**容器内** `docker exec ${containerId} sh -c "NODE_ENV=test ${testCmd}"`
- 输出写入 `testResults`

### verifier
- **Atlas 原则**：永不信任 Coder 的声称，独立读文件做静态验证（无 LLM 调用，秒级完成）
- 四项检查：
  1. `spec.filesToCreate` 中所有文件真实存在（防止 Coder 漏写文件）
  2. server 文件的 `require/import` 包都在 `package.json dependencies`（防止运行时 Cannot find module）
  3. server 文件含 `app.listen(` 或 `server.listen(`（防止服务器不监听）
  4. 测试文件含 `assert.` / `expect(` / `.equal(`（防止空壳测试永远通过）
- 发现问题：构造 `qaFailures`，`testResults` 前缀为 `"[Verifier 预检失败]"`，路由回 `coder`

### qa
- **阶段 1 — 单元测试**：读取 `terminal` 留下的 `testResults`，判断是否通过
- **阶段 2 — 启动服务**：在容器内后台启动，PID 写入 `/tmp/server.pid`
  ```
  docker exec -d <id> sh -c 'PORT=X <runCmd> & echo $! > /tmp/server.pid'
  ```
- **阶段 3 — 等待就绪**：从宿主机轮询 `http://127.0.0.1:PORT`（最多 30s，1s 间隔）
- **阶段 4 — 集成/E2E 测试**（从宿主机运行，通过映射端口访问容器服务）：
  - 含前端（`.html`）：QA agent 生成 Playwright E2E 测试，验证 UI 交互流程
  - 无前端：QA agent 生成 fetch-based 集成测试，验证 HTTP API
- **阶段 5 — 清理服务**：
  ```
  docker exec <id> sh -c 'kill $(cat /tmp/server.pid 2>/dev/null); rm -f /tmp/server.pid'
  ```
- 输出：`isDone, qaFailures（结构化失败信息）, projectBrief（有意义的错误摘要）`

### deploy
- 从容器内以后台方式启动生产服务：
  ```
  docker exec -d <id> sh -c 'PORT=X <runCmd>'
  ```
- 宿主机健康检查：`HealthCheckSkill` 轮询 `spec.entryPoint`（最多 60s）
- 输出：`deploymentStatus: { url, status: "running" | "failed" }`

### post_mortem
- PM agent 生成复盘总结，追加至 `KNOWLEDGE.md`

### persistence
- 写 `session.json`（完整最终状态快照）
- 清理旧 run 目录，保留最新 10 个
- **成功时**：打印成果分享信息
  ```
  ========================================================
  [成果] 🚀 应用已部署至 Docker 容器
  [成果] 访问地址 : http://10.1.x.x:PORT
  [成果] 服务端口 : api: PORT
  [成果] 容器名称 : jimclaw_run_<timestamp>
  [成果] 停止服务 : docker stop jimclaw_run_<timestamp>
  [成果] 删除容器 : docker rm -f jimclaw_run_<timestamp>
  ========================================================
  ```
- **失败时**：`docker rm -f <containerId>` 清理容器，释放端口和资源

---

## 5. Docker 容器生命周期

```
infra_setup   docker run -d --name jimclaw_<runId>
                          -p port1:port1 [-p port2:port2 ...]
                          -v WORKSPACE:/app -w /app
                          --memory=1g --cpus=2
                          node:20-alpine tail -f /dev/null
                          └── docker exec npm install --silent

terminal      docker exec <id> sh -c "NODE_ENV=test <testCmd>"

qa (server)   docker exec -d <id> sh -c 'PORT=X <runCmd> & echo $! > /tmp/server.pid'
qa (test)     node integration_test.js   ← 宿主机执行，访问映射端口
qa (kill)     docker exec <id> sh -c 'kill $(cat /tmp/server.pid)'

deploy        docker exec -d <id> sh -c 'PORT=X <runCmd>'

persistence   [成功] 保留容器（用户可继续访问）
              [失败] docker rm -f <id>
```

**重试时容器复用**：`infra_setup` 通过 `docker inspect --format='{{.State.Running}}'` 判断容器是否存活，存活则跳过 `docker run`，直接进行 npm install 检查。

---

## 6. 技能层（src/skills/）

| Skill | 用途 | 直接调用方 | Agent 工具 |
|-------|------|-----------|-----------|
| `file_read` | 读取 workspace 文件 | — | Architect, Coder |
| `file_write` | 写入 workspace 文件 | — | Coder |
| `shell_exec` | 执行 shell / docker exec | 所有节点 | QA |
| `docker_exec` | docker-compose 等 | infra_setup | — |
| `playwright_exec` | 浏览器 E2E | QA 节点 | — |
| `health_check` | HTTP 服务健康轮询 | deploy 节点 | — |
| `lsp_diagnose` | 文件级类型/语法诊断 | coder 节点 | Coder |
| `lint_fix` | 自动格式化 | coder 节点 | Coder |

> `docker_exec`、`playwright_exec`、`health_check` 由 graph.ts 直接调用，不通过 agent tool 注入，以保持 agent 上下文干净（Skills 按需注入原则）。

---

## 7. 输入校验策略

所有 LLM 输出经两层校验：
1. **`parseJsonFromResponse`**：尝试直接解析 → 提取数组 `[...]` → 提取对象 `{...}`，失败时打印警告并回退默认值。
2. **Zod `safeParse`**：对解析结果进行结构校验，失败时打印警告但不阻断流程（降级继续）。

---

## 8. Sisyphus 协议（阶段 3.5 已实现）

参考 oh-my-opencode 的三条核心原则，详见 `docs/sisyphus-design.md`：

| 原则 | 实现 | 位置 |
|------|------|------|
| **执着完成** | Todo-Enforcer：文件写入后扫描未完成标记，强制重写 | `coder` 内循环 |
| **独立验证** | Pre-QA Verifier：四项静态检查，不信任 Coder 声称 | `verifier` 节点 |
| **按需上下文** | Skills 按职责裁剪，QA 只有 Shell 工具 | `src/agents/team.ts` |

---

## 9. 持续进化

- 每个 Agent 启动时，`ModelManager` 将 `KNOWLEDGE.md` 末尾 2000 字符注入系统提示。
- `post_mortem` 节点（PM 执行）在任务结束后追加本次经验。
- 这使系统随任务积累自动优化决策，无需人工维护提示词。
