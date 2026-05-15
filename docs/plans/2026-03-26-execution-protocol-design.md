# 执行协议化设计

## 背景

当前 JimClaw 已经具备：

- 多 Agent 协作
- 三层共识
- 会议纪要
- QA / FixPlan / Mediation 回路
- 一部分关键衔接的硬校验

但系统仍存在一个根问题：

很多“协议”仍主要以自然语言存在，只是给人类和 LLM 看，并没有完全变成机器可执行约束。

这导致以下典型问题反复出现：

- 架构说明与实际文件布局不一致
- `filesToCreate`、`subTasks`、测试配置、运行配置之间错位
- 仲裁结论和修复计划只是建议，不是硬约束
- 节点间事实源不统一，容易出现“说一套、跑一套”

目标不是删除人类可读内容，而是把“给 LLM 看的文字”升级为“机器协议 + 人类摘要”的双轨体系。

## 设计目标

执行协议化需要同时满足四个目标：

1. 保留人类可读性
   - 继续保留会议纪要、项目共识、仲裁结论、前端展示摘要

2. 增强机器可执行性
   - 关键约束必须进入结构化 state，由节点直接消费

3. 降低节点自由发挥空间
   - 对文件布局、依赖关系、导出契约、测试发现、启动方式建立硬约束

4. 统一失败语义
   - 失败必须有标准分类、归因节点、证据和建议补丁

## 总体方案

采用“双轨协议”：

- 机器协议：`ExecutionProtocol`
  - 严格结构化
  - 进入 graph state
  - 由下游节点直接执行和校验

- 人类协议：`meetingNotes / consensus summaries`
  - 由机器协议自动生成摘要
  - 给人类、前端和 LLM 浏览
  - 不再作为唯一事实源

核心原则：

- 机器协议优先于自然语言纪要
- 纪要只做解释，不做唯一约束
- 下游节点不得自行发明关键布局和约束

## ExecutionProtocol 结构

建议新增状态字段：

```ts
type ExecutionProtocol = {
  version: "v1";
  project: {
    language: string;
    framework: string;
    runtime: "node" | "python" | "go" | "other";
    workspaceLayout: {
      sourceRoots: string[];
      testRoots: string[];
      entryFiles: string[];
      configFiles: string[];
      infraFiles: string[];
    };
  };
  contracts: {
    api: {
      endpoints: Array<{
        path: string;
        method: string;
        ownerFile?: string;
      }>;
    };
    files: Record<string, {
      role:
        | "entry"
        | "route"
        | "controller"
        | "service"
        | "model"
        | "middleware"
        | "test"
        | "config"
        | "infra"
        | "unknown";
      allowedImports?: string[];
      requiredExports?: string[];
      ownedEndpoints?: string[];
      testCoverageTarget?: string[];
    }>;
  };
  workflow: {
    nodeInputs: Record<string, string[]>;
    nodeOutputs: Record<string, string[]>;
    blockingRules: string[];
    recoveryRules: string[];
  };
  validation: {
    layoutRules: string[];
    dependencyRules: string[];
    runtimeRules: string[];
    acceptanceRules: string[];
  };
};
```

## 双轨映射

每个关键节点以后同时产出两种内容。

### 1. 机器协议产物

写入 state，例如：

- `state.executionProtocol.project.workspaceLayout.testRoots`
- `state.executionProtocol.contracts.files["tests/user.test.ts"]`
- `state.executionProtocol.validation.runtimeRules`

这部分用于：

- `orchestrator` 生成合法 DAG
- `coder` 限定文件职责和依赖
- `verifier` 做衔接校验
- `qa` 输出标准化失败对象
- `architect_mediation` 产出补丁

### 2. 人类可读产物

继续保留：

- `meetingNotes`
- `consensusCore`
- `consensusProgress`

但这些内容由机器协议生成摘要，例如：

- “测试目录统一为 `tests/`”
- “`src/routes/userRoutes.ts` 仅允许依赖 controller + middleware”
- “健康检查路径为 `/api/health`”

## 节点职责调整

### architect

新增职责：

- 生成 `ExecutionProtocol.project`
- 生成 `ExecutionProtocol.contracts`
- 生成 `ExecutionProtocol.validation`

保留职责：

- `TechSpec`
- `SystemManifest`
- `ApiContract`
- 设计纪要

约束：

- 不再只输出“建议性的架构说明”
- 必须输出关键布局和约束字段

### orchestrator

新增职责：

- 基于 `ExecutionProtocol` 生成合法的 `SubTask` DAG
- 每个任务的 `fileTarget` 必须落在协议允许的布局内
- 每个任务依赖必须符合文件角色关系

约束：

- 不得自行定义测试目录
- 不得让 model/service/controller/route 形成循环依赖
- 不得生成不在协议布局内的文件路径

### coder

新增职责：

- 将 `ExecutionProtocol.contracts.files[fileTarget]` 作为硬上下文
- 按文件角色约束 import / export / endpoint ownership

约束：

- route 只能消费 protocol 允许的 controller / middleware
- test 只能落在 protocol 允许的 testRoots
- entry / config / infra 文件必须遵守协议模板和运行约束

### verifier

新增职责：

- 验证“下游是否真的能消费上游产物”
- 不再只查语法和文件存在

典型检查：

- 测试文件是否在 Jest 发现范围内
- 启动入口是否和 package/start/build 对齐
- 路由文件是否声明了契约允许的端点
- 文件角色和依赖关系是否违背协议

### qa

新增职责：

- 基于标准失败协议输出工单
- 聚焦“真实失败”和“根因对象”

约束：

- 不再自行发明第二套失败语义
- 如果 verifier 已给出结构化失败，QA 只能解释和排序，不能改写事实

### architect_mediation

新增职责：

- 不再只输出中文建议
- 输出 `ProtocolPatch[]`

示例：

```ts
type ProtocolPatch = {
  target: string;
  action: "replace" | "append" | "remove";
  path: string;
  value: unknown;
  reason: string;
};
```

## 失败协议

建议引入统一失败结构：

```ts
type ProtocolFailure = {
  type:
    | "layout_mismatch"
    | "dependency_deadlock"
    | "contract_drift"
    | "runtime_mismatch"
    | "test_discovery_gap"
    | "tooling_unavailable"
    | "syntax_error"
    | "export_mismatch";
  node: string;
  file?: string;
  summary: string;
  evidence: string[];
  suggestedPatch?: string[];
  blocking: boolean;
};
```

用途：

- `verifier` 输出标准失败
- `qa` 继承并补充归因
- 前端统一显示
- `trace-index.json` 和 `boulder.json` 保持一致

## 第一批协议化范围

优先做 5 类高风险衔接。

### 1. 测试布局协议

包括：

- `testRoots`
- `testMatch`
- 声明的业务测试文件列表

规则：

- Node/Jest 项目统一落到 `tests/`
- `jest.config` 必须覆盖所有声明的业务测试文件
- 只跑 `setup.test.ts` 不能算整体通过

### 2. 文件角色协议

为每个文件定义角色：

- route
- controller
- service
- model
- middleware
- test
- config
- infra
- entry

规则：

- 每种角色有固定允许依赖集合
- orchestrator 和 coder 都必须遵守

### 3. 导出契约协议

为关键文件记录：

- 必须导出的符号
- 允许导入的来源

规则：

- route/controller 不得引用依赖文件中不存在的导出
- verifier 可以静态检查

### 4. 启动协议

包括：

- `entryFiles`
- `runCommand`
- `buildOutput`
- `listenPort`

规则：

- `package.json`、编译产物、deploy 命令、健康检查路径必须一致

### 5. 健康检查协议

包括：

- `healthPath`
- `hostPort`
- `containerPort`
- `expectedStatus`

规则：

- deploy 不得自行猜测根路径或监听端口

## 状态扩展建议

建议在 `JimClawState` 中新增：

```ts
executionProtocol?: ExecutionProtocol;
protocolFailures?: ProtocolFailure[];
protocolPatches?: ProtocolPatch[];
```

说明：

- `executionProtocol` 是主事实源
- `protocolFailures` 是结构化失败清单
- `protocolPatches` 是仲裁/修复对协议本身的修改

## 前端与可观测性

前端应区分三类信息：

1. 执行协议
   - 当前 testRoots
   - 当前 entryFile
   - 当前健康检查路径

2. 协议失败
   - 类型
   - 文件
   - 证据
   - 是否阻塞

3. 人类摘要
   - 会议纪要
   - 共识摘要
   - 仲裁解释

这样可以避免：

- 页面显示“任务通过”，但协议失败没展示
- 用户只看到自然语言，不知道机器实际按什么执行

## 兼容策略

为了避免一次性重构过大，采用渐进式落地：

### Phase 1

- architect 产出 `ExecutionProtocol v1`
- orchestrator/coder/verifier 只先接入：
  - 测试布局
  - 文件角色
  - 导出契约

### Phase 2

- mediation/fix_plan 改为输出 `ProtocolPatch[]`
- verifier 扩展启动协议和健康检查协议

### Phase 3

- QA、前端、trace-index 全量切到协议失败对象
- 自然语言纪要全部由协议摘要生成

## 验收标准

协议化完成后，至少应满足：

1. `filesToCreate`、`subTasks`、测试配置、运行配置来自同一协议源
2. 架构师给出的关键布局约束能被机器执行
3. orchestrator 无法产出明显循环依赖图
4. verifier 能识别测试发现缺口、入口错位、契约漂移
5. QA 不再发明第二套失败语义
6. 前端能同时展示：
   - 当前协议
   - 当前失败
   - 当前人类摘要

## 推荐实施顺序

1. 引入 `ExecutionProtocol v1`
2. 接入测试布局协议
3. 接入文件角色 / 导出契约
4. 接入启动 / 健康检查协议
5. 将 mediation 改为协议补丁

## 结论

这次协议化的重点不是“再多写一些说明”，而是：

- 保留人类可读字段
- 保留给其他 Agent 的中文约束
- 但真正决定执行的必须是机器协议

系统以后必须从：

- “会说”

推进到：

- “会卡”
- “会校验”
- “会执行协议”

这是后续所有稳定性的基础。
