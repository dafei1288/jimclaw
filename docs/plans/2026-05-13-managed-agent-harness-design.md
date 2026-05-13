# JimClaw Managed Agent Harness 设计

日期：2026-05-13

## 背景

JimClaw 当前的问题不是单个模型不够强，而是协作边界不够硬：

- PM 输出需求契约，但验收标准没有形成后续每轮执行的硬约束。
- Architect 输出 `TechSpec.filesToCreate`，过早把任务压成文件列表。
- Orchestrator 再按文件拆 `SubTask[]`，容易把错误拆分固化。
- Coder 按文件逐个生成，缺少“本轮用户可见目标”。
- QA 主要读 `testResults`，容易变成日志分析器，而不是主动验证者。
- `fix_plan` 已经引入 QA-Coder 协商，但它发生在失败之后，太晚。

用户反馈的现象是：“拆分任务不准，每个智能体各干各的，无法顺利完成任务。”  
这个反馈和现有结构高度一致：系统有多角色，但缺少强制共享的 sprint contract。

## 参考材料

本文综合参考：

1. Anthropic Engineering: `Harnesses for long-running coding agents`
   - https://www.anthropic.com/engineering/harness-design-long-running-apps
   - 关键启发：长任务不应只靠一次性计划。Planner 给高层 product spec，Generator 和 Evaluator 在每个 sprint 开始前协商 sprint contract；Evaluator 需要主动运行应用、点击 UI、检查结果，而不是只读日志。

2. Anthropic Engineering: `Managed agents`
   - https://www.anthropic.com/engineering/managed-agents
   - 关键启发：把 brain、hands、session 解耦。LLM harness 不应和执行环境、session state、sandbox 绑死；session 应成为可查询、可恢复的上下文对象。

3. gstack
   - https://github.com/garrytan/gstack
   - 关键启发：流程产品化。用固定阶段串联 specialist，而不是让多个角色自由聊天。典型流程是 Think -> Plan -> Build -> Review -> Test -> Ship -> Reflect。

本文不照搬任何一个实现。JimClaw 的目标仍是 LangGraph.js 多 agent 自主开发系统，但协作核心要从“文件级任务流”改为“可验证 sprint contract”。

## 问题定义

### 1. 文件级拆分过早

当前主线是：

```text
TaskContract -> TechSpec.filesToCreate -> SubTask[] -> Coder writes files -> Terminal/Verifier/QA
```

这会导致两个问题：

- `filesToCreate` 一旦不准，后续所有角色都围绕错误文件图自旋。
- 文件任务不等于用户价值。一个文件完成，不代表某个用户路径完成。

例如“图书管理系统”不应该先拆成 `BookService.ts`、`BookController.ts`、`BookList.vue`。更合理的第一轮 sprint 是：

```text
用户可以打开页面，看到图书列表，并通过 API 返回真实数据。
```

这个 sprint 可以跨前端、后端、测试、部署，但验收明确。

### 2. 角色之间没有共同执行契约

当前 PM、Architect、Coder、QA 共享 `state`，但没有一个对象明确规定：

- 本轮目标是什么
- 本轮必须完成哪些用户可见行为
- Coder 允许改哪些范围
- Evaluator 必须执行哪些检查
- 什么证据可以放行
- 失败时谁负责修

`fix_plan` 只在失败后协商修复方向。它改善了盲修，但不能防止第一轮就各干各的。

### 3. QA 是被动日志审计，不是主动 Evaluator

QA 目前主要输入是：

- `testResults`
- `deploymentStatus`
- `issueTracker`

这会漏掉：

- 前端页面可访问但交互不可用
- API 200 但数据不符合业务期望
- 后端健康检查成功但根路径 404
- 测试覆盖了脚手架烟雾行为但没有覆盖用户验收

质量守门应输出 evidence，而不是只输出判断。

### 4. session 事实源不够清晰

JimClaw 已有 `boulder.json`、`audit/`、`meetingNotes`、`trace-index.json`。问题是这些对象职责重叠：

- `boulder.json` 是快照，但也承担事实源。
- `audit/` 是文本证据，但难以路由。
- `meetingNotes` 是给 agent 的摘要，但不是强类型事件。
- `trace-index.json` 有索引能力，但还不是统一 session API。

Managed agents 的核心启发是：session 应成为明确的上下文层，agent 通过查询 session 获取需要的信息。

## 设计目标

1. 把任务拆分从文件维度改为用户可验证的 vertical slice。
2. 在每个 sprint 开始前强制 Builder 和 Evaluator 达成 `SprintContract`。
3. 让 Evaluator 主动运行 API/UI/部署检查，并输出结构化证据。
4. 让 Architect 负责边界和约束，不再过早规定全部文件。
5. 保留 JimClaw 当前 LangGraph 主体，渐进迁移，不大爆炸重写。
6. 让 session 事件逐步成为事实源，`boulder.json` 退回快照定位。

## 非目标

1. 不在第一阶段重写全部 scaffold。
2. 不立即引入远程 managed agent 服务。
3. 不删除现有 PM/Architect/Coder/QA persona。
4. 不一次性废弃 `SubTask[]`，第一阶段允许兼容。
5. 不把 Playwright 变成所有任务必需；仅当前端或浏览器验收存在时启用。

## 总体架构

目标流程：

```text
intake
  -> product_planner
  -> architect
  -> plan_review
  -> sprint_planner
  -> sprint_contract
  -> builder
  -> self_check
  -> evaluator
       | pass + more sprint -> sprint_contract
       | fail               -> repair_contract -> builder
       | all pass           -> release_gate
  -> persistence
  -> retro
```

对应现有节点迁移：

| 当前节点 | 新职责 |
| --- | --- |
| `pm` | 输出 `ProductSpec` / `RequirementProtocol`，强调用户目标和验收，不规定实现细节 |
| `architect` | 输出 `ArchitectureBrief` / `SystemBoundary` / `ApiContract` / 风险矩阵，不以 `filesToCreate` 为主 |
| `orchestrator` | 改为 `sprint_planner`，输出 `SprintPlan[]` |
| `fix_plan` | 拆成 `sprint_contract` 和 `repair_contract`；前者实现前协商，后者失败后修复 |
| `coder` | 改为 `builder`，围绕当前 `SprintContract` 实现 |
| `terminal` | 保留为命令执行节点，提供 self-check 结果 |
| `qa` | 降级为 issue classifier / triage |
| 新增 `evaluator` | 主动验证 sprint acceptance，输出 evidence |
| 新增 `release_gate` | 全局验收，不允许只因测试通过就完成 |

## 核心对象

### ProductSpec

`TaskContract` 仍保留，但新增更强的 ProductSpec：

```ts
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
    verificationKind: "api" | "ui" | "unit" | "build" | "deploy" | "manual";
  }>;
  nonGoals: string[];
}
```

### ArchitectureBrief

替代把 `TechSpec.filesToCreate` 作为主线：

```ts
export interface ArchitectureBrief {
  version: "v1";
  stack: {
    language: string;
    framework: string;
    frontend?: string;
    database?: string;
  };
  systemBoundaries: string[];
  apiContracts: ApiContract["endpoints"];
  runtime: {
    testCommand: string;
    runCommand: string;
    healthCheckPath: string;
  };
  constraints: string[];
  risks: Array<{
    id: string;
    description: string;
    mitigation: string;
  }>;
  suggestedFiles?: string[];
}
```

`suggestedFiles` 可以存在，但它不是下游唯一真相源。

### SprintPlan

```ts
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
```

关键要求：

- 一个 sprint 必须形成用户可验证行为。
- 一个 sprint 不应只是“创建某文件”。
- 每个 sprint 必须绑定 ProductSpec 的验收标准。

### SprintContract

```ts
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
```

`SprintContract` 是 Builder 和 Evaluator 的共同执行契约。Coder 不再只看 `Issue` 或 `SubTask`，而是按这个 contract 执行。

### EvaluationCheck

```ts
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
```

### EvaluationResult

```ts
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

Evaluator 的输出必须包含 evidence。没有 evidence 的 pass 不可放行。

### SessionEvent

第一阶段不替换 `boulder.json`，但新增 append-only 事件：

```ts
export interface SessionEvent {
  id: string;
  runId: string;
  phase: string;
  actor: string;
  artifactType:
    | "product_spec"
    | "architecture_brief"
    | "plan_review"
    | "sprint_plan"
    | "sprint_contract"
    | "code_change"
    | "self_check"
    | "evaluation_result"
    | "repair_contract"
    | "release_decision";
  artifactPath?: string;
  summary: string;
  createdAt: string;
}
```

文件位置：

```text
workspace/run_xxx/session/events.jsonl
workspace/run_xxx/session/artifacts/*.json
```

## 节点设计

### `plan_review_node`

输入：

- `ProductSpec`
- `ArchitectureBrief`
- `RequirementProtocol`
- `ApiContract`

输出：

- `PlanReview`
- `ValidationReport`

职责：

1. 判断需求是否被覆盖。
2. 判断方案是否过大或过小。
3. 判断验收是否可验证。
4. 标记需要澄清或强制收敛的范围。

第一阶段可用确定性规则实现，不依赖 LLM：

- `frontendRequired=true` 但没有 UI sprint -> fail。
- 有 API acceptance 但没有 API contract -> fail。
- `acceptanceCriteria` 没有任何 `verificationKind` -> fail。
- sprint 数量为 0 -> fail。

### `sprint_planner_node`

输入：

- `ProductSpec`
- `ArchitectureBrief`
- `ApiContract`
- `ExecutionProtocol`

输出：

- `SprintPlan[]`
- 当前 `activeSprintId`

拆分原则：

1. 优先按用户路径拆。
2. 每个 sprint 绑定 acceptance criteria。
3. 第一个 sprint 必须产生可运行骨架。
4. 前后端混合任务必须按纵向切片拆，而不是前端一批、后端一批。

示例：

```text
Sprint 1: 应用能启动，健康检查和首页可访问
Sprint 2: 图书列表 API + 页面展示真实列表
Sprint 3: 新增/编辑/删除图书闭环
Sprint 4: 部署验收和回归清单
```

### `sprint_contract_node`

输入：

- 当前 `SprintPlan`
- 当前代码状态
- 上一轮 `EvaluationResult`
- `ArchitectureBrief`

过程：

1. Builder 提出实现计划。
2. Evaluator 审查验收计划。
3. 如果 Evaluator 认为不可验证，退回 sprint planner 或 plan review。
4. 双方达成 `SprintContract.status="agreed"` 后才进入 builder。

第一阶段可复用 `fix_plan_node` 的双模型协商模式，但 prompt 改为“实现前协商”。

### `builder_node`

兼容现有 `coder_node`，但行为变化：

- 读取 `activeSprintContract`。
- 只修改 `agreedScope.allowedFiles`。
- 每次输出 `codeLog` 时记录关联 `sprintId`。
- 如果必须新增超 scope 文件，写入 `scopeChangeRequest`，不直接扩散。

第一阶段可以不重写全部 coder，只在 prompt 和任务筛选层加 contract 约束。

### `self_check_node`

输入：

- `SprintContract.builderPlan.selfChecks`

输出：

- `SelfCheckResult`

职责：

- 跑最小命令检查。
- 比如 `npm test`、`npx tsc --noEmit`、`pytest -v`。
- 不负责最终放行。

可先复用现有 `terminal_node`。

### `evaluator_node`

输入：

- `SprintContract.evaluatorPlan.checks`
- `deploymentStatus`
- `apiContract`

输出：

- `EvaluationResult`
- `Issue[]`
- `ValidationReport`

执行方式：

- `command` check -> 通过 `CommandExecutor` 或现有 terminal 执行。
- `http` check -> 用 `host.httpGet()`。
- `playwright` check -> 通过现有 `playwright_exec` 技能或 Browser 插件。
- `file` check -> 读取目标文件，检查关键内容。

放行规则：

- `passThreshold="all"` 时所有非 skipped check 必须通过。
- 有任何 critical check fail，进入 `repair_contract`。
- 没有 evidence 的 check 不能算 pass。

### `repair_contract_node`

失败后替代现有 `fix_plan`：

输入：

- `EvaluationResult`
- `Issue[]`
- 当前 `SprintContract`

输出：

- `RepairContract`

它与当前 `fix_plan` 类似，但更聚焦：

- 修复只针对当前 sprint。
- 修复必须复用 failed check 的 evidence。
- 修复成功后回到 evaluator，不直接进入下一个 sprint。

### `release_gate_node`

全局放行节点。

输入：

- 全部 `SprintPlan[]`
- 全部 `EvaluationResult[]`
- `ProductSpec.acceptanceCriteria`
- `deploymentStatus`

硬规则：

1. 每个 `must` user story 至少被一个 pass sprint 覆盖。
2. 每个 acceptance criterion 至少有一个 pass evidence。
3. 若有前端，根路径必须返回 HTML。
4. 若有 API contract，公开 GET 端点必须被实际访问。
5. `audit/Infrastructure.md`、`audit/Terminal.md` 不得有未解释的 critical failure。

## 路由设计

第一阶段图路由建议：

```text
pm
  -> architect
  -> plan_review
  -> sprint_planner
  -> sprint_contract
  -> coder
  -> infra_setup
  -> terminal
  -> verifier
  -> evaluator
  -> qa
```

`evaluator` 后：

```text
if evaluation pass and more sprints:
  -> sprint_contract
if evaluation fail:
  -> repair_contract -> coder
if all sprints pass:
  -> deploy -> release_gate -> post_mortem -> persistence
```

为了降低改动风险，也可以先采用兼容路由：

```text
orchestrator 输出 subTasks + sprintPlans
coder 继续处理 subTasks
evaluator 按 sprintContract 验证
```

也就是说，第一阶段允许 `SubTask[]` 继续存在，但放行权从 `qa.isDone` 转移到 `EvaluationResult` 和 `release_gate`。

## 状态迁移策略

新增字段：

```ts
productSpec?: ProductSpec;
architectureBrief?: ArchitectureBrief;
planReview?: PlanReview;
sprintPlans?: SprintPlan[];
activeSprintId?: string;
sprintContracts?: SprintContract[];
evaluationResults?: EvaluationResult[];
repairContracts?: RepairContract[];
sessionEvents?: SessionEvent[];
```

保留字段：

- `contract`
- `spec`
- `subTasks`
- `fixPlan`
- `issueTracker`
- `validationReport`
- `repairPlan`

兼容规则：

1. `TaskContract` 可转换为 `ProductSpec`。
2. `TechSpec` 可转换为 `ArchitectureBrief`。
3. `SubTask[]` 可从 `SprintContract.builderPlan.filesLikelyTouched` 派生。
4. `fixPlan` 可逐步替换为 `repairContract`。

## 失败分类变化

当前 `ValidationFailureType` 保留：

- `planning_gap`
- `implementation_bug`
- `environment_gap`
- `runtime_gap`

新增 evaluator 语义：

| Evaluator 失败 | 映射 |
| --- | --- |
| sprint contract 不可验证 | `planning_gap` |
| API/UI 行为不符合验收 | `implementation_bug` |
| 启动、端口、依赖、执行器失败 | `environment_gap` 或 `runtime_gap` |
| 部署后用户路径不通 | `runtime_gap` |

## 与现有经验系统的关系

`FAILURE_PATTERNS.md` 和 `fp_regression_check.ts` 不应只在 persistence 后观察。它们应成为 evaluator/release_gate 的输入：

- FP-008：混合项目前端不可达 -> release gate fail。
- FP-015：用户体验未验证 -> release gate fail。
- FP-007：build 失败继续 deploy -> infra/evaluator fail。

经验系统从“事后趋势”升级为“验收检查库”。

## 成功标准

第一阶段成功标准：

1. Orchestrator 能输出至少一个 `SprintPlan`，并绑定验收标准。
2. Coder 在实现前能看到 `SprintContract`，且 prompt 明确限制 scope。
3. Evaluator 能输出结构化 `EvaluationResult`，包含 HTTP 或命令 evidence。
4. QA 不再是唯一放行者；release gate 必须检查 evaluation evidence。
5. “图书管理系统”不再按文件自由扩散，而是按启动、列表、新增编辑删除、部署验收逐步推进。

第二阶段成功标准：

1. Playwright 检查覆盖前端核心路径。
2. session events 成为 dashboard 和 resume 的主要索引。
3. `fix_plan` 完全替换为 `repair_contract`。
4. `SubTask[]` 退化为 builder 内部执行细节。

## 风险与应对

### 风险 1：改动图路由导致现有测试大面积失效

应对：

- 第一阶段只新增字段和节点，不删除旧节点。
- 先让 `orchestrator` 同时输出 `subTasks` 和 `sprintPlans`。
- 用 feature flag 控制新 harness。

### 风险 2：Evaluator 成本高

应对：

- 第一版只做 command/http/file checks。
- Playwright 只在 `ProductSpec` 存在 UI 验收时启用。

### 风险 3：SprintContract 又变成空文档

应对：

- `sprint_contract_node` 必须校验：
  - 至少一个 check。
  - 至少一个 required evidence。
  - allowed scope 不为空。
  - 每个 sprint 必须绑定 acceptance criterion。

### 风险 4：Builder 被 scope 限死，无法补必要文件

应对：

- 允许 `scopeChangeRequest`。
- scope change 必须回到 `sprint_contract` 审查，不允许静默扩散。

## 结论

JimClaw 下一阶段应从“多角色流水线”改成“managed agent harness”：

- PM/Architect 给方向和边界。
- SprintPlanner 按用户价值拆 vertical slice。
- Builder/Evaluator 在每轮开始前达成 contract。
- Evaluator 主动验证并提供 evidence。
- ReleaseGate 基于 evidence 放行。

这会直接解决当前最核心的问题：任务拆分不准、智能体各干各的、最后无法闭环。
