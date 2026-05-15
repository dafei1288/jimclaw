# JimClaw 开发进度表 (Roadmap)

## 阶段 0: 核心团队建设 (已完成)
- [x] 实现默认 Agent 组 (PM, Architect, Coder, QA)
- [x] 实现灵活的 ModelManager 与 jimclaw.config.json
- [x] 完善 Agent 之间的任务契约 (Contract) 传递逻辑

## 阶段 1: 基础闭环 (已完成)
- [x] Sisyphus 协议：写代码-跑测试-纠错循环
- [x] 拟人化沟通日志 (Team_Chat_Log)
- [x] 自动化复盘与本地 `KNOWLEDGE.md` 知识沉淀

---

## 阶段 2: 架构升级 (已完成)

### 2.1 协议升级与资源协调
- [x] 引入 `SystemManifest`：全局资源清单（端口、服务名、环境变量）
- [x] Architect 产出 `TechSpec` + `SystemManifest` + `ApiContract`
- [x] API 契约静态校验：路径格式、HTTP 方法、重复端点检测

### 2.2 子智能体与上下文优化
- [x] `TaskOrchestrator`：将复杂 Spec 拆解为有序文件级子任务
- [x] 上下文裁剪：每个文件任务只注入其依赖文件内容
- [x] 接口契约对齐 (`contract_sync` 节点)
- [x] LLM 输出 Zod 校验：TaskContract / TechSpec / SubTask / QAResult

### 2.3 真实环境部署与集成测试
- [x] `DockerSkill`：支持 docker-compose 编排
- [x] `PlaywrightSkill`：浏览器 E2E 能力
- [x] `HealthCheckSkill`：服务启动前多节点轮询
- [x] `LSPDiagnoseSkill`：文件写入后实时类型/语法诊断
- [x] `LintFixSkill`：自动格式化与 lint 修复

### 2.4 重试效率优化
- [x] 结构化 QA 失败报告（`failedFiles` / `testErrors` / `failedTestNames`）
- [x] 定向重试：只重跑 QA 标记的失败文件，跳过已通过文件
- [x] package.json MD5 哈希：依赖未变时跳过 `npm install`
- [x] 文件级自纠错内循环（每文件最多 3 次）
- [x] workspace 自动清理：保留最新 10 个 run 目录

### 2.5 架构师仲裁机制
- [x] `MediationDirective` 接口：file / action / detail 三元组
- [x] `mediationDirectives` 状态字段（Annotation，reducer 保留非 undefined 值）
- [x] `architect_mediation` 节点：coder 自救 2 轮失败后触发一次，架构师全量分析跨文件冲突，输出绑定修复指令
- [x] Coder prompt 注入：`[架构师仲裁指令 - 必须严格执行]` 段落
- [x] QA 条件边：`retryCount >= 2 && !mediationDirectives` → `architect_mediation`

---

## 阶段 3: 可视化与追踪 (已完成)

### 3.1 实时监控看板
- [x] TUI：chalk 彩色终端，逐节点输出结构化摘要
- [x] Web 看板：Socket.io + React，阶段进度条 + 子任务状态
- [x] QA 失败详情面板（红色）
- [x] 架构师仲裁指令面板（橙色，触发后显示）
- [x] 工程页签：workspace 文件树 + 文件内容高亮查看
- [x] LLM Prompt/Response 可展开详情卡
- [ ] 任务溯源图谱：可视化代码文件演进历史（待实现）

### 3.2 调试与人工干预
- [x] 审批模式（`approval` 节点，Architect 定稿后）
- [x] 多端同步：页面刷新后通过 `session-sync` 恢复完整进度
- [ ] 分支回溯：将 Graph 状态回退到某次成功节点（待实现）

---

## 阶段 3.5：Sisyphus 精髓移植（已完成）

> 参考 oh-my-opencode 的三条核心原则，详见 `docs/sisyphus-design.md`

- [x] **改动 A：Todo-Enforcer**（对标 Ralph Loop）
  - Coder 每个文件写入后扫描 `TODO/FIXME/未实现` 标记
  - 发现则强制重写，不允许 stub 代码进入后续流程
- [x] **改动 B：Pre-QA Verifier**（对标 Atlas 独立验证）
  - 新增 `verifier` 节点，插在 `terminal → qa` 之间
  - 纯代码扫描（不调 LLM）：文件存在性 / 依赖对齐 / listen() / 断言非空
  - 发现硬伤直接路由回 Coder，省掉无效测试轮次
- [x] **改动 C：Skills 按需注入**（对标 On-demand MCP）
  - 裁剪 QA Agent 工具集：移除 Docker、HealthCheck（graph.ts 直接调用，不需要在 agent tool 里）

---

## 阶段 3.6：智能缺陷追踪系统 (Issue Tracker) (已完成)

- [x] **缺陷模型 (Issue Model)**：定义 `Issue` 接口及其状态流转逻辑
- [x] **QA 职能升级**：实现 QA 节点对测试结果的深度审计与工单生成
- [x] **工单驱动修复**：更新 Coder 节点以优先处理关联的 Open Issues
- [x] **架构师深度调解**：基于 Issue 历史记忆的冲突仲裁机制
- [x] **可视化看板**：在 Web 端实时展示红、橙、黄三色缺陷追踪看板
- [x] **自动路由优化**：根据 Issue 严重程度决定是否阻塞开发流程

---

## 阶段 4: 待规划

### 4.1 前端支持升级（现代框架）
> **当前约定**：前端暂时生成静态 HTML（单文件 `index.html`），内嵌 CSS + JavaScript，
> 通过 fetch API 与后端交互。不引入构建工具或 npm 前端依赖。
- [ ] **现代前端框架支持**（Vue 3 / React / Svelte）
  - Architect 识别 "Vue"/"React"/"Svelte" 等关键词后切换模板
  - 引入 Vite 构建配置（`vite.config.ts`）
  - 前后端分离部署（前端静态资源 + 后端 API 独立端口）
  - 单元测试使用 Vitest 或 Jest（替代当前 `npx ts-node unit_test.ts`）
  - 注意：现代框架需要两个容器（frontend:5173, backend:3000），docker-compose 协调，前端通过相对代理或 CORS 访问后端
- [ ] 前端组件级单元测试（Testing Library）
- [ ] 前端 E2E 测试与后端集成（Playwright 跨服务）

### 4.2 容器化增强
- [x] 全链路 Docker 容器化：`infra_setup` 启动容器，所有 shell 命令（测试/服务/部署）通过 `docker exec` 运行
- [x] 多端口映射：从 `SystemManifest.services` 收集所有端口，`docker run -p` 自动映射
- [x] 容器生命周期管理：成功则保留（用户可访问），失败则自动 `docker rm -f` 清理
- [x] 成果分享：`persistence` 节点输出容器名、访问地址、管理命令
- [ ] 资源配额：当前 `--memory=1g --cpus=2`，未来支持从 config 配置

### 4.3 工程能力
- [ ] 并行子任务：多个 Coder 子进程并行处理独立文件
- [ ] 多 workspace 会话管理：Web 端支持同时追踪多个任务
- [ ] 测试套件：为核心 graph 逻辑补充单元测试

---

## 当前实施优先级（2026-03-23 调整）

> 阶段 4 后续默认按下面顺序推进，先补执行完整性和状态追踪，再做并行与前端扩展。

### P0 执行完整性与回归测试
- [~] 核心 graph / node 回归测试继续补齐，覆盖中断、重试、仲裁、持久化
  - 已覆盖：中断恢复、阻塞即停、QA 误放行、deploy 失败归因、dashboard snapshot、artifact truth、token 统计、checkpoint replay、deploy 启动日志与健康检查路径
- [x] 失败 run 产物标准化：最后失败节点、失败摘要、兜底纪要、关键快照
- [~] 关键生成结果增加编译/语法/契约三类保底校验
  - 已补：坏文件结构校验、契约漂移拦截、模板骨架收敛、package/start 路径校验、部署启动链日志化
  - 待补：更多语言模板下的同类确定性骨架策略

### P1 状态追踪增强与回放基础
- [~] 任务溯源图谱所需的状态快照索引、节点事件索引、文件变更索引
  - 已落地 `trace-index.json` 基线，包含最后节点、会议纪要索引、文件变更索引、失败摘要
- [~] 分支回溯所需的成功节点锚点、状态恢复入口、最小回放能力
  - 已落地 `checkpoints/` 成功节点锚点基线，当前覆盖 `orchestrator` / `coder_final` / `verifier` / `qa` / `deploy`
  - 已落地 checkpoint replay 预览入口：可列出 checkpoint，并返回清洗后的恢复态预览
  - 已落地 CLI 续跑入口：`--replay <workspacePath> <checkpointId>`
  - 已落地 replay workspace 续写：CLI / Web 续跑复用原 workspace 与 trace 上下文，不再新建新的 `run_*`
- [~] 核心 graph 状态与持久化一致性测试
  - 已补 workspace 产物一致性校验器，当前覆盖 `boulder.json / trace-index.json / checkpoints` 的 trace、最后节点、round 对齐
  - 已补 `subTasks` 与 `trace-index.files` 联动校验，能拦截 completed/failed 状态与文件最后写入状态不一致
  - 已补 replay 产物一致性回归测试，能拦截 checkpoint trace drift
  - 已补 `lint_fix` 工具链失败分级：`prettier` 安装/网络失败降级为环境告警，解析错误仍阻塞
  - 已补 `coder` 依赖顺序约束：只执行依赖已完成的文件任务，避免跨文件契约漂移
  - 已补 `coder` 阻塞即停：单文件阻塞失败后立即停止本轮生成并转 `qa`，不再继续写后续 pending 文件消耗 token
  - 已补 `qa` 阻塞聚焦分支：`[Coder 阻塞失败]` 只围绕真实阻塞文件生成工单，不再把 untouched pending 文件扩散成缺陷
  - 已补 Agent 模型 fallback：429 / 5xx / 网络类故障会自动切换到同 Agent 的其他 mode
  - 已补 `fix_plan` 节点级降级：模型资源耗尽时改走规则化修复计划，避免修复链路整体中断
  - 已补 Coding Plan 路由收敛：`coder_node`、`qa_node` 深度分析、`fix_plan` 协商统一走 `coding` mode，避免代码任务继续误走普通 `glm`
  - 已补 token 记账：每次模型调用会落盘到 `token-usage.json`，并同步聚合到 `trace-index.json.tokenUsage`
  - 已补部署链路收口：非 compose 路径自动 `npm run build`，compose 路径改为 `build + idle test container`，deploy 健康检查改为 `127.0.0.1 + API 契约 GET 路径`，后台启动附带 `server.pid/server.log`
  - 已通过真实 run `workspace/run_1774415632972` 验证最小 TypeScript Express 健康检查服务可完整闭环部署
- [~] ExecutionProtocol 协议化
  - 已落地 `ExecutionProtocol v1` state/type
  - 已接入 `architect -> orchestrator -> coder -> verifier`
  - 已协议化：测试布局、文件角色、基础启动/健康检查摘要、依赖角色约束
  - 已落地：`ProtocolPatch[]` 生成与自动应用、`trace-index.json` 协议视图、前端协议视图
  - 待补：`qa` 全量围绕 `ProtocolFailure` 收口、更多节点继续消费协议对象

### P2 编排能力增强
- [ ] 容器资源配额改为从 config 配置，而不是固定参数
- [ ] 并行子任务：多个 Coder 子进程并行处理独立文件
- [ ] 多 workspace 会话管理：Web 端支持同时追踪多个任务

### P3 前端生态扩展
- [ ] 现代前端框架支持（Vue 3 / React / Svelte）
- [ ] 前端组件级单元测试（Testing Library）
- [ ] 前端 E2E 测试与后端集成（Playwright 跨服务）
## 2026-03-24 Note

- [x] 修复 `coder` 的瞬时工具假失败：`lint_fix` 早期失败不再在最终代码已有效、文件已成功写入时粘住整个任务状态
- [x] 为上述场景补回归：`coder accepts valid final code after a transient pre-write lint failure`
- [x] 修复中断写入后的半状态：新增 per-file recovery intent，并在启动/退出时自动回放到 `boulder.json` 与 `trace-index.json`
- [x] 修复阻塞失败后的 token 浪费：`coder` 现在单文件阻塞即停，不再继续生成后续文件
- [x] 修复 QA 误扩散：`qa` 在 `[Coder 阻塞失败]` 分支只聚焦真实阻塞文件，不再把 pending 文件全部打成缺陷
- [x] 补 workflow replay harness：固定回放 `Verifier` 失败不得误放行、`deploy` 失败必须落证据与归因
- [x] 补 artifact truth harness：校验 `boulder.json / trace-index.json / nodes/*.md / audit/*.md` 对同一次失败的结论一致
- [x] 补结构化审计事件流：新增 `audit/events.jsonl`，把关键 agent 事件、状态更新、任务结束/失败收敛为可机读事实源
- [x] 补失败 run 提炼工具：支持从 `workspace/run_xxx` 自动抽取 fixture，供 workflow replay / dashboard snapshot 复用
- [x] 补 dashboard snapshot harness：固定 session 快照校验节点、文件、token、共识四条显示口径互不打架
- [x] 修复模型单点故障：`BaseAgent` 增加 retryable fallback，遇到 429 / 5xx / 网络故障时自动切换候选模型
- [x] 修复 `fix_plan` 配额单点故障：当 `coder` / `qa` 模型都不可用时，节点会输出规则化修复计划而不是直接崩溃
