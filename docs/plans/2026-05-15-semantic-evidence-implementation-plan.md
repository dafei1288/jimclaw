# Semantic Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 evaluator 和 release gate 能验证低库存筛选、字段存在、HTML 包含/排除文本等语义证据，而不只依赖 HTTP 200。

**Architecture:** 在 `EvaluationCheck` 上增加结构化 `assertions`，由 `evaluator_node` 在 HTTP body 上执行确定性断言并写入 assertion evidence。`release_gate_node` 读取 passing assertion evidence，对包含语义验收的 acceptance criteria 增加放行要求。

**Tech Stack:** TypeScript, Node test runner, LangGraph state types, existing JimClaw evaluator/release gate nodes.

---

### Task 1: 增加 EvaluationAssertion 类型与 schema

**Files:**
- Modify: `src/core/graph_types.ts`
- Test: `tests/core/managed-harness-types.test.js`

**Step 1: 写失败测试**

在 `managed-harness-types.test.js` 增加 schema 解析用例，构造带 `assertions` 的 `EvaluationCheck`，包含：

- `jsonArray`
- `jsonFieldExists`
- `jsonEvery`
- `bodyContains`
- `bodyNotContains`

**Step 2: 运行红灯**

Run:

```powershell
node --test --test-name-pattern "semantic assertions" tests/core/managed-harness-types.test.js
```

Expected: FAIL，提示 `assertions` 字段未被 schema 接受或类型缺失。

**Step 3: 最小实现**

在 `graph_types.ts` 增加：

- `EvaluationAssertion`
- `EvaluationAssertionSchema`
- `assertions?: EvaluationAssertion[]`
- `evidence.assertions?: AssertionEvidence[]`

**Step 4: 验证**

Run:

```powershell
node --test tests/core/managed-harness-types.test.js
npx tsc --noEmit
```

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/core/graph_types.ts tests/core/managed-harness-types.test.js
git commit -m "feat: add evaluation semantic assertion types"
```

---

### Task 2: evaluator 执行 JSON/HTML semantic assertions

**Files:**
- Modify: `src/core/nodes/evaluator_node.ts`
- Test: `tests/core/evaluator-node.test.js`

**Step 1: 写失败测试**

新增测试：

- `jsonEvery` 断言 `stock < 10`，HTTP body 包含 `stock: 45` 时 evaluator fail。
- `jsonFieldExists` 断言 `name`/`stock` 存在，body 满足时 evaluator pass。
- `bodyNotContains` 断言 HTML 不包含 `USB-C Hub`，body 包含时 evaluator fail。

**Step 2: 运行红灯**

Run:

```powershell
node --test --test-name-pattern "semantic assertion" tests/core/evaluator-node.test.js
```

Expected: FAIL，因为 evaluator 还未执行 `check.assertions`。

**Step 3: 最小实现**

新增 helper：

- `runSemanticAssertions(check, body)`
- `parseJsonBody(body)`
- `evaluateJsonEvery(assertion, data)`
- `evaluateFieldExists(assertion, data)`

规则：

- assertion fail 时 check fail。
- evidence.assertions 记录每条 assertion 的 pass/fail 与 message。
- JSON 解析失败时 JSON assertion fail，文本 assertion 不受影响。

**Step 4: 验证**

Run:

```powershell
node --test tests/core/evaluator-node.test.js
npx tsc --noEmit
```

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/core/nodes/evaluator_node.ts tests/core/evaluator-node.test.js
git commit -m "feat: evaluate semantic assertions"
```

---

### Task 3: ReleaseGate 要求语义验收有 semantic evidence

**Files:**
- Modify: `src/core/nodes/release_gate_node.ts`
- Test: `tests/core/release-gate-node.test.js`

**Step 1: 写失败测试**

新增测试：

- ProductSpec 中 AC 描述包含“低库存筛选”，evaluation 只有 HTTP 200，无 assertion evidence，ReleaseGate fail。
- 同样 AC 下有 passing assertion evidence，ReleaseGate pass。

**Step 2: 运行红灯**

Run:

```powershell
node --test --test-name-pattern "semantic evidence" tests/core/release-gate-node.test.js
```

Expected: FAIL，因为 release gate 还不区分 semantic evidence。

**Step 3: 最小实现**

新增 helper：

- `requiresSemanticEvidence(text)`
- `hasPassingSemanticEvidence(evaluationResults)`

关键词先保守支持：`筛选`、`仅包含`、`字段`、`包含`、`不包含`、`lowStock`、`isLowStock`。

**Step 4: 验证**

Run:

```powershell
node --test tests/core/release-gate-node.test.js
npx tsc --noEmit
```

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/core/nodes/release_gate_node.ts tests/core/release-gate-node.test.js
git commit -m "fix: require semantic evidence for semantic acceptance"
```

---

### Task 4: Focused regression and smoke

**Files:**
- Inspect: `workspace/run_*/session/events.jsonl`
- Inspect: `workspace/run_*/boulder.json`
- Inspect: `workspace/run_*/audit/Infrastructure.md`
- Inspect: `workspace/run_*/audit/Terminal.md`
- Optional Modify: docs only if smoke exposes known gaps.

**Step 1: 跑核心回归**

Run:

```powershell
node --test tests/core/managed-harness-types.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: PASS。

**Step 2: 跑 managed smoke**

Run:

```powershell
Get-Content ..\..\.env | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { $name=$matches[1].Trim(); $value=$matches[2].Trim().Trim('"').Trim("'"); [Environment]::SetEnvironmentVariable($name, $value, 'Process') } }; npx ts-node src/index.ts --auto-approve all "创建一个 TypeScript Express 库存看板，包含商品列表页面 /products、库存状态 API /api/products、低库存筛选能力和自动化测试"
```

Expected:

- events 包含 `evaluation_completed`，且 payload 中有 assertion evidence。
- release gate pass 前存在 semantic evidence。

**Step 3: 手工核验**

执行：

- `curl /api/products`
- `curl /api/products?lowStock=true`
- `curl /products?lowStock=true`
- 容器内 `npm test`
- 容器内 `npm run build`

Expected: 语义与 HTTP 状态均符合验收。

**Step 4: 记录结果并 commit**

```powershell
git add docs/plans/2026-05-15-semantic-evidence-implementation-plan.md FAILURE_PATTERNS.md KNOWLEDGE.md
git commit -m "docs: record semantic evidence smoke"
```
