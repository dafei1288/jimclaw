# Managed Agent Harness Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 JimClaw 从文件级角色流水线改造成基于 `SprintPlan`、`SprintContract`、`EvaluationResult` 的契约驱动 managed agent harness。

**Architecture:** 第一阶段保持现有 LangGraph 主流程和 `SubTask[]` 兼容，新增 sprint planning、contract、evaluator、release gate 控制对象。放行权逐步从 `qa.isDone` 转移到 evaluator evidence 和 release gate。第二阶段再把 `SubTask[]` 降级为 builder 内部实现细节，并把 session events 作为事实源。

**Tech Stack:** TypeScript, LangGraph.js, Zod, Node test runner, existing JimClaw node structure, existing `host.httpGet`, existing audit/meeting note utilities.

---

## 实施原则

1. 每个任务都先写测试，再实现。
2. 第一阶段不删除旧字段，只新增并桥接。
3. 每次只改一个控制面对象或一个节点。
4. 所有新增 state 都必须能写入 `boulder.json`。
5. 所有节点失败必须产出 `ValidationReport` 或明确 evidence。
6. 面向用户输出、日志、prompt 继续使用中文。

## 推荐分支

```bash
git checkout -b feat/managed-agent-harness
```

## Task 1: 新增 managed harness 状态类型

**Files:**
- Modify: `src/core/graph_types.ts`
- Test: `tests/core/managed-harness-types.test.js`

**Step 1: Write the failing test**

Create `tests/core/managed-harness-types.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
require("ts-node/register/transpile-only");

const {
  ProductSpecSchema,
  SprintPlanSchema,
  SprintContractSchema,
  EvaluationResultSchema,
} = require("../../src/core/graph_types");

test("managed harness schemas accept the minimal sprint contract flow", () => {
  const product = ProductSpecSchema.parse({
    version: "v1",
    title: "图书管理系统",
    userGoal: "用户可以管理图书",
    userStories: [{ id: "US-1", story: "用户可以查看图书列表", priority: "must" }],
    acceptanceCriteria: [{
      id: "AC-1",
      description: "GET /api/books 返回 200",
      verificationKind: "api",
    }],
    nonGoals: [],
  });

  const sprint = SprintPlanSchema.parse({
    id: "SP-1",
    title: "图书列表闭环",
    goal: "用户可以查看图书列表",
    userStoryIds: ["US-1"],
    acceptanceCriteriaIds: ["AC-1"],
    deliverables: ["列表 API", "基础页面"],
    allowedScope: ["src/", "tests/", "frontend/"],
    dependencies: [],
    estimatedComplexity: "medium",
    doneWhen: ["GET /api/books 返回 200"],
  });

  const contract = SprintContractSchema.parse({
    version: "v1",
    sprintId: "SP-1",
    builderPlan: {
      intent: "实现图书列表 API",
      filesLikelyTouched: ["src/index.ts", "tests/books.test.ts"],
      implementationSteps: ["补 API", "补测试"],
      selfChecks: ["npm test"],
      assumptions: [],
    },
    evaluatorPlan: {
      checks: [{
        id: "CHK-1",
        kind: "http",
        description: "访问图书列表",
        url: "http://127.0.0.1:4000/api/books",
        method: "GET",
        expectedStatus: [200],
      }],
      requiredEvidence: ["HTTP 200"],
      passThreshold: "all",
      concerns: [],
    },
    agreedScope: {
      allowedFiles: ["src/index.ts", "tests/books.test.ts"],
      forbiddenFiles: [],
      maxNewFiles: 4,
    },
    status: "agreed",
  });

  const evaluation = EvaluationResultSchema.parse({
    version: "v1",
    sprintId: "SP-1",
    status: "pass",
    checks: [{
      checkId: "CHK-1",
      status: "pass",
      evidence: { httpStatus: 200, httpBodySnippet: "[]" },
      reproSteps: ["GET /api/books"],
      suspectedFiles: [],
    }],
    summary: "图书列表 API 已通过",
  });

  assert.equal(product.title, "图书管理系统");
  assert.equal(sprint.id, "SP-1");
  assert.equal(contract.status, "agreed");
  assert.equal(evaluation.status, "pass");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/managed-harness-types.test.js
```

Expected: FAIL because schemas are not exported.

**Step 3: Add types and schemas**

In `src/core/graph_types.ts`, add interfaces:

```ts
export type VerificationKind = "api" | "ui" | "unit" | "build" | "deploy" | "manual";

export interface ProductSpec {
  version: "v1";
  title: string;
  userGoal: string;
  userStories: Array<{
    id: string;
    story: string;
    priority: "must" | "should" | "could";
  }>;
  acceptanceCriteria: Array<{
    id: string;
    description: string;
    verificationKind: VerificationKind;
  }>;
  nonGoals: string[];
}

export interface SprintPlan {
  id: string;
  title: string;
  goal: string;
  userStoryIds: string[];
  acceptanceCriteriaIds: string[];
  deliverables: string[];
  allowedScope: string[];
  dependencies: string[];
  estimatedComplexity: "small" | "medium" | "large";
  doneWhen: string[];
}

export interface EvaluationCheck {
  id: string;
  kind: "command" | "http" | "playwright" | "file" | "unit" | "deploy";
  description: string;
  command?: string;
  url?: string;
  method?: string;
  expectedStatus?: number[];
  expectedText?: string;
  targetFile?: string;
}

export interface SprintContract {
  version: "v1";
  sprintId: string;
  builderPlan: {
    intent: string;
    filesLikelyTouched: string[];
    implementationSteps: string[];
    selfChecks: string[];
    assumptions: string[];
  };
  evaluatorPlan: {
    checks: EvaluationCheck[];
    requiredEvidence: string[];
    passThreshold: "all" | "critical-only";
    concerns: string[];
  };
  agreedScope: {
    allowedFiles: string[];
    forbiddenFiles: string[];
    maxNewFiles?: number;
  };
  status: "draft" | "agreed" | "rejected";
}

export interface EvaluationResult {
  version: "v1";
  sprintId: string;
  status: "pass" | "fail";
  checks: Array<{
    checkId: string;
    status: "pass" | "fail" | "skipped";
    evidence: {
      commandOutput?: string;
      httpStatus?: number | null;
      httpBodySnippet?: string;
      screenshotPath?: string;
      tracePath?: string;
      fileSnippet?: string;
      error?: string;
    };
    reproSteps: string[];
    suspectedFiles: string[];
  }>;
  summary: string;
}
```

Add Zod schemas for these types and export them.

Then add annotations to `JimClawState`:

```ts
productSpec: Annotation<ProductSpec | null>({
  reducer: (x, y) => y ?? x,
}),
sprintPlans: Annotation<SprintPlan[]>({
  reducer: (x, y) => y !== undefined ? y : (x || []),
}),
activeSprintId: Annotation<string>({
  reducer: (x, y) => y ?? x,
}),
sprintContracts: Annotation<SprintContract[]>({
  reducer: (x, y) => y !== undefined ? y : (x || []),
}),
evaluationResults: Annotation<EvaluationResult[]>({
  reducer: (x, y) => [...(x || []), ...(y || [])],
}),
```

**Step 4: Run test to verify it passes**

Run:

```bash
node --test tests/core/managed-harness-types.test.js
npx tsc --noEmit
```

Expected: both pass.

**Step 5: Commit**

```bash
git add src/core/graph_types.ts tests/core/managed-harness-types.test.js
git commit -m "feat: add managed harness state types"
```

## Task 2: Convert TaskContract to ProductSpec

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/nodes/pm_node.ts`
- Test: `tests/core/pm-node.test.js`

**Step 1: Write the failing test**

Add a test in `tests/core/pm-node.test.js`:

```js
test("pm derives product spec from task contract", async () => {
  const { buildProductSpec } = require("../../src/core/logic_utils");
  const spec = buildProductSpec("图书管理系统", {
    title: "图书管理系统",
    requirements: ["提供图书列表 API", "提供前端页面"],
    acceptanceCriteria: ["GET /api/books 返回 200", "页面可以显示图书列表"],
  });

  assert.equal(spec.version, "v1");
  assert.equal(spec.title, "图书管理系统");
  assert.ok(spec.userStories.length >= 1);
  assert.ok(spec.acceptanceCriteria.some((item) => item.verificationKind === "api"));
  assert.ok(spec.acceptanceCriteria.some((item) => item.verificationKind === "ui"));
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/pm-node.test.js
```

Expected: FAIL because `buildProductSpec` does not exist.

**Step 3: Implement converter**

Add to `src/core/logic_utils.ts`:

```ts
export function inferVerificationKind(text: string): VerificationKind {
  const normalized = String(text || "").toLowerCase();
  if (/页面|前端|ui|浏览器|点击|显示|表单|button|page/.test(normalized)) return "ui";
  if (/api|http|get |post |put |delete |patch |接口|端点|返回\s*\d{3}/i.test(text)) return "api";
  if (/部署|启动|访问地址|health|健康检查/.test(normalized)) return "deploy";
  if (/测试|单元|npm test|pytest|go test|cargo test/.test(normalized)) return "unit";
  if (/构建|build|compile|tsc/.test(normalized)) return "build";
  return "manual";
}

export function buildProductSpec(userGoal: string, contract: TaskContract | null | undefined): ProductSpec {
  const requirements = contract?.requirements || [];
  const criteria = contract?.acceptanceCriteria || [];
  return {
    version: "v1",
    title: contract?.title || userGoal || "未命名任务",
    userGoal: userGoal || contract?.title || "",
    userStories: requirements.map((requirement, index) => ({
      id: `US-${index + 1}`,
      story: requirement,
      priority: "must" as const,
    })),
    acceptanceCriteria: criteria.map((criterion, index) => ({
      id: `AC-${index + 1}`,
      description: criterion,
      verificationKind: inferVerificationKind(criterion),
    })),
    nonGoals: [],
  };
}
```

Update `pm_node.ts` to set `productSpec` in result.

**Step 4: Run tests**

Run:

```bash
node --test tests/core/pm-node.test.js tests/core/pure-functions.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts src/core/nodes/pm_node.ts tests/core/pm-node.test.js
git commit -m "feat: derive product spec from task contract"
```

## Task 3: Add deterministic sprint planning utilities

**Files:**
- Modify: `src/core/logic_utils.ts`
- Test: `tests/core/sprint-planner.test.js`

**Step 1: Write failing tests**

Create `tests/core/sprint-planner.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
require("ts-node/register/transpile-only");

const { buildSprintPlans } = require("../../src/core/logic_utils");

test("buildSprintPlans creates vertical slices from product spec", () => {
  const plans = buildSprintPlans({
    productSpec: {
      version: "v1",
      title: "图书管理系统",
      userGoal: "图书管理",
      userStories: [
        { id: "US-1", story: "用户可以查看图书列表", priority: "must" },
        { id: "US-2", story: "用户可以新增图书", priority: "must" },
      ],
      acceptanceCriteria: [
        { id: "AC-1", description: "GET /api/books 返回 200", verificationKind: "api" },
        { id: "AC-2", description: "页面显示图书列表", verificationKind: "ui" },
      ],
      nonGoals: [],
    },
    apiContract: { endpoints: [{ path: "/api/books", method: "GET", description: "列表" }] },
    spec: { language: "TypeScript", framework: "Express", filesToCreate: [] },
  });

  assert.ok(plans.length >= 1);
  assert.ok(plans[0].goal.includes("启动") || plans[0].goal.includes("列表"));
  assert.ok(plans.some((plan) => plan.acceptanceCriteriaIds.includes("AC-1")));
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/sprint-planner.test.js
```

Expected: FAIL because `buildSprintPlans` does not exist.

**Step 3: Implement utility**

Add deterministic utility:

```ts
export function buildSprintPlans(args: {
  productSpec: ProductSpec | null | undefined;
  apiContract: ApiContract | null | undefined;
  spec: Partial<TechSpec> | null | undefined;
}): SprintPlan[] {
  const product = args.productSpec;
  if (!product) return [];

  const plans: SprintPlan[] = [];
  const hasUi = product.acceptanceCriteria.some((item) => item.verificationKind === "ui");
  const hasApi = product.acceptanceCriteria.some((item) => item.verificationKind === "api");
  const allAcIds = product.acceptanceCriteria.map((item) => item.id);

  plans.push({
    id: "SP-1",
    title: "可运行骨架与健康检查",
    goal: "应用可以安装、启动，并通过基础健康检查",
    userStoryIds: product.userStories.slice(0, 1).map((item) => item.id),
    acceptanceCriteriaIds: allAcIds.filter((id) => {
      const item = product.acceptanceCriteria.find((ac) => ac.id === id);
      return item && ["build", "deploy", "unit"].includes(item.verificationKind);
    }),
    deliverables: ["可运行应用", "基础测试", "健康检查"],
    allowedScope: ["package.json", "tsconfig.json", "src/", "tests/", "Dockerfile", "docker-compose.yml"],
    dependencies: [],
    estimatedComplexity: "small",
    doneWhen: ["测试命令通过", "健康检查可访问"],
  });

  if (hasApi || hasUi) {
    plans.push({
      id: "SP-2",
      title: "核心用户路径闭环",
      goal: "完成用户最重要的 API/UI 纵向路径",
      userStoryIds: product.userStories.map((item) => item.id),
      acceptanceCriteriaIds: allAcIds,
      deliverables: [
        hasApi ? "核心 API 行为" : "",
        hasUi ? "核心页面交互" : "",
      ].filter(Boolean),
      allowedScope: ["src/", "tests/", "frontend/", "public/"],
      dependencies: ["SP-1"],
      estimatedComplexity: "medium",
      doneWhen: product.acceptanceCriteria.map((item) => item.description),
    });
  }

  return plans.filter((plan) => plan.acceptanceCriteriaIds.length > 0 || plan.id === "SP-1");
}
```

**Step 4: Run tests**

Run:

```bash
node --test tests/core/sprint-planner.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/core/logic_utils.ts tests/core/sprint-planner.test.js
git commit -m "feat: build deterministic sprint plans"
```

## Task 4: Add `sprint_planner_node`

**Files:**
- Create: `src/core/nodes/sprint_planner_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/sprint-planner-node.test.js`

**Step 1: Write failing test**

Create `tests/core/sprint-planner-node.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
} = require("./test-helpers");
require("ts-node/register/transpile-only");

const { sprintPlannerNode } = require("../../src/core/nodes/sprint_planner_node");

test("sprint planner writes sprint plans and active sprint", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  try {
    const result = await sprintPlannerNode(
      createBaseState({
        productSpec: {
          version: "v1",
          title: "图书管理系统",
          userGoal: "图书管理",
          userStories: [{ id: "US-1", story: "用户可以查看图书列表", priority: "must" }],
          acceptanceCriteria: [{ id: "AC-1", description: "GET /api/books 返回 200", verificationKind: "api" }],
          nonGoals: [],
        },
        apiContract: { endpoints: [{ path: "/api/books", method: "GET", description: "列表" }] },
        spec: { language: "TypeScript", framework: "Express", filesToCreate: [] },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.ok(result.sprintPlans.length >= 1);
    assert.equal(result.activeSprintId, result.sprintPlans[0].id);
    assert.ok(result.meetingNotes.length >= 1);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/sprint-planner-node.test.js
```

Expected: FAIL because node does not exist.

**Step 3: Implement node**

Create `src/core/nodes/sprint_planner_node.ts`:

```ts
import { JimClawState } from "../graph_types";
import { buildProductSpec, buildSprintPlans, writeMeetingNote } from "../logic_utils";

export async function sprintPlannerNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  startSpan("sprint_planner");
  emit("phase-change", "System", "sprint_planning");

  const productSpec = state.productSpec || buildProductSpec(state.userGoal || "", state.contract);
  const sprintPlans = buildSprintPlans({
    productSpec,
    apiContract: state.apiContract,
    spec: state.spec,
  });
  const activeSprintId = state.activeSprintId || sprintPlans[0]?.id || "";
  const note = await writeMeetingNote(
    WORKSPACE,
    "note-sprint-planner-r0",
    "sprint_planner",
    0,
    `拆分为 ${sprintPlans.length} 个 Sprint`,
    `# Sprint Planner\n\n\`\`\`json\n${JSON.stringify(sprintPlans, null, 2)}\n\`\`\`\n`
  );

  const result = {
    productSpec,
    sprintPlans,
    activeSprintId,
    meetingNotes: [note],
  };
  await saveBoulder({ ...state, ...result }, "sprint_planner");
  return result;
}
```

Wire graph after `orchestrator` initially:

```text
orchestrator -> sprint_planner -> coder
```

Keep old `orchestrator` output unchanged.

**Step 4: Run tests**

Run:

```bash
node --test tests/core/sprint-planner-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/core/nodes/sprint_planner_node.ts src/core/graph.ts tests/core/sprint-planner-node.test.js
git commit -m "feat: add sprint planner node"
```

## Task 5: Add `sprint_contract_node`

**Files:**
- Create: `src/core/nodes/sprint_contract_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/sprint-contract-node.test.js`

**Step 1: Write failing test**

Create `tests/core/sprint-contract-node.test.js` with a minimal state and assert:

- result contains one `SprintContract`
- contract `status` is `agreed`
- evaluator plan has at least one check
- agreed scope has allowed files

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/sprint-contract-node.test.js
```

Expected: FAIL because node does not exist.

**Step 3: Implement deterministic first version**

First version should not call LLM. Build contract from active sprint:

```ts
function buildDefaultEvaluationChecks(state: JimClawState, sprint: SprintPlan): EvaluationCheck[] {
  const checks: EvaluationCheck[] = [];
  for (const endpoint of state.apiContract?.endpoints || []) {
    if (String(endpoint.method || "").toUpperCase() !== "GET") continue;
    checks.push({
      id: `CHK-HTTP-${checks.length + 1}`,
      kind: "http",
      description: `验证 ${endpoint.method} ${endpoint.path}`,
      method: "GET",
      url: endpoint.path,
      expectedStatus: [200, 201, 204],
    });
  }
  if (!checks.length && state.spec?.testCommand) {
    checks.push({
      id: "CHK-CMD-1",
      kind: "command",
      description: "运行项目测试命令",
      command: state.spec.testCommand,
    });
  }
  return checks;
}
```

The node writes:

```ts
const contract: SprintContract = {
  version: "v1",
  sprintId: sprint.id,
  builderPlan: {
    intent: sprint.goal,
    filesLikelyTouched: state.spec?.filesToCreate || [],
    implementationSteps: sprint.deliverables,
    selfChecks: [state.spec?.testCommand || ""].filter(Boolean),
    assumptions: [],
  },
  evaluatorPlan: {
    checks,
    requiredEvidence: checks.map((check) => check.description),
    passThreshold: "all",
    concerns: [],
  },
  agreedScope: {
    allowedFiles: state.spec?.filesToCreate || sprint.allowedScope,
    forbiddenFiles: ["node_modules/", "dist/", ".git/"],
    maxNewFiles: 8,
  },
  status: checks.length > 0 ? "agreed" : "rejected",
};
```

**Step 4: Wire graph**

Route:

```text
sprint_planner -> sprint_contract -> coder
```

**Step 5: Run tests**

Run:

```bash
node --test tests/core/sprint-contract-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 6: Commit**

```bash
git add src/core/nodes/sprint_contract_node.ts src/core/graph.ts tests/core/sprint-contract-node.test.js
git commit -m "feat: add sprint contract gate"
```

## Task 6: Inject SprintContract into Coder context

**Files:**
- Modify: `src/core/nodes/coder_node.ts`
- Modify: `src/core/logic_utils.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write failing test**

Add a test asserting the coder prompt/context contains:

- active sprint id
- builder intent
- allowed files
- evaluator checks

Use existing test harness patterns in `tests/core/coder-node.test.js`.

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/coder-node.test.js
```

Expected: FAIL because coder does not include sprint contract.

**Step 3: Add helper**

In `logic_utils.ts`:

```ts
export function getActiveSprintContract(state: Pick<JimClawState, "activeSprintId" | "sprintContracts">): SprintContract | null {
  const id = state.activeSprintId || "";
  const contracts = state.sprintContracts || [];
  return contracts.find((item) => item.sprintId === id && item.status === "agreed") || null;
}

export function buildSprintContractContext(state: JimClawState): string {
  const contract = getActiveSprintContract(state);
  if (!contract) return "";
  return [
    "## 当前 SprintContract（必须遵守）",
    `Sprint: ${contract.sprintId}`,
    `目标: ${contract.builderPlan.intent}`,
    `允许文件: ${contract.agreedScope.allowedFiles.join(", ")}`,
    `禁止文件: ${contract.agreedScope.forbiddenFiles.join(", ")}`,
    "Evaluator 检查:",
    ...contract.evaluatorPlan.checks.map((check) => `- ${check.id}: ${check.description}`),
  ].join("\n");
}
```

In `coder_node.ts`, append this context to coder prompt and system context.

**Step 4: Enforce allowed scope lightly**

Before writing a file, if active contract exists and file is clearly outside `allowedFiles`, mark task blocked:

```ts
if (contract && !isFileAllowedBySprintContract(fileTarget, contract)) {
  return blocked result with validationReport failureType "planning_gap";
}
```

First version can use prefix matching.

**Step 5: Run tests**

Run:

```bash
node --test tests/core/coder-node.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 6: Commit**

```bash
git add src/core/nodes/coder_node.ts src/core/logic_utils.ts tests/core/coder-node.test.js
git commit -m "feat: constrain coder with sprint contract"
```

## Task 7: Add `evaluator_node`

**Files:**
- Create: `src/core/nodes/evaluator_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/evaluator-node.test.js`

**Step 1: Write failing tests**

Create tests for:

1. HTTP check pass.
2. HTTP check fail produces suspected files and validation report.
3. Missing evidence cannot pass.

Use a fake `host` dependency injection if needed.

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/evaluator-node.test.js
```

Expected: FAIL because node does not exist.

**Step 3: Implement node**

Core behavior:

```ts
export async function evaluatorNode(...) {
  const contract = getActiveSprintContract(state);
  if (!contract) {
    return planning_gap result;
  }

  const checks = [];
  for (const check of contract.evaluatorPlan.checks) {
    if (check.kind === "http") {
      const url = resolveEvaluationUrl(state, check.url);
      const result = await host.httpGet(url, 5000);
      const ok = Boolean(result.statusCode && (check.expectedStatus || [200]).includes(result.statusCode));
      checks.push({
        checkId: check.id,
        status: ok ? "pass" : "fail",
        evidence: {
          httpStatus: result.statusCode,
          httpBodySnippet: String(result.body || "").slice(0, 500),
          error: result.error,
        },
        reproSteps: [`GET ${url}`],
        suspectedFiles: ok ? [] : inferSuspectedFilesFromCheck(state, check),
      });
    }
    if (check.kind === "command") {
      // First version may reuse state.testResults if terminal already ran.
      const ok = !extractFailureEvidence(state.testResults || "", state.deploymentStatus, state.blockedReason).hasBlockingFailure;
      checks.push({
        checkId: check.id,
        status: ok ? "pass" : "fail",
        evidence: { commandOutput: String(state.testResults || "").slice(0, 2000) },
        reproSteps: [check.command || state.spec?.testCommand || ""].filter(Boolean),
        suspectedFiles: [],
      });
    }
  }

  const status = checks.every((item) => item.status === "pass" && Object.keys(item.evidence || {}).length > 0)
    ? "pass"
    : "fail";
}
```

Write `EvaluationResult`, `ValidationReport`, `Issue[]`, meeting note.

**Step 4: Wire graph**

Initial safe route:

```text
verifier -> evaluator -> qa
```

Update conditional route:

- Evaluator pass -> `qa`
- Evaluator fail -> `qa`

QA still classifies. Later release gate will use evaluation results.

**Step 5: Run tests**

Run:

```bash
node --test tests/core/evaluator-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 6: Commit**

```bash
git add src/core/nodes/evaluator_node.ts src/core/graph.ts tests/core/evaluator-node.test.js
git commit -m "feat: add evaluator evidence node"
```

## Task 8: Add `release_gate_node`

**Files:**
- Create: `src/core/nodes/release_gate_node.ts`
- Modify: `src/core/graph.ts`
- Test: `tests/core/release-gate-node.test.js`

**Step 1: Write failing tests**

Tests:

1. All sprint evaluations pass -> release gate pass.
2. Missing acceptance evidence -> release gate fail.
3. Frontend required but no frontend evidence -> release gate fail.

**Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/core/release-gate-node.test.js
```

Expected: FAIL.

**Step 3: Implement release gate**

Rules:

```ts
const mustStories = productSpec.userStories.filter((story) => story.priority === "must");
const passedSprintIds = new Set(evaluationResults.filter((r) => r.status === "pass").map((r) => r.sprintId));
const uncoveredCriteria = productSpec.acceptanceCriteria.filter((criterion) => {
  return !evaluationResults.some((result) =>
    result.status === "pass" &&
    result.checks.some((check) => {
      const evidenceText = JSON.stringify(check.evidence || {});
      return evidenceText.includes(criterion.description) || check.status === "pass";
    })
  );
});
```

Return:

- pass: `isDone=true`, `validationReport pass`
- fail: `isDone=false`, `validationReport runtime_gap/planning_gap`, `lastFailedNode="release_gate"`

**Step 4: Wire graph**

Route:

```text
deploy -> release_gate -> post_mortem
```

If release gate fails:

```text
release_gate -> qa
```

**Step 5: Run tests**

Run:

```bash
node --test tests/core/release-gate-node.test.js tests/core/deploy-node.test.js tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 6: Commit**

```bash
git add src/core/nodes/release_gate_node.ts src/core/graph.ts tests/core/release-gate-node.test.js
git commit -m "feat: gate release on evaluation evidence"
```

## Task 9: Convert `fix_plan` to `repair_contract` compatibility

**Files:**
- Modify: `src/core/nodes/fix_plan_node.ts`
- Modify: `src/core/graph_types.ts`
- Test: `tests/core/fix-plan-node.test.js`

**Step 1: Write failing test**

Add test:

- Given failed `EvaluationResult`, `fix_plan_node` returns a repair contract scoped to active sprint.
- `subTasks` for suspected files are reopened.

**Step 2: Add type**

```ts
export interface RepairContract {
  version: "v1";
  sprintId: string;
  sourceEvaluationResultId?: string;
  failedChecks: string[];
  repairScope: string[];
  instructions: string[];
  expectedEvidence: string[];
}
```

Add `repairContracts` state annotation.

**Step 3: Update `fix_plan_node`**

Keep existing `fixPlan` output, but additionally write `repairContracts`.

**Step 4: Run tests**

Run:

```bash
node --test tests/core/fix-plan-node.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/core/graph_types.ts src/core/nodes/fix_plan_node.ts tests/core/fix-plan-node.test.js
git commit -m "feat: scope repairs to sprint contracts"
```

## Task 10: Add session event append-only log

**Files:**
- Create: `src/utils/session_events.ts`
- Modify: `src/utils/audit.ts` or node call sites
- Test: `tests/core/session-events.test.js`

**Step 1: Write failing test**

Test appending two events creates `workspace/session/events.jsonl` and preserves order.

**Step 2: Implement utility**

```ts
export async function appendSessionEvent(workspace: string, event: Omit<SessionEvent, "id" | "createdAt">): Promise<SessionEvent> {
  const fullEvent = {
    ...event,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  const dir = path.join(workspace, "session");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "events.jsonl"), `${JSON.stringify(fullEvent)}\n`, "utf-8");
  return fullEvent;
}
```

Use it in new nodes first:

- `sprint_planner_node`
- `sprint_contract_node`
- `evaluator_node`
- `release_gate_node`

**Step 3: Run tests**

Run:

```bash
node --test tests/core/session-events.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/utils/session_events.ts src/core/nodes/sprint_planner_node.ts src/core/nodes/sprint_contract_node.ts src/core/nodes/evaluator_node.ts src/core/nodes/release_gate_node.ts tests/core/session-events.test.js
git commit -m "feat: persist managed harness session events"
```

## Task 11: Add feature flag and compatibility mode

**Files:**
- Modify: `jimclaw.config.json.example`
- Modify: `src/utils/models.ts` or config loader
- Modify: `src/core/graph.ts`
- Test: `tests/core/workflow-replay.test.js`

**Step 1: Add config**

```json
{
  "managedHarness": {
    "enabled": false,
    "evaluatorRequired": true,
    "releaseGateRequired": true
  }
}
```

**Step 2: Route conditionally**

If disabled:

```text
orchestrator -> coder
verifier -> qa
deploy -> post_mortem
```

If enabled:

```text
orchestrator -> sprint_planner -> sprint_contract -> coder
verifier -> evaluator -> qa
deploy -> release_gate
```

**Step 3: Run tests twice**

Run:

```bash
node --test tests/core/workflow-replay.test.js
npx tsc --noEmit
```

Expected: pass.

**Step 4: Commit**

```bash
git add jimclaw.config.json.example src/core/graph.ts tests/core/workflow-replay.test.js
git commit -m "feat: guard managed harness behind config"
```

## Task 12: Real smoke validation

**Files:**
- No required source changes unless failures found.
- Inspect: `workspace/run_*/audit/Infrastructure.md`
- Inspect: `workspace/run_*/audit/Terminal.md`
- Inspect: `workspace/run_*/session/events.jsonl`

**Step 1: Compile**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS.

**Step 2: Unit test focused suite**

Run:

```bash
node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js
```

Expected: PASS.

**Step 3: Full relevant suite**

Run:

```bash
node --test tests/core/pm-node.test.js tests/core/orchestrator-node.test.js tests/core/coder-node.test.js tests/core/terminal-node.test.js tests/core/verifier-node.test.js tests/core/qa-node.test.js tests/core/deploy-node.test.js tests/core/workflow-replay.test.js
```

Expected: PASS.

**Step 4: E2E smoke**

Run:

```bash
npx ts-node src/index.ts --auto-approve all "简单图书管理系统，包含图书列表 API 和页面"
```

Expected:

- run reaches persistence or release gate pass.
- `session/events.jsonl` contains sprint plan, contract, evaluation result.
- frontend required tasks include HTTP or UI evidence.

**Step 5: Mandatory evidence check**

Run:

```bash
npx ts-node scripts/run_health_report.ts workspace --limit 3
```

Then manually inspect latest run:

- `audit/Infrastructure.md`
- `audit/Terminal.md`
- `session/events.jsonl`
- `boulder.json`

Expected:

- no unexplained `Critical Error`
- no hidden build failure
- release gate evidence exists

**Step 6: Commit**

```bash
git add .
git commit -m "test: validate managed harness smoke flow"
```

## Final verification checklist

Before claiming completion:

```bash
npx tsc --noEmit
node --test tests/core/managed-harness-types.test.js tests/core/sprint-planner.test.js tests/core/sprint-planner-node.test.js tests/core/sprint-contract-node.test.js tests/core/evaluator-node.test.js tests/core/release-gate-node.test.js
node --test tests/core/workflow-replay.test.js tests/core/qa-node.test.js tests/core/deploy-node.test.js
```

Then run one real E2E smoke and inspect:

```text
workspace/run_xxx/audit/Infrastructure.md
workspace/run_xxx/audit/Terminal.md
workspace/run_xxx/session/events.jsonl
workspace/run_xxx/boulder.json
```

## Rollback strategy

Because the implementation is behind `managedHarness.enabled`, rollback is:

1. Set `managedHarness.enabled=false`.
2. Keep new state fields harmlessly unused.
3. Route graph through legacy path.

No data migration is required in first phase.
