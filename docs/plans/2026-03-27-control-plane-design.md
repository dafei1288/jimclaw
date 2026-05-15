# JimClaw 控制平面设计

日期：2026-03-27

## 目标

当前系统的主要问题不是“模型不会写代码”，而是缺少真正的控制平面：

- 用户需求会在 `architect/orchestrator` 被收缩或漏掉
- 协议失败能被看见，但不能强制重规划
- `fix_plan` 会被错误地拿来修“规划缺失”
- 节点之间缺少统一输入/输出契约，导致谁都能继续跑，谁都拦不住

本设计的目标是把现有系统从“观测协议”升级为“控制协议”，做到：

1. 用户需求成为第一事实源
2. 技术栈选择被正式冻结
3. 方案、任务图、验证结果都有明确机器对象
4. 每个节点只有明确输入、明确输出、明确否决权
5. 规划错误、实现错误、环境错误、运行错误必须走不同回路
6. 一旦发现需求覆盖缺失，必须强制重规划，不能继续空转
7. 简单单体 CRUD 项目必须在架构阶段被压回可执行预算，不能把 20 分钟任务扩成 60+ 文件长链

## 设计原则

### 1. 单一事实源

每类信息只允许存在一个机器事实源。展示文本、会议纪要、LLM prompt 都只能从机器对象投影出来，不能反向成为唯一依据。

### 2. 用户优先

用户明确指定的需求和技术栈优先级高于 Architect 的自由发挥。

### 3. 节点有否决权

发现本层问题的节点必须能真正阻断后续错误路径，而不是只写一条 note。

### 4. 失败分类先于修复

先判断失败属于哪一类，再决定回哪条修复链。禁止把所有问题都扔给 `fix_plan/coder`。

### 5. 补丁必须生效

`ProtocolPatch`、`SolutionPatch`、`ExecutionPatch` 不能只记录在 state 里，必须真正改变下一轮的 `SolutionPlan` 或 `ExecutionPlan`。

### 6. 预算先于执行

控制平面不仅要判断“缺不缺文件”，还要判断“任务图是不是已经失控”。

如果是简单单体 CRUD 项目，却被扩成双套前端目录、双套测试框架、同义文件并存的大任务图，那么问题属于 `planning_gap`，必须在 Architect / Orchestrator 阶段被压缩，而不是把 60+ 个文件原样交给 Coder 首轮串行产出。

## 2026-03-31 现状补充

到 2026-03-31 为止，这份设计里已有三类机制被实际代码验证：

1. 恢复入口不再固定回到 `pm`
   - 当前 workspace 恢复时，会根据真实快照节点决定恢复入口
   - `coder_task_*` 这类动态节点恢复到 `coder`
   - `qa` 快照恢复时保留 `testResults/qaFailures/blockedReason`，继续走 `qa_resume_router`

2. 简单 CRUD 场景的确定性骨架继续扩大，但仍保持模板级泛化
   - `package.json` 在 architect 给空依赖时，会按需求兜底补运行时依赖
   - `tests/health.test.ts`、`tests/auth.test.ts`、`tests/books.test.ts`、`scripts/verify.ts` 已进入更强的确定性脚手架范围
   - 目标不是写死“图书管理系统”，而是把高频漂移文件压回模板层

3. `coder -> infra_setup` 之间新增环境收口
   - 代码文件全部完成后，不再直接进 `infra_setup`
   - 必须先过一次 `EnvGuard`，避免出现“文件都写完了但 package 依赖仍为空”的伪完成态

当前仍未闭合的一类关键机制：

- QA/FixPlan 发现“文件状态已 completed，但内容其实错误”时，系统还缺少强制重开机制
- 典型表现：
  - `package.json` 已写出，但依赖为空
  - `tests/health.test.ts` 已写出，但导入路径错误
  - `tests/auth.test.ts` / `tests/books.test.ts` 已写出，但仍是错误的 class-style baseline
- QA 能识别这些问题，但不会把对应文件重新排回 `coder`
- 因此旧 run 会停在 `qa`，而不是真正进入“错误文件重写”回路

## 2026-04-02 增补：长耗时节点心跳与恢复快照

在真实 run 中出现过“实际仍在推进，但 `boulder.json` 长时间停在旧节点”的可观测性断层。  
本次把它定义为控制平面的基础能力，而不是 UI 层问题。

新增约束：

1. `infra_setup` / `terminal` / `deploy` 的长耗时阶段必须定时写入心跳快照。
2. 心跳快照必须包含“当前子阶段”（如 install/build/run_tests/healthcheck）与运行时关键信息（backend/containerId/hostPort）。
3. 外层会话超时或被切断后，恢复入口必须基于最近心跳节点而非旧节点推断。
4. 慢进度超时与无进度超时必须显式区分，避免把“仍在推进”误判为死循环。

设计目标：

- 不再出现“实际在执行但看起来卡住”的假死态；
- `--watch/--resume` 能看到真实阶段并可继续推进；
- QA/fix_plan 拿到的失败证据更准确，减少无效协商轮次。

## 2026-04-02 增补：QA 非阻塞兜底与快速修复链

真实回放暴露的核心痛点不是“没有错误证据”，而是“有证据但仍等待模型超时”。  
本次补充两条控制平面约束，目标是减少 `qa -> fix_plan` 的等待与自旋。

新增约束：

1. QA 模型不可用（超时/额度/服务异常）时，必须降级为静态归因，不得把会话挂到 `agent_pending`。
2. 当日志已出现明确编译错误（如 `file(line,col): error TSxxxx`）时，QA 必须跳过深度 LLM 分析，直接产出 `BUG-COMPILE-*`。
3. 当 open issues 已标记为静态兜底工单（`BUG-COMPILE-* / BUG-QA-FALLBACK-* / BUG-AUTO-*` 等）时，`fix_plan` 必须直接生成确定性计划，跳过 coder/qa 双模型协商。
4. 失败文件路径必须先归一化（去掉重复 `workspace/run_xxx/...` 前缀）再进入文件读取与修复计划，避免工具层路径误判引发假超时。
5. 运行层必须可量化：每个 run 至少输出 `agent_pending` 次数、QA 超时次数、静态兜底命中次数与最终状态。

设计目标：

- 让“模型抖动”从阻塞故障降级为可恢复噪声；
- 把 `qa/fix_plan` 的最慢路径从“等待超时”变为“直接静态收敛”；
- 用 run 级指标验证改动是否真的减少自旋，而不是只看单测通过。

## 控制平面对象

完整控制平面由 7 个对象组成。

### 1. RequirementContract

定义：用户要什么。

职责：
- 提取需求能力位
- 固定业务实体
- 固定验收项

建议结构：

```ts
type RequirementContract = {
  version: "v1";
  userIntent: {
    title: string;
    rawPrompt: string;
    requirements: string[];
    acceptanceCriteria: string[];
  };
  capabilities: {
    frontendRequired: boolean;
    backendRequired: boolean;
    authRequired: boolean;
    auditRequired: boolean;
    deployRequired: boolean;
    testRequired: boolean;
    docsRequired: boolean;
    healthCheckRequired: boolean;
    entities: string[];
    uiCapabilities: string[];
    apiCapabilities: string[];
  };
};
```

### 2. TechnologyDecision

定义：前后端、数据库、测试、部署到底用什么栈。

职责：
- 冻结技术路线
- 约束模板选择
- 限制后续生成范围

建议结构：

```ts
type TechnologyDecision = {
  version: "v1";
  source: "user" | "architect";
  frontend: {
    required: boolean;
    framework: "vanilla" | "react" | "vue" | "none";
    buildTool: "vite" | "none";
    entryFiles: string[];
  };
  backend: {
    required: boolean;
    framework: "express-typescript" | "fastapi-python" | "gin-go";
    entryFiles: string[];
  };
  database: {
    kind: "postgres" | "sqlite" | "memory" | "none";
  };
  testing: {
    unit: string;
    api?: string;
    e2e?: string;
  };
  deploy: {
    docker: boolean;
    compose: boolean;
  };
};
```

### 3. SolutionPlan

定义：如何用指定技术栈满足 RequirementContract。

职责：
- 给出页面/API/模块分层
- 建立需求覆盖矩阵
- 定义核心实现轮廓

建议结构：

```ts
type SolutionPlan = {
  version: "v1";
  summary: string;
  ui: {
    screens: Array<{ id: string; purpose: string; routes: string[] }>;
  };
  api: {
    endpoints: Array<{ method: string; path: string; purpose: string }>;
  };
  modules: {
    routes: string[];
    controllers: string[];
    services: string[];
    models: string[];
    middleware: string[];
  };
  coverageMatrix: Array<{
    requirement: string;
    coveredBy: string[];
  }>;
};
```

### 4. ExecutionPlan

定义：要生成哪些文件、每个文件的角色、依赖和验收钩子。

职责：
- 驱动 Coder
- 驱动 Verifier
- 作为唯一任务图
- 负责文件路径归一化、模板别名去重、测试框架冲突清理
- 负责复杂度预算与任务图压缩

建议结构：

```ts
type ExecutionPlan = {
  version: "v1";
  files: Array<{
    path: string;
    role: "entry" | "route" | "controller" | "service" | "model" | "middleware" | "test" | "config" | "infra" | "ui";
    required: boolean;
    satisfiesRequirements: string[];
    dependsOnFiles: string[];
  }>;
  tasks: Array<{
    id: string;
    fileTarget: string;
    role: string;
    dependsOnTaskIds: string[];
    verificationHooks: string[];
  }>;
  acceptanceChecks: string[];
};
```

### ExecutionPlan 预算与归一化规则

`ExecutionPlan` 在进入 Coder 前必须额外满足三条规则：

1. 别名文件必须被折叠成一个规范目标，例如：
   - `src/public/*` -> `public/*`
   - `src/routes/book-routes.ts` -> `src/routes/books.ts`
   - `src/controllers/book-controller.ts` -> `src/controllers/bookController.ts`
   - `src/services/book-service.ts` -> `src/services/bookService.ts`
2. 测试基线只能保留一种：
   - 已选择 `vitest` 时，禁止再混入 `jest.config.* / tests/setup.test.ts`
   - 已选择 `jest` 时，禁止再混入 `vitest.config.*`
3. 对“单体 + 前后端 + 1~2 个主业务实体”的简单 CRUD 项目，文件预算必须受限。
   - 参考预算：24 个文件左右
   - 超预算时，Orchestrator 必须压缩为最小可执行骨架，而不是把所有模板碎片都下发

### 5. ValidationReport

定义：本轮验证的机器结论。

职责：
- 提供唯一失败分类
- 决定下一跳

建议结构：

```ts
type FailureType =
  | "planning_gap"
  | "implementation_bug"
  | "environment_gap"
  | "runtime_gap";

type ValidationReport = {
  version: "v1";
  status: "pass" | "fail";
  failureType?: FailureType;
  blocking: boolean;
  findings: Array<{
    type: FailureType;
    summary: string;
    file?: string;
    evidence: string[];
  }>;
};
```

### 6. RuntimeState

定义：运行时环境和部署态。

职责：
- 记录依赖、容器、端口、部署、token
- 供 env/infra/deploy 使用

建议结构：

```ts
type RuntimeState = {
  version: "v1";
  envReady: boolean;
  hostDepsReady: boolean;
  testRuntimeReady: boolean;
  deployRuntimeReady: boolean;
  containerId?: string;
  hostPort?: number;
  containerPort?: number;
  deploymentUrl?: string;
  startupLogPath?: string;
  tokenUsage?: object;
};
```

### 7. RepairPlan

定义：当前轮允许修什么，按什么方式修。

职责：
- 限定修复目标
- 限定允许改动范围
- 阻止错误问题流入错误节点

建议结构：

```ts
type RepairPlan = {
  version: "v1";
  repairType: "planning" | "implementation" | "environment" | "runtime";
  targets: string[];
  allowedEdits: string[];
  expectedEvidence: string[];
};
```

### 8. CustomerApprovalState

定义：客户确认与默认授权状态。

职责：
- 记录哪些阶段需要客户确认或客户授权
- 记录客户是否给了“默认同意”授权
- 决定流程在关键节点是自动通过、暂停等待，还是驳回回退

建议结构：

```ts
type CustomerApprovalState = {
  version: "v1";
  autoApprove: {
    requirements: boolean;
    solution: boolean;
    deploy: boolean;
  };
  checkpoints: Array<{
    stage: "requirements" | "solution" | "deploy";
    required: boolean;
    approved: boolean;
    approvedBy?: "customer" | "default-authorization";
    summary: string;
    timestamp?: string;
  }>;
};
```

## 节点控制协议

### PM

输入：
- 用户原始请求

输出：
- `RequirementContract`
- `CustomerApprovalState.checkpoints(requirements)`

硬闸门：
- 用户说“前后端”时，必须同时设置 `frontendRequired=true`、`backendRequired=true`
- 不能把用户需求缩成技术实现
- 需求 checkpoint 只能处于“默认授权自动通过”或“待客户确认”两种初始状态

失败分流：
- PM 自己失败则终止

### Architect

输入：
- `RequirementContract`
- 用户明确指定的技术栈约束（如果有）
- `CustomerApprovalState`

输出：
- `TechnologyDecision`
- `SolutionPlan`
- `CustomerApprovalState.checkpoints(solution)`

硬闸门：
- `coverageMatrix` 不能为空
- 任一 requirement 没被覆盖，直接失败
- 不能继续到 Orchestrator
- `solution` checkpoint 未授权且未确认时，必须进入 approval 控制层

失败分流：
- 回 Architect 重做

### Orchestrator

输入：
- `RequirementContract`
- `TechnologyDecision`
- `SolutionPlan`
- `CustomerApprovalState`

输出：
- `ExecutionPlan`

硬闸门：
- `backendRequired=true` 时，必须规划 route/controller/service/model
- `frontendRequired=true` 时，必须规划 ui/entry
- `testRequired=true` 时，必须规划对应测试文件
- `deployRequired=true` 时，必须规划部署文件
- 若出现同义文件、双测试框架、双前端目录或简单 CRUD 超预算，必须先做归一化与压缩，再产出 `ExecutionPlan`

失败分流：
- 回 Orchestrator 重建任务图

### Env Guard / Infra Prep

输入：
- `TechnologyDecision`
- `ExecutionPlan`

输出：
- `RuntimeState`

硬闸门：
- 测试环境必须具备测试命令所需依赖
- 部署环境必须具备 run/build 所需依赖

失败分流：
- `environment_gap`

### Coder

输入：
- `ExecutionPlan`
- `RepairPlan`（如果有）
- 当前 task

输出：
- 文件产物
- task 状态更新

硬闸门：
- 只能改当前 task 允许的文件
- 只能引用 ExecutionPlan 允许的依赖
- 不能修规划问题

失败分流：
- `implementation_bug`

### Verifier

输入：
- `RequirementContract`
- `TechnologyDecision`
- `SolutionPlan`
- `ExecutionPlan`
- 当前文件产物
- 当前测试结果

输出：
- `ValidationReport`

硬闸门：
- 发现 route/controller/service/model 缺失，直接判定 `planning_gap`
- 发现测试没覆盖规划文件，判定 `planning_gap`
- 发现环境缺依赖，判定 `environment_gap`
- 发现实现错误，判定 `implementation_bug`

失败分流：
- `planning_gap` -> Architect/Orchestrator
- `implementation_bug` -> FixPlan
- `environment_gap` -> EnvGuard/Infra
- `runtime_gap` -> Infra/Deploy 运行时修复回路

### QA

输入：
- `ValidationReport`
- `RequirementContract`
- `ExecutionPlan`

输出：
- `RepairPlan`
- 或 `done=true`

硬闸门：
- `planning_gap` 禁止通过
- `environment_gap` 禁止甩给 coder
- 环境问题必须统一转交 `EnvGuard`，禁止在 QA 节点内直接做临时 shell 修补
- `runtime_gap` 禁止转实现修复
- 只要仍有 `pending subTask`，即使当前没有失败证据，也禁止 `done=true`
- 当阶段验证通过但任务图仍未完成时，QA 只能设置“恢复 coder 继续实现”，不能放行 deploy

失败分流：
- 必须按 `ValidationReport.failureType`

### FixPlan

输入：
- `ValidationReport`
- 最小相关文件
- 最小关键日志

输出：
- `RepairPlan`

硬闸门：
- 只处理 `implementation_bug`
- `planning_gap` 直接拒收，打回 Architect/Orchestrator

### Architect Mediation

输入：
- `RequirementContract`
- `TechnologyDecision`
- `SolutionPlan`
- `ExecutionPlan`
- `ValidationReport`

输出：
- `SolutionPatch[]`
- `ExecutionPatch[]`

硬闸门：
- 补丁必须应用
- 影响规划时必须触发重编译

### Deploy

输入：
- `ExecutionPlan`
- `RuntimeState`
- `ValidationReport.status=pass`
- `CustomerApprovalState`

输出：
- `RuntimeState.deployment`
- `CustomerApprovalState.checkpoints(deploy)`

硬闸门：
- 任意 blocking failure 存在时禁止 deploy
- `deploy` checkpoint 未授权且未确认时，禁止部署
- 启动命令必须显式注入运行时端口与宿主监听配置，例如 `PORT=<manifest.port>` 与 `HOST=0.0.0.0`
- 健康检查不能只探测单一路径；主路径失败时，允许按候选路径回退探测
- Deploy 失败时必须产出结构化 `runtime_gap` 证据，并回灌到运行时修复链，而不是直接结束流程

### Agent Runtime

输入：
- 任意智能体节点的模型调用错误

输出：
- `agent_pending`
- `resumeFromNode`

硬闸门：
- 模型连接失败、请求超时、上游 aborted 不能直接把 run 打崩
- 必须落盘为可恢复挂起态，并保留原节点作为恢复入口
- 恢复后必须从原业务节点继续，而不是从头重跑整个图

## 错误分类和分流

系统只允许 4 类失败：

1. `planning_gap`
   - 缺 route、缺页面、缺测试、缺 coverage
   - 去 Architect / Orchestrator

2. `implementation_bug`
   - 文件语法、导出、逻辑错误
   - 去 FixPlan / Coder

3. `environment_gap`
   - 缺依赖、测试环境不完整、Docker 不可用
   - 去 Env Guard / Infra

4. `runtime_gap`
   - 入口、端口、健康检查、启动失败
   - 典型证据包括：`EADDRNOTAVAIL`、`EADDRINUSE`、端口错配、容器内已监听但宿主不可达、健康检查路径错配
   - 去 Infra / Deploy 运行时修复

禁止出现：
- `planning_gap` 进入 `fix_plan`
- `environment_gap` 进入 `coder`
- `runtime_gap` 被伪装成 `implementation_bug`

## 客户确认控制层

客户确认是正式控制层，不是可选提示。

系统默认支持两种确认模式：

1. 显式确认
   - 到达关键阶段时发出授权请求，并把状态持久化为待确认
   - 当前 run 可挂起，后续在收到确认后恢复，不允许在节点内同步长时间阻塞

2. 默认同意授权
   - 客户可预先授权某些阶段自动通过
   - 系统在对应 checkpoint 自动记录为 `approvedBy=default-authorization`
   - 不再每次都打断客户

系统必须严格区分 3 种结果：

1. 默认授权通过
   - `autoApprove.<stage>=true`
   - 不阻塞流程
   - 自动记录 `approved=true` 与 `approvedBy=default-authorization`

2. 人工确认通过
   - `autoApprove.<stage>=false`
   - 进入 approval 控制层并挂起待确认
   - 客户明确确认后，记录 `approved=true` 与 `approvedBy=customer`

3. 人工驳回
   - 客户明确拒绝当前 checkpoint
   - 当前 checkpoint 不得伪装成已批准
   - 流程必须回到对应节点重做，而不是继续向后执行

建议只保留 3 个高价值确认点：

1. `requirements`
   - 确认需求理解是否正确
   - 是否接受 RequirementContract

2. `solution`
   - 确认技术栈、交付范围、页面/API/部署方案
   - 是否接受 TechnologyDecision + SolutionPlan

3. `deploy`
   - 确认验收通过后是否允许部署
   - 是否保留容器和访问地址

默认授权规则：

- `autoApprove.requirements=true`
  - PM 产出的需求契约自动通过
- `autoApprove.solution=true`
  - Architect 产出的技术方案自动通过
- `autoApprove.deploy=true`
  - QA/Verifier 通过后自动部署

控制要求：

- 未确认且未授权默认通过时，流程必须进入待确认态，并允许后续恢复
- 已明确驳回时，必须回到对应节点重做
- 确认记录必须写入 `CustomerApprovalState`
- 后续节点只能读取已确认版本，不允许继续漂移
- approval 控制语义不能依赖 UI transport；不能因为没有 `onEvent` 就直接绕过 checkpoint
- approval 节点不能把“等待客户确认”伪装成 `approvedBy=customer`
- approval 节点不能在图节点内部无限等待人工点击；必须能显式挂起和恢复

## 重规划规则

以下情况必须触发重规划，而不是继续旧任务图：

1. `ValidationReport.failureType === "planning_gap"`
2. `SolutionPatch` 修改了模块分类
3. `ExecutionPatch` 修改了必须文件类别
4. 用户需求能力位未被覆盖

触发后必须做：

1. 重建 `SolutionPlan`
2. 重建 `ExecutionPlan`
3. 丢弃旧任务图里不再有效的任务
4. 清理旧的阻塞状态
5. 从新任务图继续执行

## 上下文预算控制

所有 LLM 节点必须遵守统一预算：

- 失败日志：摘要，不超过阈值
- issue：最多 N 条
- 文件内容：最多 N 个文件，每个文件只保留关键片段
- 纪要：只传摘要，不传全量历史

适用节点：
- `architect`
- `orchestrator`
- `fix_plan`
- `architect_mediation`
- `qa`
- `coder`

## 最小实现批次

第一批必须落地的不是全部对象，而是以下控制点：

1. `TechnologyDecision`
2. `architect.coverageMatrix` 硬闸门
3. `orchestrator.ExecutionPlan` 完整性校验
4. `verifier.ValidationReport.failureType`
5. `fix_plan` 只接受 `implementation_bug`
6. `planning_gap` 强制触发重规划
7. `CustomerApprovalState` 的默认同意授权机制
8. approval 节点正确区分“自动授权 / 人工确认 / 驳回回退”

## 预期效果

落地后，系统应避免以下典型空转：

- 用户要求前后端，但 Architect 缩成纯后端
- 协议已发现缺 route，后续却还在 fix_plan/coder 空转
- 测试环境缺依赖，却不断让 coder 重写文件
- 路由没挂载，但 deploy 仍被允许继续

## 非目标

本设计不试图一次解决所有模型质量问题。它的目标是：

- 即使模型有波动，也不能绕开控制平面
- 即使某个节点“想当然”，也必须被下游闸门拦住
