# Execution Integrity Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 JimClaw 当前“任务看似完成但执行闭环不可信”的问题，确保生成结果、状态持久化、契约一致性、验证入口四者一致。

**Architecture:** 本次改造先收敛到底层执行可靠性，不直接扩展新产品能力。核心思路是把“文件完成”的定义从“写入成功”升级为“通过结构校验、契约校验、状态原子提交”，再补齐最小回归测试与可观测性，使后续 `TODO` 中的回溯、图谱、多 workspace 等能力建立在可信状态之上。

**Tech Stack:** TypeScript, LangGraph StateGraph, Node.js, Express, Docker, node:test, npm, Prettier, existing JimClaw node workflow

---

## Progress Update

已完成：

1. 核心回归测试外壳与 `test:core`
2. Coder 坏文件拦截与原子状态提交
3. 生成后契约漂移校验
4. TypeScript/Jest 最小基线补齐
5. 失败节点兜底纪要、最后失败节点与失败摘要
6. `trace-index.json` 基线索引
7. `checkpoints/` 成功节点锚点基线
8. checkpoint replay 预览入口
9. CLI checkpoint 续跑入口
10. Web checkpoint 续跑入口
11. replay 复用原 workspace 与 trace 上下文
12. workspace 产物一致性校验器与 replay 一致性回归测试
13. `lint_fix` 中 `prettier` 工具失败分级，环境失败不再误伤 coder
14. `coder` 遵守 `orchestrator` 子任务依赖顺序
15. `coder` 阻塞即停，单文件失败后不再继续消耗 token 写后续文件
16. `qa` 对 `coder` 阻塞失败走聚焦分支，不再扩散到 untouched pending 文件
17. `BaseAgent` 增加 retryable 模型 fallback，降低单模型/单额度故障导致的节点崩溃
18. `fix_plan` 增加规则化降级路径，额度不足时仍能继续生成修复计划
19. Coding Plan 路由显式落地到 `coder` / `qa` / `fix_plan` 的代码相关调用，避免继续误走普通推理模型
20. 模型调用 token 用量落盘并汇总到 trace 索引，便于后续分析成本与异常消耗
21. QA 放行规则改为“失败证据优先”，`Verifier 预检失败` / 测试失败 / 编译失败 / 部署失败 / `Coder 阻塞失败` 均不会被空 issue 误放行
22. `infra_setup` / `terminal` / `verifier` / `deploy` 结构化纪要补齐，失败 run 的证据链不再只剩零散 audit
23. `audit/events.jsonl` 结构化事件流落盘，补齐可机读的 run 级事实源
24. 新增失败 run 提炼工具，可从 `workspace/run_xxx` 生成测试 fixture
25. 新增 dashboard snapshot harness，固定验证节点、文件、token、共识四条 UI 口径分离
26. 模板骨架接管 Express TypeScript 关键基础文件，减少首轮生成漂移
27. 非 compose 基础设施路径自动补 `npm run build`，修复“测试能过但 start 找不到 dist”问题
28. compose 基础设施路径改为 `docker-compose build + idle test container`，避免业务容器自启动干扰测试
29. deploy 健康检查改为“localhost + API 契约 GET 路径”，并补齐后台启动 PID / 日志采集
30. 真实最小任务 `workspace/run_1774415632972` 已完成端到端闭环，部署成功

其中 `trace-index.json` 当前包含最后节点、失败摘要、会议纪要索引、文件变更索引、按文件聚合状态和基础时间线；`checkpoints/` 当前为 `orchestrator` / `coder_final` / `verifier` / `qa` / `deploy` 留存成功节点快照；服务端已提供 checkpoint 列表和 replay 预览入口，CLI 与 Web 都已支持从 checkpoint 续跑，并且会复用原 workspace 与 trace 上下文；同时新增了 workspace 产物一致性校验器，用于校验 `boulder.json / trace-index.json / checkpoints` 是否仍属于同一条恢复链，并补充了 `subTasks` 与 `trace-index.files` 的联动一致性检查；另外，`lint_fix` 已区分工具环境失败与真实格式错误，避免 `prettier` 安装/网络抖动直接打断 coder，`coder` 也开始遵守 `orchestrator` 提供的文件依赖顺序，作为后续“任务溯源图谱 / 分支回溯”的底座。部署侧现在额外补齐了 `package.json` 启动路径与编译产物对齐、非 compose 路径自动 build、compose 路径的空闲测试容器语义，以及 `deploy` 的结构化启动日志与契约化健康检查，从而把最小 TypeScript Express 健康检查服务真正跑通到了 deploy success。

---

## Scope and Priority

### In Scope

1. 修复 Coder 阶段“坏文件也标记 completed”的问题
2. 修复文件真实状态与 `boulder.json` / `subTasks` 状态不一致的问题
3. 在 coder 后增加最小结构校验与契约校验
4. 为 TypeScript 生成项目补齐最小 Jest/ts-jest 脚手架策略
5. 补充最小自动化回归测试，覆盖本轮暴露出的回归点
6. 更新 `TODO.md`，把稳定性类工作前置，避免和大功能并行推进

### Out of Scope

1. 现代前端框架支持
2. 前端 Testing Library / Playwright 能力扩展
3. 多 workspace 会话管理的完整实现
4. 任务溯源图谱与分支回溯的完整实现

这些项只做重新排序，不在本计划内直接实现。

---

### Task 1: 为执行完整性建立回归测试外壳

**Files:**
- Create: `tests/core/coder-node.test.js`
- Create: `tests/core/contract-regression.test.js`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Step 1: Write the failing test**

在 `tests/core/coder-node.test.js` 写两个最小回归场景：

```javascript
const test = require("node:test");
const assert = require("node:assert/strict");

test("coder output with invalid TypeScript must not mark task completed", async () => {
  assert.equal(true, false);
});

test("state snapshot must match final task status after write+format flow", async () => {
  assert.equal(true, false);
});
```

在 `tests/core/contract-regression.test.js` 写一个契约漂移回归场景：

```javascript
const test = require("node:test");
const assert = require("node:assert/strict");

test("generated routes must stay inside api contract endpoints", async () => {
  assert.equal(true, false);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npx tsc --noEmit
node --test tests/core/coder-node.test.js tests/core/contract-regression.test.js
```

Expected:
- `npx tsc --noEmit` passes
- `node --test` fails because tests are placeholders

**Step 3: Add minimal test runner wiring**

更新 `package.json`，新增：

```json
{
  "scripts": {
    "test:core": "node --test tests/core/*.test.js"
  }
}
```

如 `tsconfig.json` 需要排除测试 JS，可显式保留：

```json
{
  "exclude": ["node_modules", "dist", "tests/**/*.js"]
}
```

**Step 4: Run test wiring**

Run:

```bash
npx tsc --noEmit
npm run test:core
```

Expected:
- TypeScript compile passes
- test runner executes and fails on assertions, not on tooling缺失

**Step 5: Commit**

```bash
git add package.json tsconfig.json tests/core/coder-node.test.js tests/core/contract-regression.test.js
git commit -m "test: bootstrap execution integrity regressions"
```

---

### Task 2: 收紧 Coder 完成判定，禁止坏文件过关

**Files:**
- Modify: `src/core/nodes/coder_node.ts`
- Modify: `src/core/phased_generation.ts`
- Modify: `src/skills/lsp_diagnose.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write the failing test**

给 `tests/core/coder-node.test.js` 增加一个真实断言：

```javascript
test("invalid code payload is recorded as failed instead of completed", async () => {
  const result = await runCoderFixture({
    fileTarget: "src/controllers/bookController.ts",
    responseCode: "{success, message, data}"
  });

  assert.equal(result.subTasks[0].status, "failed");
  assert.match(result.subTasks[0].lastError, /syntax|invalid|校验/i);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:core -- --test-name-pattern="invalid code payload"
```

Expected:
- Fails because current implementation can still mark malformed content as completed

**Step 3: Write minimal implementation**

在 `src/core/nodes/coder_node.ts` 增加一层统一的 `validateGeneratedFile()`：
- 对 `.ts/.js/.json` 做语法/结构校验
- 对明显占位内容、孤立对象片段、仅 schema 碎片做拦截
- 仅当 `extractResult`、工具执行、结构校验三者都成功时才标记 `completed`

在 `src/core/phased_generation.ts` 复用已有“非完整实现”判定逻辑，避免双份正则漂移。

必要时在 `src/skills/lsp_diagnose.ts` 增加对更明显语法坏文件的快速判定，避免只靠语言服务。

**Step 4: Run test to verify it passes**

Run:

```bash
npx tsc --noEmit
npm run test:core -- --test-name-pattern="invalid code payload"
```

Expected:
- compile passes
- target test passes

**Step 5: Commit**

```bash
git add src/core/nodes/coder_node.ts src/core/phased_generation.ts src/skills/lsp_diagnose.ts tests/core/coder-node.test.js
git commit -m "fix: block malformed generated files from completion"
```

---

### Task 3: 把单文件写入与状态持久化改成原子提交

**Files:**
- Modify: `src/core/nodes/coder_node.ts`
- Modify: `src/core/graph.ts`
- Modify: `src/utils/audit.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write the failing test**

在 `tests/core/coder-node.test.js` 增加状态一致性断言：

```javascript
test("snapshot and subTask status stay consistent after successful write", async () => {
  const result = await runCoderFixture({ fileTarget: "src/index.ts", responseCode: "export default 1;" });

  assert.equal(result.savedSnapshot.state.subTasks[0].status, "completed");
  assert.equal(result.savedSnapshot.state.code.includes("src/index.ts"), true);
});
```

再补一个异常回滚场景：

```javascript
test("failed formatter does not leave success state behind", async () => {
  const result = await runCoderFixture({ failAfterWrite: true });
  assert.equal(result.subTasks[0].status, "failed");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:core -- --test-name-pattern="snapshot and subTask status|failed formatter"
```

Expected:
- 至少一个场景失败，暴露“文件存在但状态错误”或“状态已成功但持久化未同步”

**Step 3: Write minimal implementation**

在 `src/core/nodes/coder_node.ts` 调整为单次事务式流程：
1. 先得到 `finalCode`
2. 做校验
3. 写文件到磁盘
4. 更新 `subTask`
5. 更新 `filesContent`
6. 组装单次 `incrementalResult`
7. 调用 `saveBoulder`

要求：
- 任一步失败都只落失败状态
- 不允许先记 success，后续再因为格式化或持久化失败而留下脏状态
- `codeLogEntries` 只记录最终状态，不累计旧轮中间态

如需要，在 `src/core/graph.ts` 的 `saveBoulder()` 周边补一层更清晰的错误分类日志。

**Step 4: Run test to verify it passes**

Run:

```bash
npx tsc --noEmit
npm run test:core -- --test-name-pattern="snapshot and subTask status|failed formatter"
```

Expected:
- compile passes
- both consistency tests pass

**Step 5: Commit**

```bash
git add src/core/nodes/coder_node.ts src/core/graph.ts src/utils/audit.ts tests/core/coder-node.test.js
git commit -m "fix: make coder file writes and state snapshots atomic"
```

---

### Task 4: 在 Coder 后增加契约回归校验，阻断路由漂移

**Files:**
- Modify: `src/core/nodes/contract_sync_node.ts`
- Modify: `src/core/nodes/verifier_node.ts`
- Modify: `src/core/logic_utils.ts`
- Test: `tests/core/contract-regression.test.js`

**Step 1: Write the failing test**

给 `tests/core/contract-regression.test.js` 加一个真实断言：

```javascript
test("route file that declares endpoints outside api contract is rejected", async () => {
  const result = await runContractVerifierFixture({
    contract: [{ path: "/api/users/permissions", method: "POST" }],
    fileContent: "router.post('/register', handler);"
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /contract|契约|未声明端点/i);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:core -- --test-name-pattern="outside api contract"
```

Expected:
- Fails because current validation只在前期做，未对生成文件做回归校验

**Step 3: Write minimal implementation**

在 `src/core/logic_utils.ts` 提供一个轻量函数：
- 从路由文件中提取 `router.get/post/put/delete(...)`
- 与 `state.apiContract` 比对
- 返回“额外端点”“缺失端点”“方法不匹配”

在 `src/core/nodes/verifier_node.ts` 增加：
- 对 `src/routes/**` 进行生成后契约校验
- 命中时将失败信息写入 `testResults`
- 路由到 `qa`，避免把契约漂移直接当作普通代码细节

如 `contract_sync_node.ts` 中已有静态规则可复用，抽公共方法，避免两套规则。

**Step 4: Run test to verify it passes**

Run:

```bash
npx tsc --noEmit
npm run test:core -- --test-name-pattern="outside api contract"
```

Expected:
- compile passes
- contract regression test passes

**Step 5: Commit**

```bash
git add src/core/nodes/contract_sync_node.ts src/core/nodes/verifier_node.ts src/core/logic_utils.ts tests/core/contract-regression.test.js
git commit -m "fix: enforce api contract after code generation"
```

---

### Task 5: 为 TypeScript 生成项目补齐最小 Jest 基线

**Files:**
- Modify: `src/core/nodes/architect_node.ts`
- Modify: `src/core/nodes/orchestrator_node.ts`
- Modify: `src/core/template_engine.ts`
- Modify: `src/core/logic_utils.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write the failing test**

在 `tests/core/coder-node.test.js` 加一个项目脚手架回归：

```javascript
test("typescript spec with jest testCommand auto-includes runnable jest baseline files", async () => {
  const result = await runArchitectOrchestratorFixture({
    language: "TypeScript",
    testCommand: "npm test"
  });

  assert.equal(result.filesToCreate.includes("jest.config.cjs"), true);
  assert.equal(result.packageJson.devDependencies["ts-jest"] !== undefined, true);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:core -- --test-name-pattern="jest baseline"
```

Expected:
- Fails because current generated TS projects can缺失最小 Jest 配置

**Step 3: Write minimal implementation**

在 `src/core/nodes/architect_node.ts` 中约定：
- TypeScript + `npm test` + Jest 系测试命令时，`filesToCreate` 应包含 `jest.config.cjs`
- 必要时包含 `tsconfig` 中的 `types: ["node", "jest"]` 或等效策略

在 `src/core/nodes/orchestrator_node.ts` 做安全注入：
- 若 JS/TS 项目缺少 `package.json` / `tsconfig.json` / `jest.config.cjs`，自动补任务

在 `src/core/template_engine.ts` 加最小模板。

**Step 4: Run test to verify it passes**

Run:

```bash
npx tsc --noEmit
npm run test:core -- --test-name-pattern="jest baseline"
```

Expected:
- compile passes
- baseline test passes

**Step 5: Commit**

```bash
git add src/core/nodes/architect_node.ts src/core/nodes/orchestrator_node.ts src/core/template_engine.ts src/core/logic_utils.ts tests/core/coder-node.test.js
git commit -m "feat: auto-scaffold jest baseline for generated ts projects"
```

---

### Task 6: 补齐运行纪要与失败可观测性

**Files:**
- Modify: `src/core/nodes/coder_node.ts`
- Modify: `src/core/nodes/qa_node.ts`
- Modify: `src/core/nodes/persistence_node.ts`
- Modify: `src/server.ts`
- Test: `tests/core/coder-node.test.js`

**Step 1: Write the failing test**

增加一个运行产物回归：

```javascript
test("run interrupted during coder still emits a structured meeting note or terminal failure summary", async () => {
  const result = await runInterruptedFlowFixture();
  assert.equal(result.hasCoderSummary, true);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:core -- --test-name-pattern="structured meeting note"
```

Expected:
- Fails because current中断 run 只有前半段 note，后续诊断不完整

**Step 3: Write minimal implementation**

要求：
- `coder_node.ts` 在整轮结束前无论成功失败都写 `note-coder-r{n}`
- `qa_node.ts` / `persistence_node.ts` 对“因环境/校验提前中止”的情况给出统一摘要
- `src/server.ts` 暴露当前 run 的节点完成度或最近失败节点，方便 Web 端以后承接“任务溯源图谱”

**Step 4: Run test to verify it passes**

Run:

```bash
npx tsc --noEmit
npm run test:core -- --test-name-pattern="structured meeting note"
```

Expected:
- compile passes
- interruption observability test passes

**Step 5: Commit**

```bash
git add src/core/nodes/coder_node.ts src/core/nodes/qa_node.ts src/core/nodes/persistence_node.ts src/server.ts tests/core/coder-node.test.js
git commit -m "feat: improve interrupted run diagnostics and notes"
```

---

### Task 7: 重新整理 `TODO.md`，把稳定性工作前置

**Files:**
- Modify: `TODO.md`
- Modify: `README.md`
- Modify: `docs/DESIGN.md`

**Step 1: Write the failing test**

这里不写自动化测试，改为文档一致性检查清单：

```text
1. TODO 中稳定性修复必须位于新功能之前
2. README 与 DESIGN 必须反映“先可信闭环，再扩展能力”
3. 未实现项必须按依赖关系排序，而不是按主题堆叠
```

**Step 2: Run check to verify mismatch exists**

Run:

```bash
rg -n "任务溯源图谱|分支回溯|多 workspace|graph 单元测试|前端" TODO.md README.md docs/DESIGN.md
```

Expected:
- 当前文档能看到大功能与基础稳定性工作混排

**Step 3: Write minimal implementation**

在 `TODO.md` 中重排为：
1. Phase A: 执行完整性与回归测试
2. Phase B: 状态追踪增强
3. Phase C: 可视化与回放
4. Phase D: 多 workspace 与并行能力
5. Phase E: 前端框架升级

要求把以下项前置到 Phase A/B：
- 核心 graph 单元测试
- 任务溯源图谱所需的节点/状态基础
- 分支回溯所需的状态快照完整性

**Step 4: Run check to verify docs are aligned**

Run:

```bash
npx tsc --noEmit
rg -n "Phase A|执行完整性|graph 单元测试|任务溯源图谱|分支回溯" TODO.md README.md docs/DESIGN.md
```

Expected:
- 文档中能看出清晰的依赖顺序

**Step 5: Commit**

```bash
git add TODO.md README.md docs/DESIGN.md
git commit -m "docs: reorder roadmap around execution integrity"
```

---

## Recommended Delivery Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6
7. Task 7

不要并行做 Task 2/3/4，因为它们都会改 `src/core/nodes/coder_node.ts` 或共享验证语义，先串行收敛。

---

## TODO Re-Prioritization

### Immediate Now

1. 核心 graph / node 回归测试
2. 执行完整性硬化
3. 状态快照一致性
4. 生成后契约校验

### Next After This Plan

1. 任务溯源图谱
2. 分支回溯
3. 容器资源配额配置化

### Later

1. 并行子任务
2. 多 workspace 会话管理
3. 现代前端框架支持
4. 前端组件测试
5. 前端 E2E

---

## Risks

1. `coder_node.ts` 已经较重，继续堆逻辑会恶化可维护性；实现时优先抽公共校验函数。
2. 若测试夹具直接依赖真实 LLM/工具，会导致回归测试不稳定；必须使用 fixture/stub。
3. 若先做“任务溯源图谱”而不先修状态一致性，图谱只会把脏数据可视化，收益很低。

## Acceptance Criteria

1. 生成非法 TS/JS/JSON 文件时，任务状态必须为 `failed`
2. `boulder.json` 与 `subTasks` / `code` 状态一致，不再出现“文件存在但任务 failed”或反过来的情况
3. 生成出的路由如果超出 `ApiContract`，会在 verifier/qa 前被识别
4. TypeScript + Jest 项目能自动生成最小可运行测试基线
5. 中途中断的 run 也能留下结构化失败纪要
6. `TODO.md` 的优先级顺序与执行依赖一致
## 2026-03-24 Addendum

- Fixed a false-negative coder path exposed by `workspace/run_1774313543413`.
- Root cause: an early `lint_fix` / `prettier` failure was kept as a sticky task failure even after `write_file` produced valid final code.
- Current rule: if the final extracted or persisted code is structurally valid and the file was successfully written, coder no longer fails the task only because of that earlier transient tool error.
- Regression coverage: `coder accepts valid final code after a transient pre-write lint failure`.
- Added interrupted-write recovery: coder now records a per-file recovery intent before snapshot persistence, and graph startup / `SIGINT` / `SIGTERM` replays those intents back into `boulder.json` and `trace-index.json`.
- Added fail-fast coder routing: once a file hits a blocking failure, coder stops the round immediately and hands off to QA instead of continuing to generate later files.
- Added focused QA handling for `[Coder 阻塞失败]`: QA now creates issues only for the actual blocked file(s) and skips speculative expansion to still-pending files.
- Added retryable model fallback in `BaseAgent`: when the current mode hits 429 / 5xx / network failures, the agent will automatically switch to another available mode before giving up.
- Added deterministic fallback in `fix_plan`: if quota/resource failures block both coder and QA model calls, the node now emits a minimal rule-based repair plan instead of crashing the run.
- Explicitly routed code-heavy calls to `coding` mode: `coder_node` generation, `qa_node` deep audit, and both LLM calls inside `fix_plan` now use the Coding Plan model chain.
- Added token accounting: each model call now persists usage into `token-usage.json`, and `trace-index.json` carries an aggregated `tokenUsage` summary by agent.
