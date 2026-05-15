# JimClaw 执行控制面设计

日期：2026-04-01

## 背景

到 2026-04-01 为止，JimClaw 已经补了不少“反自旋”机制：

- `planning_gap / implementation_bug / environment_gap / runtime_gap` 已能区分
- `deploy` 的 Windows host 启动链已修正，不再把启动失败伪装成健康检查失败
- `env_guard` 已能在 Docker 不可用时切到 host backend
- 客户确认节点的方向也已经明确：允许授权确认，但不能阻塞等待人工点击

但真实 run 仍暴露出更底层的问题：

- 外层终端可以执行 `npm --version`
- JimClaw 主进程内部的 `child_process.spawn` 却可能直接 `spawn EPERM`
- Docker 在某些会话里不可用时，系统会切到 host
- 但 host backend 依然依赖同一个进程内 `spawn`
- 结果是：表面看起来像 `npm install` 失败，实际是“执行器本身不可用”

这说明当前系统缺的不是某个单点补丁，而是一层独立的执行控制面。

## 2026-04-01 验证回写

这份设计里的两条关键假设，已经被当天真实 run 证实：

- `external_executor` 不能只停留在接口层，客户端必须真正能在 `fetch` 不可用时回退到另一条 HTTP 通道；否则 sidecar 存在也等于不存在。
- 容器执行入口必须统一收口，不能依赖单个容器镜像或 compose 运行时的默认工作目录；否则构建链会出现“同样的 `npm run build`，一次成功一次只打印帮助页”的伪随机问题。

因此执行控制面的设计边界需要明确补充两点：

1. fallback 不只是“声明支持多个 backend”，还必须覆盖客户端传输层自身的退路。
2. 所有容器内命令必须走统一的工作目录约束，不能让节点各自拼接 `docker exec`。

## 问题定义

当前 `src/skills/shell_exec.ts` 的本质是：

1. 一个进程内 shell 包装器
2. 对调用者只返回字符串
3. 不提供能力探测
4. 不提供结构化失败原因
5. 不提供 fallback 选择
6. 不提供授权票据
7. 不提供统一的运行生命周期

这会导致 4 类典型问题：

### 1. 能力判断失真

系统只能知道“命令失败”，但不知道：

- shell 不可拉起
- Docker daemon 不可达
- 需要用户授权
- 当前 backend 可写但不可执行
- 命令本身语法错

### 2. backend 选择失真

当前 backend 选择是节点内局部判断：

- `env_guard` 判断一点
- `infra_setup` 再判断一点
- `deploy` 又自己判断一点

没有统一 backend 协商层。

### 3. 授权语义缺失

某些动作天然需要“客户授权后自动继续”，例如：

- 是否允许联网安装依赖
- 是否允许打开 Docker / 启动容器
- 是否允许保留部署产物

当前系统没有正式的授权票据对象，只能靠节点同步等待或直接绕过。

### 4. 观测与修复脱节

系统能写 note、写 audit，但没有“控制面对象”把观测转换成下一步动作：

- 哪个 executor 可用
- 下一个 backend 应切到哪里
- 失败是否可重试
- 是否需要授权
- 是否必须挂起

## 目标

本设计的目标是为 JimClaw 增加一个 MCP 风格的执行控制面，但不把实现绑定到某个特定协议。

系统需要做到：

1. 执行能力独立于主业务图节点
2. 命令执行不再依赖单一 `child_process.spawn`
3. backend 选择可协商、可降级、可恢复
4. 所有执行失败都有结构化错误语义
5. 授权节点采用“票据 + 挂起 + 恢复”，不能同步阻塞等待人工确认
6. Docker、host shell、未来 remote runner 走统一抽象
7. 节点只表达“我要什么能力”，不自己决定所有执行细节

## 非目标

本设计不试图解决：

1. 所有模型质量问题
2. 所有业务模板质量问题
3. 所有语言脚手架一次性统一
4. UI 样式层面的交互改造

本设计只解决“执行能力”如何成为正式控制面。

## 设计原则

### 1. 执行与编排分离

LangGraph 节点负责声明意图：

- 需要 shell
- 需要 Docker
- 需要端口
- 需要启动服务

执行控制面负责决定：

- 用哪个 backend
- 是否需要授权
- 是否允许重试
- 如何记录结构化结果

### 2. 能力先于动作

任何动作之前，先判断能力：

- 是否能 spawn
- 是否有 Docker daemon
- 是否允许联网
- 是否允许后台进程

没有能力就不能假装执行。

### 3. 结构化失败先于文本日志

不能只返回：

- `spawn EPERM`
- `docker not found`
- `HTTP Code 000`

必须返回机器可路由的类型：

- `executor_unavailable`
- `docker_daemon_unreachable`
- `permission_required`
- `network_unavailable`
- `port_conflict`
- `runtime_start_failed`

### 4. 授权是控制对象，不是 UI 副作用

授权状态必须持久化到 state：

- 已请求
- 已授权
- 已拒绝
- 默认授权

没有授权时，节点必须挂起，不得同步等待。

### 5. backend 是协商结果，不是硬编码路径

同一个动作应支持多个 backend：

- local_shell
- docker
- remote_runner
- future_mcp_executor

## 方案比较

### 方案 A：继续增强 `ShellExecuteSkill`

做法：

- 在现有 `shell_exec.ts` 上继续打补丁
- 增加更多 regex、fallback、重试、Windows 特判

优点：

- 改动最小
- 短期见效快

缺点：

- 仍然绑定主进程内 `spawn`
- backend 能力、授权、生命周期仍然耦合
- 每个节点仍要自己理解执行失败

结论：

- 只能继续止血，不能形成底座

### 方案 B：在进程内新增 `CommandExecutor` 抽象层

做法：

- 保留当前进程内实现
- 增加 `ExecutorRegistry / CapabilityProbe / CommandResult`
- 节点统一调用抽象层，不直接碰 skill

优点：

- 结构清晰
- 可逐步迁移
- 对现有图侵入较小

缺点：

- 如果底层仍是主进程内 `spawn`，根问题仍可能存在
- 只是“抽象更好”，未真正独立执行能力

结论：

- 适合第一阶段

### 方案 C：引入独立执行控制面服务

做法：

- 让执行能力从主 Node 进程中剥离
- JimClaw 通过统一协议请求外部 executor
- executor 自己负责 shell / docker / remote backend

优点：

- 真正隔离主进程与执行能力
- 天然适合授权、审计、能力探测、异步票据
- 最接近 MCP 风格能力层

缺点：

- 实现成本最高
- 需要协议、服务发现、生命周期设计

结论：

- 应作为目标架构

## 推荐路线

采用“两阶段方案”：

1. 第一阶段：仓内先落 `CommandExecutor` 抽象层
2. 第二阶段：把 `CommandExecutor` 的默认实现替换为独立执行控制面服务

原因：

- 可以先把节点耦合拆开
- 不需要一次性重写整套系统
- 为后续独立 executor 服务预留稳定接口

## 总体架构

```text
LangGraph Nodes
  -> Execution Intent
  -> CommandExecutor Facade
      -> Capability Manager
      -> Backend Resolver
      -> Approval Ticket Manager
      -> Lifecycle Manager
      -> Result Classifier
      -> Audit Sink
          -> Local Shell Backend
          -> Docker Backend
          -> Remote Runner Backend
          -> Future MCP Executor Backend
```

### 分层说明

#### 1. Execution Intent 层

节点不再直接传原始字符串命令，而是声明意图：

```ts
type ExecutionIntent =
  | {
      kind: "install_deps";
      workspace: string;
      packageManager: "npm" | "pnpm" | "yarn" | "pip" | "cargo" | "mvn";
      onlineAllowed: boolean;
    }
  | {
      kind: "run_tests";
      workspace: string;
      command: string;
    }
  | {
      kind: "start_runtime";
      workspace: string;
      command: string;
      port?: number;
      host?: string;
      background: true;
    }
  | {
      kind: "exec_shell";
      workspace: string;
      command: string;
      background?: boolean;
    };
```

这样节点表达的是需求，不是执行细节。

#### 2. Capability Manager

统一探测：

- `canSpawnLocal`
- `canUseDockerCli`
- `canReachDockerDaemon`
- `canWriteWorkspace`
- `canOpenNetwork`
- `canStartBackgroundProcess`

返回结构：

```ts
type CapabilitySnapshot = {
  version: "v1";
  localShell: {
    available: boolean;
    reason?: string;
  };
  docker: {
    cliAvailable: boolean;
    daemonReachable: boolean;
    reason?: string;
  };
  network: {
    outboundAllowed: boolean;
    reason?: string;
  };
  backgroundProcess: {
    available: boolean;
    reason?: string;
  };
};
```

#### 3. Backend Resolver

根据 Intent + Capability + Policy 选择 backend：

```ts
type ExecutorBackend =
  | "local_shell"
  | "docker"
  | "remote_runner"
  | "external_executor";

type BackendResolution = {
  selected: ExecutorBackend | null;
  candidates: ExecutorBackend[];
  blocked: boolean;
  blockedReason?: string;
  requiresApproval: boolean;
  approvalScope?: string;
};
```

选择规则示例：

- `install_deps`
  - 优先 `docker`
  - Docker 不可用则尝试 `local_shell`
  - local shell 不可 spawn，则尝试 `remote_runner`
  - 全不可用则返回 `blocked`

- `start_runtime`
  - 若需要可持久后台进程，必须检查 `backgroundProcess.available`

#### 4. Approval Ticket Manager

把“需要用户确认”变成正式对象：

```ts
type ApprovalTicket = {
  id: string;
  stage:
    | "network_install"
    | "docker_start"
    | "background_runtime"
    | "deployment_publish";
  required: boolean;
  status: "pending" | "approved" | "rejected" | "auto_approved";
  reason: string;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: "customer" | "default-authorization";
};
```

规则：

1. 需要授权时，创建票据
2. 图执行写入 `agent_pending` 或 `approval_pending`
3. 等待外部恢复
4. 绝不在节点内部同步等待人工点击

这正好符合你之前的要求：

- 可以授权确认
- 但不阻塞等待人工确认

#### 5. Lifecycle Manager

负责：

- 前台命令
- 后台进程
- PID / containerId
- 日志路径
- 清理动作

```ts
type RuntimeHandle = {
  backend: ExecutorBackend;
  kind: "process" | "container" | "job";
  id: string;
  workspace: string;
  startedAt: string;
  status: "starting" | "running" | "stopped" | "failed";
  stdoutLogPath?: string;
  stderrLogPath?: string;
  portBindings?: Array<{ hostPort: number; containerPort: number }>;
};
```

#### 6. Result Classifier

把底层错误映射为统一类型：

```ts
type ExecutorFailureType =
  | "executor_unavailable"
  | "permission_required"
  | "docker_cli_missing"
  | "docker_daemon_unreachable"
  | "network_unavailable"
  | "command_not_found"
  | "process_spawn_denied"
  | "timeout"
  | "port_conflict"
  | "runtime_start_failed";

type ExecutorResult = {
  ok: boolean;
  backend: ExecutorBackend | null;
  command?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  failureType?: ExecutorFailureType;
  retryable: boolean;
  requiresApproval: boolean;
  approvalTicketId?: string;
  blocked: boolean;
  blockedReason?: string;
  artifacts?: {
    pidPath?: string;
    stdoutLogPath?: string;
    stderrLogPath?: string;
  };
};
```

## 对现有节点的影响

### `env_guard`

当前职责：

- 补依赖
- 选 docker/host
- 释放端口

改造后职责：

- 只做“环境意图编排”
- 调用 `CommandExecutor.probeCapabilities()`
- 调用 `BackendResolver.resolve(intent)`
- 若被阻断，直接产出 `environment_gap`
- 不再自己拼装所有探测逻辑

### `infra_setup`

当前职责：

- 创建容器
- 安装依赖
- 运行构建

改造后职责：

- 提交 `install_deps` / `build_workspace` / `prepare_runtime` Intent
- 只消费结构化结果
- 不自己判断 `spawn EPERM` 是否等于 Docker 不可用

### `terminal`

改造后职责：

- 只提交 `run_tests` Intent
- 根据 `ExecutorResult` 更新 `testResults`

### `deploy`

改造后职责：

- 只提交 `start_runtime` Intent
- 从 `RuntimeHandle` 读取进程或容器句柄
- 健康检查仍保留在 deploy 层
- 但“如何启动”不再由 deploy 自己实现

## 状态对象扩展

建议在 `JimClawState` 中新增：

```ts
type ExecutorState = {
  version: "v1";
  capabilitySnapshot?: CapabilitySnapshot;
  selectedBackend?: ExecutorBackend | null;
  approvalTickets: ApprovalTicket[];
  runtimeHandles: RuntimeHandle[];
  lastExecutorResult?: ExecutorResult;
};
```

这样图节点有正式状态，而不是散落在：

- `executionBackend`
- `containerId`
- `hostRuntimePid`
- `hostRuntimeLogPath`

这些字段仍可保留一轮兼容，但新逻辑应逐步迁到 `ExecutorState`。

## 授权模型

这部分必须与客户确认控制层对齐。

### 授权等级

建议分 3 类：

1. `auto_allowed`
   - 例如读取本地文件
   - 可直接执行

2. `approval_required`
   - 例如联网安装依赖
   - 需要创建票据

3. `forbidden`
   - 当前策略不允许
   - 直接阻断

### 不阻塞等待的流程

```text
Node
 -> submit intent
 -> executor says requiresApproval=true
 -> create ApprovalTicket
 -> persist state as approval_pending
 -> graph ends or pauses
 -> user approves externally
 -> resume run from original node
 -> executor re-check ticket
 -> continue execution
```

这解决了两个老问题：

1. 不会同步卡住
2. 不会绕过授权直接继续

## backend 设计

### 1. Local Shell Backend

职责：

- 在允许时执行本地 shell
- 适合轻量命令

限制：

- 受主机权限和 spawn 能力约束

### 2. Docker Backend

职责：

- 构建隔离运行环境
- 安装依赖、运行测试、启动服务

限制：

- 需要 Docker CLI 和 daemon

### 3. Remote Runner Backend

职责：

- 本机不可执行时，把任务投递给远端受控执行器

适用场景：

- 本地 `spawn EPERM`
- Docker 不可用
- 仍然希望执行真实安装/测试

### 4. External Executor Backend

职责：

- 面向未来 MCP 风格执行服务
- 可以是本地 daemon，也可以是远程服务

## 失败路由规则

执行控制面产生的错误，应映射回现有 4 大失败类型：

### 1. `environment_gap`

映射来源：

- `executor_unavailable`
- `docker_daemon_unreachable`
- `network_unavailable`
- `permission_required`
- `command_not_found`

### 2. `runtime_gap`

映射来源：

- `port_conflict`
- `runtime_start_failed`

### 3. 不应映射为 `implementation_bug`

以下绝不能再误归类为实现问题：

- `spawn EPERM`
- Docker daemon 不可达
- 授权未确认
- 本地 shell 不可用

## 观测与审计

执行控制面必须统一写入审计：

```ts
type ExecutorAuditRecord = {
  timestamp: string;
  intentKind: string;
  backendCandidates: ExecutorBackend[];
  selectedBackend?: ExecutorBackend;
  capabilitySummary: string[];
  approvalTicketId?: string;
  result: "success" | "failed" | "blocked" | "pending_approval";
  failureType?: ExecutorFailureType;
  retryCount: number;
};
```

这样 audit 不再只是文本堆积，而是可回放、可统计。

## 渐进式落地顺序

### 第一阶段：抽象收口

目标：

- 不改外部部署形态
- 先把节点直接依赖 `ShellExecuteSkill` 的地方收口到 `CommandExecutor`

落地项：

1. 新增 `src/executor/` 模块
2. 新增 `ExecutionIntent / ExecutorResult / CapabilitySnapshot`
3. `env_guard / infra_setup / terminal / deploy` 改为调用 facade

### 第二阶段：授权票据化

目标：

- 把客户确认与执行授权统一成票据体系

落地项：

1. `ApprovalTicket`
2. `approval_pending` 恢复语义
3. dashboard 展示授权票据

### 第三阶段：独立执行服务

目标：

- 彻底摆脱对主进程内 `spawn` 的单点依赖

落地项：

1. 本地 executor daemon 或远程 executor service
2. JimClaw 通过协议提交 intent
3. `ShellExecuteSkill` 退化为兼容适配器

## 测试策略

### 单元测试

覆盖：

- capability probe
- backend resolution
- approval ticket 状态迁移
- failure type 分类

### 回放测试

覆盖：

- Docker 不可用但 local 可用
- Docker 不可用且 local 不可用
- 需要授权后挂起恢复
- runtime start failed 回到 runtime 修复链

### 真实 smoke test

覆盖：

- 图书管理系统
- 一个 Python/FastAPI 样例
- 一个 Go/Gin 样例

重点不是业务复杂度，而是：

- install
- test
- deploy
- approval
- resume

## 风险

### 1. 抽象过重

如果第一阶段就直接上远程服务，改动面太大。

应对：

- 先做 facade 和状态对象

### 2. 节点兼容成本高

现有很多逻辑散落在 node 中。

应对：

- 第一阶段只迁移最关键的 4 个节点

### 3. 授权流复杂化

如果票据状态设计不清晰，可能比当前更混乱。

应对：

- 只保留少量稳定状态：`pending/approved/rejected/auto_approved`

## 成功标准

满足以下条件时，认为设计落地成功：

1. `spawn EPERM` 不再被误报为普通 `npm install` 失败
2. Docker 不可用、host 不可用、需要授权，三者能被明确区分
3. 节点不再直接依赖 `child_process.spawn`
4. 授权动作可以挂起恢复，不同步阻塞
5. 同一执行 intent 可以在多个 backend 之间切换
6. 图书管理系统真实 run 遇到执行器问题时，不再自旋

## 与现有控制平面文档的关系

本文是对以下两份文档的补充与下钻：

- `docs/plans/2026-03-27-control-plane-design.md`
- `docs/plans/2026-03-27-control-plane-implementation.md`

那两份文档解决的是：

- 需求、规划、验证、修复、审批的控制平面

本文解决的是：

- “执行能力”本身如何成为控制平面

一句话区分：

- 前者解决“该做什么、失败该回哪里”
- 本文解决“谁来执行、能不能执行、需要谁授权、失败属于哪种执行能力缺口”

## 建议结论

JimClaw 下一阶段不应继续围绕 `shell_exec.ts` 做局部补丁。

建议正式引入：

1. `CommandExecutor` 抽象层
2. `CapabilitySnapshot`
3. `ApprovalTicket`
4. `ExecutorResult`
5. `ExecutorState`

然后分阶段把：

- `env_guard`
- `infra_setup`
- `terminal`
- `deploy`

迁移到执行控制面。

这一步做完之后，系统才有可能真正摆脱：

- 缺依赖自旋
- Docker/host 切换混乱
- 授权等待阻塞
- 进程内 spawn 单点失效
