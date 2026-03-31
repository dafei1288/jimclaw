# Control Plane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 JimClaw 从“观测协议”升级成“控制协议”，让需求、技术栈、方案、任务图、验证、修复和客户确认成为真正的执行控制平面。

**Architecture:** 先在 state 中正式引入 `TechnologyDecision`、`ValidationReport`、`RepairPlan`、`CustomerApprovalState`，再把 `architect -> orchestrator -> verifier -> fix_plan -> graph route` 接到这些对象上。第一批不追求一次性替换全部旧字段，而是优先建立“规划错误强制重规划、实现错误才进 fix_plan、客户可默认授权确认、未授权则挂起待确认而不是同步阻塞”的硬闸门。第二批补上“简单 CRUD 预算、文件别名归一化、测试框架冲突清理”，避免 Architect/Orchestrator 在首轮就把任务图膨胀到无法执行。

**Tech Stack:** TypeScript, LangGraph.js, Node.js, Jest(node test), JimClaw existing graph/node architecture

---

### Task 1: 补齐控制平面类型

**Files:**
- Modify: `src/core/graph_types.ts`
- Test: `tests/core/execution-protocol.test.js`

**Step 1: Write the failing test**

在 `tests/core/execution-protocol.test.js` 新增断言，验证 state 支持：
- `technologyDecision`
- `validationReport`
- `repairPlan`
- `customerApprovalState`

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 相关测试因缺少字段或构建函数而失败

**Step 3: Write minimal implementation**

在 `src/core/graph_types.ts` 新增并导出：
- `TechnologyDecision`
- `ValidationReport`
- `RepairPlan`
- `CustomerApprovalState`

并把它们接入 `JimClawState`。

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 新增类型测试通过

**Step 5: Commit**

```bash
git add src/core/graph_types.ts tests/core/execution-protocol.test.js
git commit -m "feat: add control plane state types"
```

### Task 2: 生成技术决策对象

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/nodes/architect_node.ts`
- Test: `tests/core/execution-protocol.test.js`

**Step 1: Write the failing test**

新增测试验证：
- 用户未指定时，技术栈从允许模板中选择
- 用户指定时，`TechnologyDecision.source = "user"`
- 前后端需求下，`frontend.required` 与 `backend.required` 同时为 true

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: `TechnologyDecision` 相关断言失败

**Step 3: Write minimal implementation**

在 `src/core/logic_utils.ts` 添加：
- `buildTechnologyDecision(requirementContract, spec?)`
- 技术栈许可表（当前至少支持 `express-typescript`、`fastapi-python`、`gin-go`）

在 `architect_node.ts`：
- 产出 `technologyDecision`
- 把用户明确指定的技术栈写入 `source = "user"`

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 技术决策测试通过

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts src/core/nodes/architect_node.ts tests/core/execution-protocol.test.js
git commit -m "feat: generate technology decision"
```

### Task 3: 让架构阶段产出覆盖矩阵硬闸门

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/nodes/architect_node.ts`
- Test: `tests/core/verifier-node.test.js`

**Step 1: Write the failing test**

新增测试：
- 若 `RequirementContract` 中 backendRequired=true，但 `SolutionPlan.modules.routes` 为空，则 Architect 失败
- 若需求未覆盖，输出 `coverageMatrix` 缺口

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 架构覆盖闸门测试失败

**Step 3: Write minimal implementation**

在 `logic_utils.ts` 添加：
- `buildCoverageMatrix(requirementContract, technologyDecision, solutionPlan)`
- `findUncoveredRequirements(...)`

在 `architect_node.ts`：
- 输出 `solutionPlan.coverageMatrix`
- 覆盖为空或缺口时直接失败，不进入 orchestrator

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 架构覆盖测试通过

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts src/core/nodes/architect_node.ts tests/core/verifier-node.test.js
git commit -m "feat: enforce architect coverage matrix"
```

### Task 4: 让 Orchestrator 产出真正的 ExecutionPlan

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/nodes/orchestrator_node.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write the failing test**

新增测试验证：
- `frontendRequired=true` 时必须出现 `ui` 文件和任务
- `backendRequired=true` 时必须出现 `route/controller/service/model`
- `authRequired=true` 时必须出现认证相关任务

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 任务图完整性测试失败

**Step 3: Write minimal implementation**

在 `logic_utils.ts` 添加：
- `buildExecutionPlan(requirementContract, technologyDecision, solutionPlan, spec, apiContract)`
- `validateExecutionPlanCompleteness(...)`

在 `orchestrator_node.ts`：
- 用 `ExecutionPlan` 作为任务图单一事实源
- 不完整时直接失败，不能进入 coder

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 任务图完整性测试通过

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts src/core/nodes/orchestrator_node.ts tests/core/coder-node.test.js
git commit -m "feat: compile execution plan with completeness checks"
```

### Task 5: 引入统一 ValidationReport

**Files:**
- Modify: `src/core/nodes/verifier_node.ts`
- Modify: `src/core/logic_utils.ts`
- Test: `tests/core/verifier-node.test.js`

**Step 1: Write the failing test**

新增测试：
- 缺 route 归类为 `planning_gap`
- 文件语法错误归类为 `implementation_bug`
- 缺 jest/环境问题归类为 `environment_gap`
- 健康检查/入口问题归类为 `runtime_gap`

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 失败分类测试失败

**Step 3: Write minimal implementation**

在 `verifier_node.ts` 统一产出 `validationReport`：
- `status`
- `failureType`
- `blocking`
- `findings[]`

并保留旧字段兼容，但以后路由只认 `validationReport`。

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 分类测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/verifier_node.ts src/core/logic_utils.ts tests/core/verifier-node.test.js
git commit -m "feat: classify failures with validation report"
```

### Task 6: 禁止规划错误进入 Fix Plan

**Files:**
- Modify: `src/core/nodes/fix_plan_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/fix-plan-node.test.js`

**Step 1: Write the failing test**

新增测试：
- 当 `validationReport.failureType === "planning_gap"` 时，`fix_plan` 不生成实现修复计划
- graph 路由直接回 `architect/orchestrator`

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 规划错误分流测试失败

**Step 3: Write minimal implementation**

在 `fix_plan_node.ts`：
- 只接受 `implementation_bug`
- 其它失败类型直接拒收并写结构化说明

在 `graph.ts`：
- 路由基于 `validationReport.failureType`
- `planning_gap` 进入重规划链

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 分流测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/fix_plan_node.ts src/core/graph.ts tests/core/fix-plan-node.test.js
git commit -m "feat: route planning gaps away from fix plan"
```

### Task 7: 让协议补丁强制触发重规划

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/workflow-replay.test.js`

**Step 1: Write the failing test**

新增测试：
- `ExecutionPatch/SolutionPatch` 修改 route 规划后，旧 `subTasks` 被丢弃
- 新的 `ExecutionPlan` 被重建
- 不再围绕旧 5 个任务空转

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 重规划测试失败

**Step 3: Write minimal implementation**

在 `logic_utils.ts` 添加：
- `shouldTriggerReplan(...)`
- `rebuildExecutionArtifacts(...)`

在 `graph.ts`：
- 一旦 patch 触及规划层，强制重建 `SolutionPlan/ExecutionPlan/subTasks`

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 重规划测试通过

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts src/core/graph.ts tests/core/workflow-replay.test.js
git commit -m "feat: trigger replanning after control-plane patches"
```

### Task 8: 修正客户确认语义与默认授权

**Files:**
- Modify: `src/core/graph_types.ts`
- Modify: `src/core/graph.ts`
- Modify: `src/server.ts`
- Modify: `public/index.html`
- Test: `tests/core/dashboard-snapshot.test.js`

**Step 1: Write the failing test**

新增测试：
- 开启 `autoApprove` 时自动通过并记录 `approvedBy=default-authorization`
- 关闭 `autoApprove` 时，approval 节点必须发出确认事件并持久化待确认态，不能直接伪装成 `approvedBy=customer`
- 收到人工批准后，才记录 `approvedBy=customer`
- 没有审批通道且未默认授权时，必须进入待确认/挂起态或显式报错，不能静默绕过

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 客户确认控制测试失败

**Step 3: Write minimal implementation**

引入 `CustomerApprovalState`：
- graph 路由识别关键 checkpoint
- approval 节点区分“默认授权自动通过”和“人工确认后通过”
- approval 节点先落盘 `approval_pending`，再决定是立即恢复还是等待外部恢复，不在节点内无限等待
- server/dashboard 展示当前确认状态
- 默认同意授权可配置
- 不再由 UI 外层伪造 `approvedBy=customer`

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 客户确认测试通过

**Step 5: Commit**

```bash
git add src/core/graph_types.ts src/core/graph.ts src/server.ts public/index.html tests/core/dashboard-snapshot.test.js
git commit -m "feat: add customer approval control layer"
```

### Task 9: 回归真实失败样本

**Files:**
- Modify: `tests/core/workflow-replay.test.js`
- Modify: `tests/core/failure-artifacts.test.js`

**Step 1: Write the failing test**

补真实样本回放：
- “只有 5 个壳文件但用户要完整后端 API” 必须归类为 `planning_gap`
- 不能进入 `fix_plan/coder`
- 必须触发重规划
- “审批 checkpoint 未授权却继续执行” 必须被拦截或显式自动授权

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 历史回归样本失败

**Step 3: Write minimal implementation**

把最新 run 的关键失败模式固化成 fixture，并更新回放测试。

**Step 4: Run test to verify it passes**

Run: `npm run test:core`
Expected: 回归样本通过

**Step 5: Commit**

```bash
git add tests/core/workflow-replay.test.js tests/core/failure-artifacts.test.js
git commit -m "test: lock planning-gap replay behavior"
```

### Task 10: 跑一次真实端到端任务

### Task 10: 抑制任务图膨胀与技术漂移

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/nodes/architect_node.ts`
- Modify: `src/core/nodes/orchestrator_node.ts`
- Test: `tests/core/execution-protocol.test.js`
- Test: `tests/core/orchestrator-node.test.js`

**Step 1: Write the failing test**

新增测试验证：
- `vitest` 主线项目不会再自动注入 `jest.config.cjs / tests/setup.test.ts`
- 简单图书管理系统样例中的别名文件会被折叠
- 简单 CRUD 文件计划会被压到预算内
- Orchestrator 接收到别名任务图时，会回到收缩后的规范任务图，而不是继续放大

**Step 2: Run test to verify it fails**

Run: `node --test tests/core/execution-protocol.test.js tests/core/orchestrator-node.test.js`
Expected: 预算/别名收缩测试失败

**Step 3: Write minimal implementation**

在 `logic_utils.ts` 添加：
- `stabilizeSpecForExecution(...)`
- Node/TS 简单 CRUD 预算器
- 文件路径别名归一化
- `vitest/jest` 冲突清理

在 `architect_node.ts` / `orchestrator_node.ts`：
- 统一使用收缩后的 spec 继续后续流程
- 禁止把原始胖规范直接传给 `ExecutionPlan`

**Step 4: Run test to verify it passes**

Run: `node --test tests/core/execution-protocol.test.js tests/core/orchestrator-node.test.js`
Expected: 预算与归一化测试通过

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts src/core/nodes/architect_node.ts src/core/nodes/orchestrator_node.ts tests/core/execution-protocol.test.js tests/core/orchestrator-node.test.js
git commit -m "fix: compact bloated execution plans before coding"
```

### Task 11: 建立运行时修复回路

**Files:**
- Modify: `src/core/nodes/deploy_node.ts`
- Modify: `src/core/nodes/infra_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/deploy-node.test.js`
- Test: `tests/core/infra-node.test.js`
- Test: `tests/core/workflow-replay.test.js`

**Step 1: Write the failing test**

新增测试验证：
- deploy 失败时输出结构化 `runtime_gap`，而不是只拼接原始文本
- `deploy` 失败后不会直接 `post_mortem`，而是回到 QA/Infra 运行时修复链
- runtime 修复轮次复用已分配宿主机端口，避免端口漂移
- 当证据显示 `EADDRINUSE` 时，infra 会先清理容器内残留运行进程
- 健康检查主路径失败时，会回退探测 `/api/health`、`/health`、`/`

**Step 2: Run test to verify it fails**

Run: `node --test tests/core/infra-node.test.js tests/core/deploy-node.test.js tests/core/workflow-replay.test.js`
Expected: runtime 修复闭环相关测试失败

**Step 3: Write minimal implementation**

在 `deploy_node.ts`：
- 显式注入 `PORT/HOST`
- 产出 `validationReport.failureType = "runtime_gap"`
- 产出 `repairPlan.repairType = "runtime"`
- 健康检查支持 fallback 候选路径

在 `infra_node.ts`：
- runtime 修复重试时复用 `allocatedHostPort`
- 根据运行时证据决定是否清理残留服务进程

在 `graph.ts`：
- deploy 失败且 `runtime_gap` 时，回到 QA/Infra 修复链而不是直接结束

**Step 4: Run test to verify it passes**

Run: `node --test tests/core/infra-node.test.js tests/core/deploy-node.test.js tests/core/workflow-replay.test.js`
Expected: runtime 修复闭环测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/deploy_node.ts src/core/nodes/infra_node.ts src/core/graph.ts tests/core/deploy-node.test.js tests/core/infra-node.test.js tests/core/workflow-replay.test.js
git commit -m "fix: close runtime repair loop for deploy failures"
```

### Task 12: 把审批改成挂起/恢复，而不是同步阻塞

**Files:**
- Modify: `src/core/nodes/approval_node.ts`
- Modify: `src/core/graph.ts`
- Modify: `src/server.ts`
- Test: `tests/core/approval-node.test.js`

**Step 1: Write the failing test**

新增测试验证：
- 需要人工确认时，approval 节点先持久化 `approval_pending`
- 图执行不会因为等待前端点击而长期卡住在同一个 Promise
- 收到确认事件后，系统能从待确认态恢复并继续到 `approvalNextNode`

**Step 2: Run test to verify it fails**

Run: `node --test tests/core/approval-node.test.js`
Expected: 审批挂起/恢复测试失败

**Step 3: Write minimal implementation**

在 `approval_node.ts` / `graph.ts` / `server.ts`：
- 把审批改成显式 pending 状态机
- 区分“发起审批请求”和“恢复审批结果”两个动作
- 默认授权仍即时通过；人工审批改为挂起后恢复，不在节点里同步等待

**Step 4: Run test to verify it passes**

Run: `node --test tests/core/approval-node.test.js`
Expected: 审批挂起/恢复测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/approval_node.ts src/core/graph.ts src/server.ts tests/core/approval-node.test.js
git commit -m "feat: make approval resumable instead of blocking"
```

### Task 13: 跑一次真实端到端任务

**Files:**
- None

**Step 1: Run end-to-end task**

Run:

```bash
npx ts-node src/index.ts "开发一个电器销售系统，包含前端页面和后端 API。要求支持商品列表、添加商品、编辑商品、删除商品，前端可直接操作，后端提供对应接口，包含基础测试与 Docker 部署，并完成完整闭环验证。"
```

Expected:
- 不再出现 “backendRequired=true 但没有 route 文件” 后继续空转
- 若规划不全，应在 architect/orchestrator 阶段被拦住并重建任务图
- 若实现错误，才进入 `fix_plan`

**Step 2: Validate artifacts**

Run:

```bash
npx tsc --noEmit
npm run test:core
```

### 2026-03-29 补充修正：QA 完成态必须检查 pending subTask

**问题：**
- 真实 run `workspace/run_1774772178144` 的 `qa-r3` 虽然仍有 `Dockerfile`、`docker-compose.yml` 等 pending subTask，但因为没有新的失败证据、open issue 也已清空，QA 直接写出 `isDone=true`
- 结果是图从 `qa` 错误进入 `deploy`，replay 也会复现同样误路由

**修改：**
- 在 `src/core/nodes/qa_node.ts` 增加“任务完成闸门”：
  - `hasPendingTasks=true` 时，即使 `failureEvidence=false` 且 `openIssues=0`，也不能 `isDone=true`
  - 这类场景统一产出 `resumeAfterValidation=true`，恢复 `coder` 继续完成剩余文件
- 新增回归测试 `tests/core/qa-node.test.js`
  - 锁定“无失败证据但仍有 pending subTask 时，QA 不得放行 deploy”

**验证：**
- `node --test tests/core/qa-node.test.js`
- 真实 replay：
  - `npx ts-node src/index.ts --replay "D:\\working\\mycode\\jimclaw\\workspace\\run_1774772178144" qa-r3`
  - 修复后路径已从 `qa -> coder`，不再错误直冲 `deploy`

### 2026-03-29 补充修正：模型不可用改为可恢复挂起，环境修复统一收口到 EnvGuard

**问题：**
- `APIConnectionError`、连接拒绝、请求超时、`Request was aborted` 这类模型调用问题，之前只会落 `*_crash` 然后直接打断 run
- 缺依赖、缺类型声明、端口占用这类环境问题，修复逻辑分散在 QA 与 EnvGuard，行为不一致

**修改：**
- 在 `src/core/agent.ts`：
  - 重试链耗尽后，抛出结构化 `AgentServiceUnavailableError`
  - 把 `Connection error`、`ABORT_ERR`、`Request was aborted` 等纳入可恢复服务不可用
- 在 `src/core/graph.ts`：
  - 新增 `agent_pending` 挂起节点
  - 任意节点遇到 `AgentServiceUnavailableError / AgentTimeoutError`，不再 crash，而是落盘为：
    - `agentRecoveryPending=true`
    - `agentRecoveryNode=<原节点>`
    - `resumeFromNode=<原节点>`
- 在 `src/index.ts` / `src/server.ts`：
  - CLI 与 Web 会把该状态显示为待恢复
  - CLI 支持 `--resume <workspacePath>` 从挂起节点继续
- 在 `src/core/nodes/qa_node.ts`：
  - 环境问题不再由 QA 现场散修，而是统一产出 `environment_gap` 转交 `EnvGuard`
- 在 `src/core/nodes/env_guard_node.ts`：
  - 统一收口缺依赖、缺类型声明、端口占用修复
  - 新增类型依赖补齐和跨平台端口释放

**验证：**
- `node --test tests/core/agent-fallback.test.js tests/core/workflow-replay.test.js tests/core/index-cli.test.js tests/core/env-guard-node.test.js tests/core/qa-node.test.js`
- `npx tsc --noEmit`

Expected:
- 通过
- 最新 run 的 `ValidationReport` 与 `ExecutionPlan` 一致

### 2026-03-31 进展总结

以下项已经完成，并有回归或真实 run 证据：

1. 恢复机制修正
   - `--resume` 不再默认回到 `pm`
   - `coder_task_*` 动态节点恢复到 `coder`
   - `qa` 当前快照恢复时保留失败证据，继续交给 `qa_resume_router`

2. 确定性骨架补强
   - `scripts/verify.ts`
   - `tests/health.test.ts`
   - `tests/auth.test.ts`
   - `tests/books.test.ts`
   - `package.json` 依赖兜底

3. 执行链收口
   - `coder` 全部完成后，统一先过 `EnvGuard` 再进 `Infra`
   - `infra_setup` 的 Docker 清理命令已改成更稳的跨环境写法

4. 已确认越过的真实自旋点
   - `scripts/verify.ts` 单文件超时自旋
   - 真实续跑已能从 `coder` 正确接上，不再被恢复逻辑打回 `pm`

### 2026-03-31 仍未闭合的机制缺口

当前还缺一条关键控制机制：

- 当 QA/FixPlan 发现“状态已 completed，但内容其实错误”的文件时，必须把对应文件重新排回执行图

旧 run 当前卡住的本质不是“系统看不见错误”，而是：
- 错误文件已经被 QA 看见
- 但这些文件仍保留为 `completed`
- replay 只能继续分析，不能触发文件重写

这也是当前系统离“初步可用”还差的主要剩余机制。

**Step 3: Commit**

```bash
git add .
git commit -m "feat: implement control plane for planning and execution"
```
