# Managed Harness Next TODO Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按步骤把 JimClaw 的 managed harness 从“代码已存在”推进到“真实 smoke 可证明 sprint contract / evaluator / release gate 正在接管协作闭环”。

**Architecture:** 先不继续扩展前端/API 契约，先打开 `managedHarness` 路由做真实运行证据采集。根据 `session/events.jsonl`、`boulder.json` 和 audit 结果，逐步补强 sprint contract 约束、evaluator evidence、release gate 放行规则和修复回路。

**Tech Stack:** TypeScript, LangGraph.js, Node test runner, Docker runtime, JimClaw workspace audit/session event system.

---

## 当前基线

- 当前分支：`feat/managed-agent-harness`
- 当前关键提交：`4e41885 fix: keep read-only API contracts stable`
- 最近 legacy smoke 已通过：`workspace/run_1778783524079`
- 已验证 legacy smoke：
  - `apiContract` 与 `executionProtocol.contracts.api` 都只包含 GET 端点。
  - `frontend.apiUsage` 的 create/update/delete 都为 `false`。
  - `public/index.html` 没有新增/编辑/删除控件。
  - Express 入口使用 `process.env.PORT`、`process.env.HOST || "0.0.0.0"`、`app.listen(PORT, HOST, ...)`。
  - 容器内 `npm test` 通过，公开端点 `/api/health`、`/api/products`、`/products` 都返回 200。

## 非目标

- 本轮不重写 scaffold。
- 本轮不删除 legacy `orchestrator -> coder -> qa` 路径。
- 本轮不引入 Playwright，除非 release gate 证据已经无法用 HTTP/file check 表达。
- 本轮不处理 CLI 末尾偶发 `The system cannot find the path specified.` 噪声，除非它进入 audit/boulder 或影响退出码。

---

## Task 1: 打开 managed harness 做真实 smoke

**Files:**
- Inspect: `jimclaw.config.json`
- Inspect: `jimclaw.config.json.example`
- Inspect: `workspace/run_*/session/events.jsonl`
- Inspect: `workspace/run_*/boulder.json`
- Inspect: `workspace/run_*/audit/Infrastructure.md`
- Inspect: `workspace/run_*/audit/Terminal.md`

**Step 1: 确认配置读取路径**

Run:

```powershell
rg -n "getManagedHarnessConfig|managedHarness|evaluatorRequired|releaseGateRequired" src jimclaw.config.json.example
```

Expected:

- `src/utils/models.ts` 支持 `managedHarness`。
- `src/core/graph.ts` 根据 `managedHarness.enabled` 切换到 `sprint_planner -> sprint_contract -> coder`、`verifier -> evaluator -> qa`、`deploy -> release_gate`。

**Step 2: 临时打开本地 config**

在本地 `jimclaw.config.json` 顶层增加：

```json
{
  "managedHarness": {
    "enabled": true,
    "evaluatorRequired": true,
    "releaseGateRequired": true
  }
}
```

注意：如果 `jimclaw.config.json` 含本地密钥或环境专用内容，不提交该文件；只提交 `.example` 或代码改动。

**Step 3: 跑 focused suite**

Run:

```powershell
node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: 全部通过。

**Step 4: 跑 managed smoke**

Run:

```powershell
Get-Content ..\..\.env | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { $name=$matches[1].Trim(); $value=$matches[2].Trim().Trim('"').Trim("'"); [Environment]::SetEnvironmentVariable($name, $value, 'Process') } }; npx ts-node src/index.ts --auto-approve all "创建一个 TypeScript Express 商品目录应用，提供商品列表页面 /products 和 JSON API /api/products，包含自动化测试"
```

Expected:

- run 进入 `persistence` 或 `release_gate pass`。
- `workspace/run_xxx/session/events.jsonl` 存在。
- events 至少包含 `sprint_plan`、`sprint_contract`、`evaluation_result`、`release_decision`。
- `boulder.json.state.evaluationResults` 或等价字段存在 passing evidence。
- `apiContract` 和 `executionProtocol.contracts.api` 仍只包含 GET 端点。

**Step 5: 记录结果**

把 smoke 结果写到本 TODO 的“执行记录”小节，至少记录：

- run id
- URL
- container id
- 是否出现 sprint events
- release gate 是否参与
- blocking failure 摘要

**Commit:**

如果只改了文档：

```powershell
git add docs/plans/2026-05-15-managed-harness-next-todo.md
git commit -m "docs: add managed harness next todo"
```

如果修了配置 example 或代码，commit message 按实际行为写。

---

## Task 2: 若 managed route 没实际参与，先修路由/配置

**Files:**
- Modify: `jimclaw.config.json.example`
- Modify: `src/utils/models.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/workflow-replay.test.js`

**Step 1: 写失败测试**

在 `tests/core/workflow-replay.test.js` 增加或扩展断言：

```js
test("managed harness routes through sprint and release gates when enabled", () => {
  assert.equal(getOrchestratorNextNodeForReplay({ managedHarnessEnabled: true }), "sprint_planner");
  assert.equal(getVerifierNextNode({ testResults: "pass" }, true), "evaluator");
  assert.equal(getDeployNextNode({ deploymentStatus: { status: "running" } }, true), "release_gate");
});
```

实际 helper 名称按现有测试文件为准；不要为了测试发明生产 API。

**Step 2: 跑测试确认失败**

Run:

```powershell
node --test --test-name-pattern "managed harness routes" tests/core/workflow-replay.test.js
```

Expected: FAIL，指出路由或 config 未按 enabled 生效。

**Step 3: 最小修复**

目标行为：

- `managedHarness.enabled=false` 时保持 legacy 路由。
- `managedHarness.enabled=true` 时：
  - `orchestrator -> sprint_planner -> sprint_contract -> env_guard -> coder`
  - `verifier -> evaluator -> qa`
  - `deploy -> release_gate -> post_mortem`

**Step 4: 验证**

Run:

```powershell
node --test tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: PASS。

**Commit:**

```powershell
git add jimclaw.config.json.example src/utils/models.ts src/core/graph.ts tests/core/workflow-replay.test.js
git commit -m "fix: route managed harness when enabled"
```

---

## Task 3: 确认 sprint contract 真正约束 Coder

**Files:**
- Modify: `src/core/nodes/coder_node.ts`
- Test: `tests/core/coder-node.test.js`
- Inspect: `workspace/run_xxx/session/events.jsonl`

**Step 1: 写失败测试**

新增测试场景：

- `activeSprintId=SP-1`
- `SprintContract.agreedScope.allowedFiles=["src/index.ts","tests/products.test.ts"]`
- `subTasks` 中包含当前 sprint 外文件：`src/admin.ts`
- 预期：Coder 不应写 `src/admin.ts`，应把它保留 pending 或输出 scope block evidence。

测试断言：

```js
assert.equal(writtenFiles.includes("src/admin.ts"), false);
assert.match(result.blockedReason || result.teamChatLog?.join("\n") || "", /scope|SprintContract|allowedFiles/i);
```

**Step 2: 跑测试确认失败**

Run:

```powershell
node --test --test-name-pattern "sprint contract.*scope" tests/core/coder-node.test.js
```

Expected: FAIL，如果 Coder 仍写越界文件或没有 evidence。

**Step 3: 最小修复**

在 Coder 写文件前，统一调用现有/新增 helper：

```ts
function isFileAllowedBySprintContract(fileTarget: string, contract: SprintContract | null | undefined): boolean
```

规则：

- 没有 active contract：不拦截 legacy 路径。
- 有 active contract：只有 `agreedScope.allowedFiles` 或明确依赖文件可写。
- `fixPlan` / `repairContract` 明确授权的修复文件可写。
- 越界时写 structured event 或 `ValidationReport`，不得静默跳过。

**Step 4: 验证**

Run:

```powershell
node --test --test-name-pattern "sprint contract.*scope" tests/core/coder-node.test.js
node --test tests/core/coder-node.test.js
npx tsc --noEmit
```

Expected: PASS。

**Commit:**

```powershell
git add src/core/nodes/coder_node.ts tests/core/coder-node.test.js
git commit -m "fix: enforce sprint contract file scope"
```

---

## Task 4: 补 evaluator file check 和 build artifact evidence

**Files:**
- Modify: `src/core/graph_types.ts`
- Modify: `src/core/nodes/evaluator_node.ts`
- Test: `tests/core/evaluator-node.test.js`

**Step 1: 写失败测试**

新增 `EvaluationCheck.kind="file"`：

```js
{
  checkId: "CHK-build-output",
  kind: "file",
  path: "dist/src/index.js",
  exists: true,
  description: "确认 TypeScript build 产物存在"
}
```

预期：

- 文件存在时 check pass，evidence 包含 absolute/relative path 和 file size。
- 文件不存在时 check fail，suspectedFiles 指向 `package.json`、`tsconfig.json` 或 entry file。

**Step 2: 跑测试确认失败**

Run:

```powershell
node --test --test-name-pattern "file check" tests/core/evaluator-node.test.js
```

Expected: FAIL，因为 evaluator 尚未支持 file check 或 evidence 不足。

**Step 3: 最小实现**

在 `evaluator_node.ts` 增加：

```ts
async function runFileCheck(state: JimClawState, check: EvaluationCheck, contract: SprintContract): Promise<CheckResult>
```

规则：

- path 必须在 workspace 内。
- exists=true 时 `fs.stat` 成功才 pass。
- exists=false 时文件不存在才 pass。
- evidence 至少包含 `{ path, exists, sizeBytes? }`。

**Step 4: 验证**

Run:

```powershell
node --test tests/core/evaluator-node.test.js
npx tsc --noEmit
```

Expected: PASS。

**Commit:**

```powershell
git add src/core/graph_types.ts src/core/nodes/evaluator_node.ts tests/core/evaluator-node.test.js
git commit -m "feat: add evaluator file checks"
```

---

## Task 5: 强化 release gate，防止“只 health pass”

**Files:**
- Modify: `src/core/nodes/release_gate_node.ts`
- Test: `tests/core/release-gate-node.test.js`

**Step 1: 写失败测试**

增加两个 fixture：

1. API health pass，但 `/api/products` 没有被 evaluator 访问。
2. 前端需求存在，但没有 HTML evidence。

预期：release gate fail，`validationReport.findings` 说明缺少业务端点证据或 HTML 证据。

**Step 2: 跑测试确认失败**

Run:

```powershell
node --test --test-name-pattern "release gate.*business endpoint|release gate.*html" tests/core/release-gate-node.test.js
```

Expected: FAIL。

**Step 3: 最小实现**

Release gate 必须检查：

- `apiContract.endpoints` 中所有公开 GET 端点都有 passing http evidence。
- 如果 `requirementProtocol.capabilities.frontendRequired=true`，至少一个页面端点返回 HTML evidence。
- `audit/Infrastructure.md` 和 `audit/Terminal.md` 不含未解释 `Critical Error`、`exit code`、`not found`。

**Step 4: 验证**

Run:

```powershell
node --test tests/core/release-gate-node.test.js
npx tsc --noEmit
```

Expected: PASS。

**Commit:**

```powershell
git add src/core/nodes/release_gate_node.ts tests/core/release-gate-node.test.js
git commit -m "fix: require endpoint evidence at release gate"
```

---

## Task 6: 修复失败回路，避免 evaluator fail 后盲修

**Files:**
- Modify: `src/core/nodes/fix_plan_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/fix-plan-node.test.js`
- Test: `tests/core/workflow-replay.test.js`

**Step 1: 写失败测试**

场景：

- latest `EvaluationResult.status="fail"`
- failed check 指向 `/api/products` 500
- 预期 `fix_plan_node` 输出 `repairContracts[]`
- repair scope 只包含 suspected files 和 active sprint allowed files 的交集。

**Step 2: 跑测试确认失败**

Run:

```powershell
node --test --test-name-pattern "repair contract" tests/core/fix-plan-node.test.js tests/core/workflow-replay.test.js
```

Expected: FAIL，如果修复仍只依赖 QA issue title 或不绑定 failed check。

**Step 3: 最小实现**

规则：

- evaluator fail 后进入 QA 分类，但修复计划必须读取 latest failed checks。
- `repairContract` 必须包含：
  - failed check id
  - repro steps
  - suspected files
  - allowed repair files
  - evaluator rerun command/check list
- 修复完成后回到 evaluator，不直接 release/deploy。

**Step 4: 验证**

Run:

```powershell
node --test tests/core/fix-plan-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: PASS。

**Commit:**

```powershell
git add src/core/nodes/fix_plan_node.ts src/core/graph.ts tests/core/fix-plan-node.test.js tests/core/workflow-replay.test.js
git commit -m "fix: bind repairs to evaluation failures"
```

---

## Task 7: 复杂 managed smoke 验收

**Files:**
- Inspect: `workspace/run_xxx/session/events.jsonl`
- Inspect: `workspace/run_xxx/audit/Infrastructure.md`
- Inspect: `workspace/run_xxx/audit/Terminal.md`
- Inspect: `workspace/run_xxx/boulder.json`
- Optional Modify: source files only if smoke exposes a real bug.

**Step 1: 跑复杂任务**

Run:

```powershell
Get-Content ..\..\.env | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { $name=$matches[1].Trim(); $value=$matches[2].Trim().Trim('"').Trim("'"); [Environment]::SetEnvironmentVariable($name, $value, 'Process') } }; npx ts-node src/index.ts --auto-approve all "创建一个 TypeScript Express 库存看板，包含商品列表页面 /products、库存状态 API /api/products、低库存筛选能力和自动化测试"
```

Expected:

- 至少 1 个 sprint plan。
- 每个 sprint 有 contract。
- evaluator 有 HTTP/file evidence。
- release gate pass 前业务端点已被实际访问。
- 页面端点返回 HTML，不只是 JSON。

**Step 2: 手工核验证据**

Run:

```powershell
$latest = Get-ChildItem workspace -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content "$($latest.FullName)\audit\Infrastructure.md"
Get-Content "$($latest.FullName)\audit\Terminal.md"
Get-Content "$($latest.FullName)\session\events.jsonl"
```

Expected:

- `Infrastructure.md` 无未解释 build/deploy 错误。
- `Terminal.md` 测试通过或失败已被 evaluator/QA 解释。
- `events.jsonl` 包含 sprint/evaluation/release evidence。

**Step 3: 公开端点 curl**

按 `boulder.json.state.apiContract.endpoints` 对所有 GET 执行 HTTP 验证。

Expected:

- 所有 GET 返回 200。
- 页面端点返回 `text/html`。
- API 端点返回 JSON。

**Step 4: 最终验证**

Run:

```powershell
node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js tests/core/workflow-replay.test.js
node --test tests/core/execution-protocol.test.js tests/core/contract-sync-node.test.js
npx tsc --noEmit
```

Expected: PASS。

**Commit:**

如果仅 smoke 产出 `KNOWLEDGE.md` / `FAILURE_PATTERNS.md`：

```powershell
git add KNOWLEDGE.md FAILURE_PATTERNS.md
git commit -m "docs: record managed harness smoke findings"
```

如果有代码修复，按实际行为拆 commit。

---

## 执行记录

执行时追加记录，不要覆盖历史。

### 2026-05-15

- 基线 commit：`4e41885 fix: keep read-only API contracts stable`
- 下一步：Task 1，打开 managed harness 并跑真实 smoke。
- Task 1 执行：
  - focused suite 初跑失败，根因是 legacy verifier 路由被过度简化、`agent_pending` 图内自旋清空恢复状态、部署测试仍 mock 旧 `ShellExecuteSkill` 边界；已修复并验证。
  - 验证通过：`node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js tests/core/workflow-replay.test.js`
  - 验证通过：`npx tsc --noEmit`
  - managed smoke run：`run_1778807069282`
  - container id：`89ce7b9903aa102bbb157c1586ebeeadaa86e437b97a4b7d31c0bf251b6d8c16`
  - URL：`http://100.74.126.56:4001`
  - sprint events：已出现 `sprint_planned`、`sprint_contract_agreed`、`evaluation_completed`。
  - release gate：已参与；第 1 轮 `release_gate_completed` 阻塞，原因是“前端验收缺少 UI 证据”。
  - blocking failure：smoke 超过 40 分钟未收敛，最后快照为 `coder_task_task-07` / `retryCount=5`；过程中出现 Product 契约漂移，`src/app.ts` 访问未授权的 `stock/status` 字段，触发 `TS2339`，后续仲裁冻结字段为 `id/name/price`。
  - 手工核验：run 目录内最终代码 `npm run build` 与 `npm test` 在容器中通过，但图执行未进入最终 deploy/release/persistence；下一步优先修 release/evaluator evidence 与修复回路。
- Task 3 执行：
  - 新增回归：`coder keeps files outside active sprint contract pending`，验证 active SprintContract 只允许 `src/allowed.ts` 时，`src/admin.ts` 不会被尝试写入且保持 pending。
  - 结果：新增测试首跑通过，说明 sprint scope 基础拦截已存在；无须改生产 scope 逻辑。
  - 完整 `coder-node` 回归初跑暴露 5 个既有问题：小项目跳过 import/export 与协议角色校验、authRequired 未保留 auth route、执行 brief 冒号格式漂移。
  - 已修复：所有规模都执行导出契约与协议角色校验；authRequired 至少保留 `src/routes/auth.ts` / `tests/auth.test.ts`；执行 brief 恢复 `执行阶段：` / `directDependencies：` 格式。
  - 验证通过：`node --test tests/core/coder-node.test.js`
  - 验证通过：`npx tsc --noEmit`
- Task 4 执行：
  - 新增 `EvaluationCheck.kind="file"` 支持，字段为 `path` / `targetFile` 与 `exists`。
  - passing evidence 现在包含 `path`、`fileExists`、`sizeBytes`，可证明 `dist/src/index.js` 等 build artifact 真实存在。
  - missing artifact 会失败，并把 repair 方向指向 `package.json`、`tsconfig.json`、入口文件等 build 输入，而不是把缺失的 `dist/` 产物交给 Coder 手写。
  - 验证通过：`node --test tests/core/evaluator-node.test.js`
  - 验证通过：`npx tsc --noEmit`
- Task 5 执行：
  - 新增回归：只有 `/api/health` 有 passing evidence、业务 GET `/api/books` 未被 evaluator 访问时，release gate 必须 fail。
  - 新增回归：`GET /products` 返回 HTML 的 HTTP evidence 可满足前端 UI 验收，不再强制必须 screenshot/trace。
  - 已修复：release gate 会逐一检查 `apiContract.endpoints` 中所有公开 GET 是否有 passing HTTP evidence；`<!doctype>/<html>/<body>/text/html` 页面响应可作为 UI evidence。
  - 验证通过：`node --test tests/core/release-gate-node.test.js`
  - 验证通过：`npx tsc --noEmit`
- Task 6 执行：
  - 新增回归：failed evaluator check 同时怀疑 sprint 内文件与 sprint 外文件时，`repairContract.repairScope` 只能保留 active `SprintContract.agreedScope.allowedFiles` 内的文件。
  - 已修复：`RepairContract` 记录 `failedChecks`、`reproSteps`、`suspectedFiles`、`allowedRepairFiles`、`rerunChecks`，并把状态标记为 `open`。
  - 已修复：`buildSystemContext()` 注入 `[修复契约]` 摘要，后续 Agent 能看到 failed check、复现步骤和允许修复文件，不再只依赖普通 issue title。
  - 验证通过：`node --test tests/core/fix-plan-node.test.js tests/core/workflow-replay.test.js tests/core/execution-protocol.test.js`
  - 验证通过：`npx tsc --noEmit`
- Task 7 首轮 smoke：
  - run：`run_1778811083795`
  - route evidence：已出现 `sprint_planned`、`sprint_contract_agreed`，SP-1 可写范围被限定到 package/tsconfig/src/tests 文件。
  - blocking failure：`src/app.ts` 被 `ExecutionProtocol` 标成 `other`，导致合法挂载 `src/routes/products.ts(route)` 被依赖角色校验拦截。
  - 已修复：`buildExecutionProtocol` 将 Express/Node `src/app.ts`、`src/server.ts` 归类为 `entry`，允许其依赖 route/controller/service/middleware。
  - blocking failure 2：修复后 `src/index.ts(entry)` 又被禁止依赖 `src/app.ts(entry)`，导致常见 Express `index.listen(app)` 结构被误拦截。
  - 已修复：`entry` 角色允许依赖另一个 `entry`，覆盖 `src/index.ts -> src/app.ts` / `src/server.ts -> src/app.ts` 入口组合。
  - 验证通过：`node --test tests/core/execution-protocol.test.js tests/core/coder-node.test.js`
  - 验证通过：`node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js tests/core/workflow-replay.test.js`
  - 验证通过：`npx tsc --noEmit`

---

## 完成标准

- `managedHarness.enabled=true` 的 smoke 明确经过 `sprint_planner`、`sprint_contract`、`evaluator`、`release_gate`。
- Coder 不能静默写出当前 sprint contract 范围外文件。
- Release gate 不允许只靠 `/api/health` 或单元测试通过就放行。
- evaluator evidence 能覆盖业务 GET 端点、HTML 页面和 build 产物。
- 复杂 smoke 的 `session/events.jsonl` 能解释每个 sprint 为什么通过或失败。
