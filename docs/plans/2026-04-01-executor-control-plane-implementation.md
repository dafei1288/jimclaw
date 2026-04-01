# Executor Control Plane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 JimClaw 引入执行控制面，把命令执行从节点内零散 `spawn`/Docker 调用升级为统一的执行抽象、能力探测、授权票据和 backend 协商机制。

**Architecture:** 第一阶段先在仓库内建立 `CommandExecutor` facade、能力快照、结构化结果与票据状态，不直接引入外部服务。第二阶段把 `env_guard`、`infra_setup`、`terminal`、`deploy` 迁移到该 facade，并把“需要授权但不能阻塞等待”的语义接入现有图状态机。整个过程保持对现有 `executionBackend/containerId/hostRuntimePid` 的兼容，但新逻辑只以 `ExecutorState` 为控制面事实源。

**Tech Stack:** TypeScript, Node.js, LangGraph.js, existing JimClaw node graph, node:test/Jest-style repo tests

**Status (2026-04-01):** Task 1-10 已完成。其中 `env_guard`、`infra_setup`、`terminal`、`deploy` 已全部迁移到执行控制面；`deploy` 现通过 `start_runtime` intent 统一处理启动、一次瞬时重试、授权挂起和环境/运行时故障分类。最新验证：`npx tsc --noEmit`、`node -e "require('./tests/core/deploy-node.test.js')"`、`npm run test:core` 全部通过。

---

### Task 1: 建立执行控制面类型

**Files:**
- Create: `src/executor/types.ts`
- Modify: `src/core/graph_types.ts`
- Test: `tests/core/executor-types.test.js`

**Step 1: Write the failing test**

在 `tests/core/executor-types.test.js` 新增断言，验证以下类型对应的最小对象可以被 graph state 接收：

- `ExecutionIntent`
- `CapabilitySnapshot`
- `BackendResolution`
- `ApprovalTicket`
- `ExecutorResult`
- `RuntimeHandle`
- `ExecutorState`

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/executor-types.test.js')"`
Expected: 因找不到 `src/executor/types.ts` 或 state 缺少字段而失败

**Step 3: Write minimal implementation**

在 `src/executor/types.ts` 定义并导出最小版本类型：

```ts
export type ExecutorBackend = "local_shell" | "docker" | "remote_runner" | "external_executor";
export type ApprovalTicketStatus = "pending" | "approved" | "rejected" | "auto_approved";
```

并在 `src/core/graph_types.ts` 中接入：

- `executorState?: ExecutorState`

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/executor-types.test.js')"`
Expected: 类型测试通过

**Step 5: Commit**

```bash
git add src/executor/types.ts src/core/graph_types.ts tests/core/executor-types.test.js
git commit -m "feat: add executor control plane types"
```

### Task 2: 建立能力探测器

**Files:**
- Create: `src/executor/capability_probe.ts`
- Test: `tests/core/capability-probe.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- Docker daemon 不可达时返回 `docker.daemonReachable=false`
- 本地 shell `spawn EPERM` 时返回 `localShell.available=false`
- 能力探测结果是结构化对象，不是纯文本

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/capability-probe.test.js')"`
Expected: 因探测器不存在而失败

**Step 3: Write minimal implementation**

在 `src/executor/capability_probe.ts` 添加：

- `probeLocalShellCapability()`
- `probeDockerCapability()`
- `probeExecutionCapabilities()`

返回最小结构：

```ts
{
  version: "v1",
  localShell: { available: boolean, reason?: string },
  docker: { cliAvailable: boolean, daemonReachable: boolean, reason?: string },
  network: { outboundAllowed: boolean, reason?: string },
  backgroundProcess: { available: boolean, reason?: string }
}
```

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/capability-probe.test.js')"`
Expected: 探测器测试通过

**Step 5: Commit**

```bash
git add src/executor/capability_probe.ts tests/core/capability-probe.test.js
git commit -m "feat: add executor capability probe"
```

### Task 3: 建立 backend 决策器

**Files:**
- Create: `src/executor/backend_resolver.ts`
- Test: `tests/core/backend-resolver.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- `install_deps` 在 Docker 可用时优先选 `docker`
- Docker 不可用且 local shell 可用时选 `local_shell`
- Docker 与 local 都不可用时返回 `blocked=true`
- 需要联网安装时可标记 `requiresApproval=true`

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/backend-resolver.test.js')"`
Expected: 因 resolver 不存在而失败

**Step 3: Write minimal implementation**

在 `src/executor/backend_resolver.ts` 添加：

- `resolveExecutorBackend(intent, capabilitySnapshot, policy)`

输出：

```ts
{
  selected,
  candidates,
  blocked,
  blockedReason,
  requiresApproval,
  approvalScope
}
```

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/backend-resolver.test.js')"`
Expected: backend 选择测试通过

**Step 5: Commit**

```bash
git add src/executor/backend_resolver.ts tests/core/backend-resolver.test.js
git commit -m "feat: add executor backend resolver"
```

### Task 4: 建立授权票据管理器

**Files:**
- Create: `src/executor/approval_tickets.ts`
- Test: `tests/core/approval-tickets.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- 可创建 `pending` 票据
- 可转为 `approved`
- 可转为 `rejected`
- 默认授权场景记录为 `auto_approved`
- 重复审批不会覆盖已终态票据

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/approval-tickets.test.js')"`
Expected: 因票据模块不存在而失败

**Step 3: Write minimal implementation**

在 `src/executor/approval_tickets.ts` 添加：

- `createApprovalTicket(...)`
- `approveTicket(...)`
- `rejectTicket(...)`
- `autoApproveTicket(...)`
- `findOpenApprovalTicket(...)`

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/approval-tickets.test.js')"`
Expected: 票据测试通过

**Step 5: Commit**

```bash
git add src/executor/approval_tickets.ts tests/core/approval-tickets.test.js
git commit -m "feat: add executor approval ticket manager"
```

### Task 5: 建立执行结果分类器

**Files:**
- Create: `src/executor/result_classifier.ts`
- Test: `tests/core/executor-result-classifier.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- `spawn EPERM` -> `process_spawn_denied`
- Docker daemon 不可达 -> `docker_daemon_unreachable`
- `command not found` -> `command_not_found`
- 超时 -> `timeout`
- 端口占用 -> `port_conflict`

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/executor-result-classifier.test.js')"`
Expected: 因分类器不存在而失败

**Step 3: Write minimal implementation**

在 `src/executor/result_classifier.ts` 添加：

- `classifyExecutorFailure({ stdout, stderr, exitCode, raw })`
- `mapExecutorFailureToValidationFailure(...)`

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/executor-result-classifier.test.js')"`
Expected: 分类测试通过

**Step 5: Commit**

```bash
git add src/executor/result_classifier.ts tests/core/executor-result-classifier.test.js
git commit -m "feat: classify executor failures"
```

### Task 6: 建立 `CommandExecutor` facade

**Files:**
- Create: `src/executor/command_executor.ts`
- Modify: `src/skills/shell_exec.ts`
- Test: `tests/core/command-executor.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- facade 先探测能力，再做 backend 解析
- 若 `requiresApproval=true`，返回 `blocked + approvalTicketId`
- 若 backend 被阻断，不会尝试直接执行命令
- 兼容现有 `ShellExecuteSkill` 作为一个 backend adapter

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/command-executor.test.js')"`
Expected: 因 facade 不存在而失败

**Step 3: Write minimal implementation**

在 `src/executor/command_executor.ts` 添加：

- `createCommandExecutor(deps)`
- `probeCapabilities()`
- `resolveIntent(intent, policy)`
- `executeIntent(intent, state, policy)`

同时把 `src/skills/shell_exec.ts` 明确降为：

- `LocalShellAdapter`
- 只负责本地执行，不再承担路由与决策职责

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/command-executor.test.js')"`
Expected: facade 测试通过

**Step 5: Commit**

```bash
git add src/executor/command_executor.ts src/skills/shell_exec.ts tests/core/command-executor.test.js
git commit -m "feat: add command executor facade"
```

### Task 7: 迁移 `env_guard` 到执行控制面

**Files:**
- Modify: `src/core/nodes/env_guard_node.ts`
- Test: `tests/core/env-guard-node.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- `env_guard` 不再自己拼接 Docker/local 判断逻辑
- Docker 不可用且 local shell 不可用时，直接产出 `宿主环境阻塞`
- 需要授权时创建票据并进入 pending，而不是继续进 `infra_setup`

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/env-guard-node.test.js')"`
Expected: 因旧逻辑与新断言不一致而失败

**Step 3: Write minimal implementation**

把 `env_guard_node.ts` 改为：

- 调 `CommandExecutor.probeCapabilities()`
- 调 `resolveIntent({ kind: 'install_deps' ... })`
- 只负责把结构化结果映射回 `validationReport/repairPlan/blockedReason`

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/env-guard-node.test.js')"`
Expected: `env_guard` 测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/env_guard_node.ts tests/core/env-guard-node.test.js
git commit -m "refactor: route env guard through command executor"
```

### Task 8: 迁移 `infra_setup` 到执行控制面

**Files:**
- Modify: `src/core/nodes/infra_node.ts`
- Test: `tests/core/infra-node.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- host 安装依赖不再直接调 `ShellExecuteSkill`
- Docker backend 与 local backend 都通过 facade 进入
- `approval_required` 时不会继续执行安装
- `executor_unavailable` 映射为 `environment_gap`

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/infra-node.test.js')"`
Expected: 因旧逻辑直接调 shell 而失败

**Step 3: Write minimal implementation**

把 `infra_node.ts` 中：

- host install
- host build
- docker install
- docker build

统一改成 intent：

- `install_deps`
- `build_workspace`
- `prepare_runtime`

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/infra-node.test.js')"`
Expected: `infra_setup` 测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/infra_node.ts tests/core/infra-node.test.js
git commit -m "refactor: route infra setup through command executor"
```

### Task 9: 迁移 `terminal` 到执行控制面

**Files:**
- Modify: `src/core/nodes/terminal_node.ts`
- Test: `tests/core/terminal-node.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- `terminal` 不直接拼 shell 字符串
- 测试执行走 `run_tests` intent
- 执行失败可区分 `environment_gap` 与测试本身失败

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/terminal-node.test.js')"`
Expected: 因旧逻辑不走 facade 而失败

**Step 3: Write minimal implementation**

把 `terminal_node.ts` 改成只生成：

```ts
{ kind: "run_tests", workspace, command: testCmd }
```

再由 facade 返回结构化 `ExecutorResult`。

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/terminal-node.test.js')"`
Expected: `terminal` 测试通过

**Step 5: Commit**

```bash
git add src/core/nodes/terminal_node.ts tests/core/terminal-node.test.js
git commit -m "refactor: route terminal through command executor"
```

### Task 10: 迁移 `deploy` 到执行控制面

**Files:**
- Modify: `src/core/nodes/deploy_node.ts`
- Test: `tests/core/deploy-node.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- 启动运行时使用 `start_runtime` intent
- 若需要后台进程但无能力，返回 `runtime_start_failed` 或 `executor_unavailable`
- 需要授权时，直接 pending，不进入健康检查
- host 与 docker 的 runtime handle 都走统一返回结构

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/deploy-node.test.js')"`
Expected: 因旧逻辑仍自己管理启动命令而失败

**Step 3: Write minimal implementation**

把 `deploy_node.ts` 改成：

- 组装 `start_runtime` intent
- 读取 `RuntimeHandle`
- 健康检查仍留在 deploy
- 启动失败分类全部依赖 `ExecutorResult`

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/deploy-node.test.js')"`
Expected: `deploy` 测试通过

**Implementation note (2026-04-01):**

- `deploy_node.ts` 已改为通过 `CommandExecutor.executeIntent({ kind: "start_runtime" })` 启动运行时
- 对 `retryable` 或瞬时容器执行错误保留一次节点内重试
- `requiresApproval=true` 时直接写入 pending 恢复状态，不进入 health check
- 启动阶段的 `executor_unavailable/process_spawn_denied/docker_daemon_unreachable` 归类为 `environment_gap`
- 启动成功后的健康检查失败仍归类为 `runtime_gap`

**Step 5: Commit**

```bash
git add src/core/nodes/deploy_node.ts tests/core/deploy-node.test.js
git commit -m "refactor: route deploy through command executor"
```

### Task 11: 把授权票据接入 graph 挂起/恢复

**Files:**
- Modify: `src/core/graph.ts`
- Modify: `src/core/graph_types.ts`
- Modify: `src/server.ts`
- Test: `tests/core/workflow-replay.test.js`
- Test: `tests/core/approval-node.test.js`

**Step 1: Write the failing test**

新增测试覆盖：

- 执行器返回 `requiresApproval=true` 时，graph 进入 `agent_pending` 或 `approval_pending`
- 票据状态写入 state
- 恢复后从原业务节点继续，不从头开始
- 不允许在节点内部同步等待

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/workflow-replay.test.js')"; node -e "require('./tests/core/approval-node.test.js')"`
Expected: 因当前图未接 executor tickets 而失败

**Step 3: Write minimal implementation**

在 `graph.ts` 中加入：

- `pendingApprovalTicketId`
- 基于票据状态的恢复路由

在 `server.ts` 中增加：

- executor approval ticket 展示
- 恢复时的票据提交入口

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/workflow-replay.test.js')"; node -e "require('./tests/core/approval-node.test.js')"`
Expected: 挂起/恢复测试通过

**Step 5: Commit**

```bash
git add src/core/graph.ts src/core/graph_types.ts src/server.ts tests/core/workflow-replay.test.js tests/core/approval-node.test.js
git commit -m "feat: add executor approval pending flow"
```

### Task 12: 用真实失败样本锁定回归

**Files:**
- Modify: `tests/core/workflow-replay.test.js`
- Modify: `tests/core/failure-artifacts.test.js`

**Step 1: Write the failing test**

把两个真实样本固化：

- Docker daemon 不可达 + local spawn EPERM
- deploy host 启动链早期失败

断言：

- 第一类在 `env_guard` 明确失败，不再冒充 `npm install` 失败
- 第二类在 `deploy` 明确失败，不再健康检查空转

**Step 2: Run test to verify it fails**

Run: `node -e "require('./tests/core/workflow-replay.test.js')"; node -e "require('./tests/core/failure-artifacts.test.js')"`
Expected: 回放测试失败

**Step 3: Write minimal implementation**

更新 fixture 和回放逻辑，使其依赖新的 `ExecutorState/ExecutorResult/ApprovalTicket`。

**Step 4: Run test to verify it passes**

Run: `node -e "require('./tests/core/workflow-replay.test.js')"; node -e "require('./tests/core/failure-artifacts.test.js')"`
Expected: 回放测试通过

**Step 5: Commit**

```bash
git add tests/core/workflow-replay.test.js tests/core/failure-artifacts.test.js
git commit -m "test: lock executor control plane replay behavior"
```

### Task 13: 统一编译与核心回归

**Files:**
- None

**Step 1: Run targeted tests**

Run:

```bash
node -e "require('./tests/core/executor-types.test.js')"
node -e "require('./tests/core/capability-probe.test.js')"
node -e "require('./tests/core/backend-resolver.test.js')"
node -e "require('./tests/core/approval-tickets.test.js')"
node -e "require('./tests/core/executor-result-classifier.test.js')"
node -e "require('./tests/core/command-executor.test.js')"
node -e "require('./tests/core/env-guard-node.test.js')"
node -e "require('./tests/core/infra-node.test.js')"
node -e "require('./tests/core/terminal-node.test.js')"
node -e "require('./tests/core/deploy-node.test.js')"
node -e "require('./tests/core/workflow-replay.test.js')"
```

Expected: 全部通过

**Step 2: Run compile check**

Run:

```bash
npx tsc --noEmit
```

Expected: 通过

**Step 3: Commit**

```bash
git add .
git commit -m "test: verify executor control plane core regression suite"
```

### Task 14: 跑一次真实图书管理系统样例

**Files:**
- None

**Step 1: Run end-to-end task**

Run:

```bash
npx ts-node src/index.ts --auto-approve all "图书管理系统"
```

Expected:

- 若 Docker 与 local shell 都不可用，系统在 `env_guard` 明确给出“宿主环境阻塞”
- 不再把问题伪装成 `npm install` 失败
- 不再在 `infra_setup` 或 `deploy` 阶段空转

**Step 2: Inspect generated artifacts**

检查：

- `workspace/run_*/audit/Environment.md`
- `workspace/run_*/audit/Infrastructure.md`
- `workspace/run_*/nodes/`
- `workspace/run_*/boulder.json`

Expected:

- 有结构化 executor 状态
- 有 approval ticket 或 blocked reason
- `lastFailedNode` 与 `lastFailureSummary` 与真实能力缺口一致

**Step 3: Commit**

```bash
git add .
git commit -m "feat: validate executor control plane with real bookshelf run"
```
