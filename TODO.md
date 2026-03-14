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
