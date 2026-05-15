# Frontend Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 JimClaw 的前端工程形态和 UI 可调用能力纳入执行协议，支持静态页 fallback 与 React/Vue 前后端分离项目，并避免 GET-only API 被前端模板误扩展成 CRUD。

**Architecture:** 先在 `ExecutionProtocol` 中加入 `contracts.frontend`，从 `TechSpec.frontend`、文件布局和 `apiContract` 推导前端 root、框架和 API 使用能力。再让文件注入、Orchestrator 文案、React/Vue/static scaffold 都消费这个契约，而不是各自猜测。

**Tech Stack:** TypeScript, Node test runner, LangGraph state types, Vite React/Vue scaffold providers.

---

### Task 1: FrontendContract 类型与协议构建

**Files:**
- Modify: `src/core/graph_types.ts`
- Modify: `src/core/logic_utils.ts`
- Test: `tests/core/execution-protocol.test.js`

**Step 1: Write failing tests**

Add tests for:

- `buildExecutionProtocol()` returns `frontendRoots: ["frontend"]` for `spec.frontend`.
- `buildExecutionProtocol().contracts.frontend` identifies `spa/react`.
- GET-only `/api/products` produces `supportsList=true` and write flags false.

Run:

```bash
node --test --test-name-pattern "frontend contract" tests/core/execution-protocol.test.js
```

Expected: fail because `contracts.frontend` does not exist and `frontendRoots` is currently `["public"]` or empty.

**Step 2: Implement minimal code**

Add frontend contract interfaces and schema-compatible plain object fields:

```ts
export interface FrontendApiUsage {
  resourcePath: string;
  methods: string[];
  supportsList: boolean;
  supportsCreate: boolean;
  supportsUpdate: boolean;
  supportsDelete: boolean;
}

export interface FrontendContract {
  appType: "none" | "static" | "spa";
  framework: "none" | "vanilla" | "react" | "vue" | "svelte";
  rootDir: "" | "public" | "frontend";
  entryFiles: string[];
  apiUsage: FrontendApiUsage[];
}
```

Implement helpers in `logic_utils.ts`:

- `detectFrontendRoots(files)`
- `buildFrontendContract(spec, apiContract)`
- `deriveFrontendApiUsage(apiContract)`

Wire into `buildExecutionProtocol()`.

**Step 3: Verify**

Run:

```bash
node --test --test-name-pattern "frontend contract" tests/core/execution-protocol.test.js
npx tsc --noEmit
```

Expected: targeted tests pass, TypeScript compiles.

**Step 4: Commit**

```bash
git add src/core/graph_types.ts src/core/logic_utils.ts tests/core/execution-protocol.test.js
git commit -m "feat: add frontend contract to execution protocol"
```

### Task 2: Modern frontend file planning and provider selection

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/core/nodes/architect_node.ts`
- Test: `tests/core/execution-protocol.test.js`
- Test: `tests/core/architect-node.test.js`

**Step 1: Write failing tests**

Add tests for:

- `ensureRequirementDrivenFiles()` does not add `public/index.html` when `spec.frontend` exists.
- `buildFrontendFiles()` returns React Vite files when `targetStack.frontend === "React"`.

Run:

```bash
node --test --test-name-pattern "frontend files|React frontend" tests/core/execution-protocol.test.js tests/core/architect-node.test.js
```

Expected: fail because `public/index.html` is still injected and React frontend files are missing.

**Step 2: Implement minimal code**

Change `ensureRequirementDrivenFiles()`:

```ts
const hasModernFrontend = Boolean((nextSpec as any).frontend) || files.some((file) => /^frontend\//i.test(file));
if (frontendRequired && !hasModernFrontend) ensureFile("public/index.html");
```

Change `buildFrontendFiles()`:

- Keep Vue branch.
- Add React branch matching `react_typescript.ts` provider targets.

**Step 3: Verify**

Run:

```bash
node --test --test-name-pattern "frontend files|React frontend" tests/core/execution-protocol.test.js tests/core/architect-node.test.js
npx tsc --noEmit
```

Expected: targeted tests pass.

**Step 4: Commit**

```bash
git add src/core/logic_utils.ts src/core/nodes/architect_node.ts tests/core/execution-protocol.test.js tests/core/architect-node.test.js
git commit -m "fix: plan modern frontend files without static fallback"
```

### Task 3: Contract-aware frontend scaffold generation

**Files:**
- Modify: `src/core/logic_utils.ts`
- Modify: `src/scaffolds/react_typescript.ts`
- Modify: `src/scaffolds/vue_typescript.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write failing tests**

Add tests for:

- Static `public/index.html` with GET-only API does not include `method: "POST"`, `method: "DELETE"`, “新增”, “编辑”, “删除”.
- React GET-only scaffold does not export `create/update/delete` API functions and does not render create/delete controls.
- Vue GET-only scaffold does not export `create/update/delete` API functions and does not render create/delete controls.

Run:

```bash
node --test --test-name-pattern "GET-only frontend scaffold" tests/core/coder-node.test.js
```

Expected: fail because current scaffolds default to CRUD UI.

**Step 2: Implement minimal code**

Add shared endpoint capability derivation in each scaffold or a small helper:

```ts
const supportsCreate = methods.has("POST");
const supportsUpdate = methods.has("PUT") || methods.has("PATCH");
const supportsDelete = methods.has("DELETE");
```

Generate UI and API functions conditionally.

**Step 3: Verify**

Run:

```bash
node --test --test-name-pattern "GET-only frontend scaffold|does not generate write assertions" tests/core/coder-node.test.js
npx tsc --noEmit
```

Expected: targeted tests pass.

**Step 4: Commit**

```bash
git add src/core/logic_utils.ts src/scaffolds/react_typescript.ts src/scaffolds/vue_typescript.ts tests/core/coder-node.test.js
git commit -m "fix: constrain frontend scaffolds to API contract"
```

### Task 4: Orchestrator task wording and smoke verification

**Files:**
- Modify: `src/core/nodes/orchestrator_node.ts`
- Test: `tests/core/orchestrator-node.test.js`

**Step 1: Write failing test**

Add a GET-only frontend requirement test asserting injected static page task does not mention “新增、编辑、删除”.

Run:

```bash
node --test --test-name-pattern "frontend task contract" tests/core/orchestrator-node.test.js
```

Expected: fail because current wording hardcodes full CRUD.

**Step 2: Implement minimal code**

Update injected task `contextRequirement` to say:

```txt
基于 API 契约生成可用交互；GET 只生成列表/查看，声明 POST/PUT/DELETE 时才生成新增/编辑/删除。
```

**Step 3: Verify**

Run:

```bash
node --test --test-name-pattern "frontend task contract" tests/core/orchestrator-node.test.js
node --test --test-name-pattern "frontend contract|GET-only frontend scaffold|does not generate write assertions" tests/core/execution-protocol.test.js tests/core/coder-node.test.js tests/core/orchestrator-node.test.js
npx tsc --noEmit
```

Expected: targeted tests pass.

**Step 4: Optional smoke**

Run one smoke with a generic resource, not books:

```bash
npx ts-node src/index.ts "创建一个 TypeScript Express 商品目录应用，提供商品列表页面 /products 和 JSON API /api/products，包含自动化测试"
```

Expected:

- `executionProtocol.contracts.frontend.apiUsage` only has GET capability.
- Generated UI does not call `POST/PUT/DELETE`.
- Tests pass without adding unsupported write routes.

**Step 5: Commit**

```bash
git add src/core/nodes/orchestrator_node.ts tests/core/orchestrator-node.test.js
git commit -m "fix: describe frontend tasks from API contract"
```

### Final Verification

Run:

```bash
npx tsc --noEmit
node --test --test-name-pattern "frontend contract|GET-only frontend scaffold|does not generate write assertions|frontend task contract" tests/core/execution-protocol.test.js tests/core/coder-node.test.js tests/core/orchestrator-node.test.js
git status --short
```

Expected:

- TypeScript compile passes.
- All targeted tests pass.
- Worktree is clean after commits.
