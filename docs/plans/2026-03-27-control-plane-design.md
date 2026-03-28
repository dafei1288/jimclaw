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
- `environment_gap` -> Env/Infra
- `runtime_gap` -> Deploy/Verifier

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
- `runtime_gap` 禁止转实现修复

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
   - 去 Deploy / Runtime 修复

禁止出现：
- `planning_gap` 进入 `fix_plan`
- `environment_gap` 进入 `coder`
- `runtime_gap` 被伪装成 `implementation_bug`

## 客户确认控制层

客户确认是正式控制层，不是可选提示。

系统默认支持两种确认模式：

1. 显式确认
   - 到达关键阶段时暂停
   - 等客户确认后继续

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
   - 进入 approval 控制层并暂停
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

- 未确认且未授权默认通过时，流程必须暂停
- 已明确驳回时，必须回到对应节点重做
- 确认记录必须写入 `CustomerApprovalState`
- 后续节点只能读取已确认版本，不允许继续漂移
- approval 控制语义不能依赖 UI transport；不能因为没有 `onEvent` 就直接绕过 checkpoint
- approval 节点不能把“等待客户确认”伪装成 `approvedBy=customer`

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
