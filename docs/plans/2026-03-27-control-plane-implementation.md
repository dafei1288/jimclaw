# Control Plane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 JimClaw 从“观测协议”升级成“控制协议”，让需求、技术栈、方案、任务图、验证、修复和客户确认成为真正的执行控制平面。

**Architecture:** 先在 state 中正式引入 `TechnologyDecision`、`ValidationReport`、`RepairPlan`、`CustomerApprovalState`，再把 `architect -> orchestrator -> verifier -> fix_plan -> graph route` 接到这些对象上。第一批不追求一次性替换全部旧字段，而是优先建立“规划错误强制重规划、实现错误才进 fix_plan、客户可默认授权确认、未授权才暂停等待”的硬闸门。

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
- 关闭 `autoApprove` 时，approval 节点必须发出等待确认事件，不能直接伪装成 `approvedBy=customer`
- 收到人工批准后，才记录 `approvedBy=customer`
- 没有审批通道且未默认授权时，必须报错或中止，不能静默绕过

**Step 2: Run test to verify it fails**

Run: `npm run test:core`
Expected: 客户确认控制测试失败

**Step 3: Write minimal implementation**

引入 `CustomerApprovalState`：
- graph 路由识别关键 checkpoint
- approval 节点区分“默认授权自动通过”和“人工确认后通过”
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

Expected:
- 通过
- 最新 run 的 `ValidationReport` 与 `ExecutionPlan` 一致

**Step 3: Commit**

```bash
git add .
git commit -m "feat: implement control plane for planning and execution"
```
