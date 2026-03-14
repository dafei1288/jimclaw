# JimClaw 改进设计文档

> 最后更新：2026-03-02

---

## 已完成的改进

| # | 改动 | 文件 |
|---|------|------|
| ✅ | BaseAgent.chat() 实现真正的 tool-use agentic loop（bindTools + ToolMessage 循环） | agent.ts |
| ✅ | 新建 get_server_ip skill（获取服务器真实 IP） | skills/get_server_ip.ts |
| ✅ | 新建 find_free_port skill（扫描空闲端口） | skills/find_free_port.ts |
| ✅ | Architect 注册两个新 skill，prompt 要求先调用工具获取 IP/端口 | team.ts, graph.ts |
| ✅ | Deploy 节点从 spec.entryPoint 提取端口，注入 PORT 环境变量启动 workspace app | graph.ts |
| ✅ | Coder server 文件约束：process.env.PORT + app.listen(PORT, '0.0.0.0') | graph.ts |
| ✅ | 写文件后自动扫描 require/import，缺少外部包自动追加 devDependencies 并 npm install | graph.ts |
| ✅ | 写文件后检测本地 require('./') 引用目标是否存在，不存在触发重试并约束 inline | graph.ts |
| ✅ | 启动时打印 [Config] maxRetries / workspace / enableEvolution | graph.ts |
| ✅ | 增量测试改用 spec.testCommand，支持 Jest/pytest/mvn 等多框架 | graph.ts |
| ✅ | 测试文件检测大小写不敏感（/test\|spec/i） | graph.ts |
| ✅ | EADDRINUSE / 框架不匹配 / supertest 违规 精确错误提示 | graph.ts |
| ✅ | 增量测试和 terminal 节点均以 NODE_ENV=test 运行，防止 server 监听触发端口占用 | graph.ts |
| ✅ | Coder 自检全败时短路：跳过 infra+terminal，直接路由至 qa 节点 | graph.ts |
| ✅ | QA 客观失败信号检测层（覆盖 LLM 主观放行） | graph.ts |
| ✅ | Architect prompt：testCommand 按语言对照表自适应（JS/TS/Python/Java/Go） | graph.ts |
| ✅ | api_contract 不得为空数组，prompt 示例端点仅供格式参考 | graph.ts |
| ✅ | Coder 跨文件对齐：写 test 文件时注入实现文件内容（反之亦然） | graph.ts |
| ✅ | Architect_mediation prompt 重构：聚焦当前报错，不针对历史问题 | graph.ts |
| ✅ | Mediation prompt 加入测试文件约束，禁止建议 HTTP 客户端 | graph.ts |
| ✅ | Coder 注入仲裁指令时自动过滤含 supertest/axios/fetch 的指令 | graph.ts |
| ✅ | 错误输出截断从 500 → 1500 字符，coder 一次看到所有失败用例 | graph.ts |
| ✅ | DeepSeek Reasoner reasoning 模式不绑工具，避免 reasoning_content 400 错误 | agent.ts |
| ✅ | 多能力 Agent：models.ts createModelSetForAgent，向下兼容 string 格式 | utils/models.ts |
| ✅ | 多能力 Agent：agent.ts models Map + selectModel(mode) + chat(options.mode/brief) | core/agent.ts |
| ✅ | 多能力 Agent：team.ts 改用 createModelSetForAgent，config 升级对象格式 | agents/team.ts |
| ✅ | coding_plan：GLM-5 on coding/paas/v4 专属编程端点，coder/qa coding mode 使用 | jimclaw.config.json |
| ✅ | 多能力 Agent：graph.ts 关键节点指定 mode（coder→coding, mediation→reasoning） | core/graph.ts |
| ✅ | 角色职责分离：Architect prompt 按语言自适应单元测试文件名和 testCommand | core/graph.ts |
| ✅ | 角色职责分离：Coder 写测试文件时按扩展名注入语言专属单元测试约束（禁 HTTP 客户端） | core/graph.ts |
| ✅ | 角色职责分离：QA 节点重写，6 阶段流程（单元评估→启动 server→生成集成测试→执行→关闭→评估） | core/graph.ts |
| ✅ | 精准修复模式：QA 重试时先输出 JSON patch（find/replace），只改有问题的方法；定位失败则回退全文件重写 | graph.ts |
| ✅ | projectBrief / codeLog 同步至 server.ts 和前端（团队共识面板 + 修改记录面板） | server.ts, index.html |

---

## 架构概览

### 当前工作流

```
pm → architect → contract_sync → [approval] → orchestrator → coder → infra_setup → terminal → verifier → qa
                                                                 ↑    ↑                                    |
                                                                 |    |                    ┌───────────────┤
                                                                 |    |              retryCount%3==2?      |
                                                                 |    |              architect_mediation    |
                                                                 |    |                    |               |
                                                                 |    └── (从fix_plan)───-┤               |
                                                                 |                        ▼               |
                                                                 └──────────────── fix_plan ◄─────────────┘
                                                                        QA-Coder 修复协商
                                                                                                          ↓
                                                                                    deploy → post_mortem → persistence
```

**QA 路由逻辑：**
- `isDone` → `deploy`
- `retryCount >= maxRetries` → `post_mortem`
- `retryCount >= 2 && (retryCount - 2) % 3 === 0` → `architect_mediation`（每3轮架构师仲裁）
- else → `fix_plan`（QA-Coder 先协商修复方向，再去 coder 实现）

**fix_plan 协商流程：**
```
Step 1 - Coder 分析：
  读失败文件 + 测试输出 → 说出根因理解 + 具体修改方案 + 置信度

Step 2 - QA 审查：
  逐项批准 or 纠正（"你理解错了，真正的根因是..."）
  补充 Coder 遗漏的文件

结果：fixPlan[] 存入 state
  → Coder 按协商结果实现，不再靠自己猜
```

**architect_mediation（每3轮触发）：**
```
输入：open issues（含已存在轮次）+ 停滞工单（3+轮未解决）
     + 上次仲裁指令 + 最新测试输出
输出：新的 MediationDirective[]（可推翻上次方向）
→ 直接去 coder（指令足够精确，跳过 fix_plan）
```

**Verifier 静态预检（5项，无 LLM）：**
```
① filesToCreate 文件是否都存在
② 服务文件是否有监听声明
③ 测试文件是否有断言
④ 运行时框架不在 devDependencies（精确匹配，避免 @types/express 误判）
⑤ Dockerfile 第一行是否是合法指令
文件缺失 → coder；其他失败 → qa
```

### 多模型配置（jimclaw.config.json）

| Agent | mode | 模型 | 用途 |
|-------|------|------|------|
| pm | default | GPT-4o | 规划、契约定义 |
| architect | default | GPT-4o | 系统设计、工具调用 |
| architect | reasoning | DeepSeek Reasoner | 仲裁推理（不绑工具） |
| coder | default | GLM-4.7 | fallback |
| **coder** | **coding** | **GLM-5 (coding/paas/v4)** | **代码生成（主路径）** |
| coder | reasoning | DeepSeek Reasoner | 错误分析（预留） |
| qa | default | GLM-4.7 | 评估 |
| qa | coding | GLM-5 (coding/paas/v4) | 集成测试生成 |

### 三层团队共识机制（替代旧 projectBrief）

> ⚠️ 旧的 `projectBrief: ConsensusEntry[]` 平铺数组已废弃（保留字段做向后兼容，节点不再写入）。
> 现改用结构化三层共识，由 `buildSystemContext(state)` 生成 system prompt 注入内容。

```
三层结构：

1. consensusCore（永久常驻）
   - 由 pm 初始化（title + requirements），architect 补全（architectureSummary, techStack, port）
   - architect_mediation 追加 criticalDecisions
   - reducer: (x, y) => y ?? x（整体替换，节点负责 merge）

2. consensusProgress（每轮更新）
   - architect 设初始 pendingFiles
   - orchestrator 从 subTasks 更新 pendingFiles
   - coder 更新 completedFiles / pendingFiles
   - qa 更新 openIssues（一句话问题摘要列表）

3. meetingNotes（追加 + id 去重）
   - 每个节点写一条 summary（≤80字，常驻 prompt）
   - 全文写入 workspace/nodes/{id}.md
   - Architect / Coder 可调用 read_meeting_note(note_id) 按需读取全文

注入方式：agents.xxx.chat([...], cb, { brief: buildSystemContext(state) })
  → 生成格式：
    [项目核心] • 项目/需求/架构/技术栈/关键决策
    [当前进度（第N轮）] • 完成/待完成/未解决问题
    [沟通纪要] • [note-pm-r0] ... • [note-architect-r0] ...

Note ID 命名：note-{phase}-r{round}，如 note-pm-r0、note-coder-r2
```

### 角色职责分离

| 角色 | 负责 | Skills | 禁止 |
|------|------|--------|------|
| Coder（星河） | 实现文件 + 单元测试 + 按 fixPlan 精准修复 | FileRead, FileWrite, LintFix, LSPDiagnose, WebSearch, WebFetch, ReadMeetingNote | supertest、HTTP 客户端、启动 server |
| QA（清扬） | 分析测试失败 + fix_plan 审查 + issueTracker 维护 | FileRead, Shell, ReadMeetingNote | — |
| Architect（独孤） | 系统设计、语言/框架选型、IP/端口资源分配、架构仲裁 | FileRead, GetServerIP, FindFreePort, WebSearch, WebFetch, ReadMeetingNote | 建议测试文件使用 HTTP 客户端 |
| PM（观止） | 需求分析、任务契约定义 | — | — |

### 团队共识字段（JimClawState 中的新增关键字段）

| 字段 | 类型 | 更新节点 | 说明 |
|------|------|---------|------|
| `consensusCore` | `ConsensusCore \| null` | pm, architect, architect_mediation | 永久项目身份（框架、依赖、架构摘要、关键决策） |
| `consensusProgress` | `ConsensusProgress \| null` | architect, orchestrator, coder, qa | 每轮进度快照（完成/待完成/未解决问题） |
| `meetingNotes` | `MeetingNote[]` | 所有主要节点 | 摘要常驻 prompt，全文按需读取 |
| `fixPlan` | `FixPlanItem[] \| null` | fix_plan | QA-Coder 协商后的精准修复计划（每轮覆盖） |
| `issueTracker` | `Issue[]` | qa | 跨轮 id 去重合并，含 detectedRound |
| `mediationDirectives` | `MediationDirective[] \| null` | architect_mediation | 每3轮更新的架构仲裁指令 |

---

## 关键配置（jimclaw.config.json）

```json
{
  "llm_configs": {
    "anthropic_strong": { "provider": "openai", "modelName": "gpt-4o", ... },
    "deepseek_reasoning": { "provider": "deepseek", "modelName": "deepseek-reasoner", ... },
    "glm": { "provider": "openai", "modelName": "GLM-4.7", "baseUrl": "https://open.bigmodel.cn/api/paas/v4/", ... },
    "coding_plan": { "provider": "openai", "modelName": "GLM-5", "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4/", ... }
  },
  "agents": {
    "pm": "anthropic_strong",
    "architect": { "default": "anthropic_strong", "reasoning": "deepseek_reasoning" },
    "coder":     { "default": "glm", "coding": "coding_plan", "reasoning": "deepseek_reasoning" },
    "qa":        { "default": "glm", "coding": "coding_plan" }
  },
  "global": { "maxRetries": 20, "workspaceDir": "./workspace", "enableEvolution": true }
}
```

---

## 文件改动范围汇总

| 文件 | 说明 |
|------|------|
| `jimclaw.config.json` | 新增 coding_plan（GLM-5 coding 端点），agents 升级对象格式 |
| `src/utils/models.ts` | 新增 createModelSetForAgent，向下兼容 string 格式 |
| `src/core/agent.ts` | models Map + selectModel(mode) + chat(options: mode/brief) + getSystemPrompt(brief) |
| `src/agents/team.ts` | QA 追加 FileRead + ReadMeetingNote skill；Architect + Coder 追加 ReadMeetingNote |
| `src/core/graph.ts` | 新增 fix_plan 节点；QA 路由改为 fix_plan（默认）/ architect_mediation（每3轮）；architect_mediation 每3轮触发 |
| `src/skills/get_server_ip.ts` | 获取服务器真实 IP（新建） |
| `src/skills/find_free_port.ts` | 扫描空闲端口（新建） |
| `src/skills/read_meeting_note.ts` | 按 note_id 读取 workspace/nodes/ 下的会议纪要全文（新建） |
| `src/core/graph_types.ts` | 新增 ConsensusCore / ConsensusProgress / MeetingNote / FixPlanItem 接口；新增 fixPlan Annotation 字段；TechSpec 扩展 framework/dependencies/devDependencies |
| `src/core/logic_utils.ts` | 新增 buildSystemContext() + writeMeetingNote() |
| `src/core/nodes/fix_plan_node.ts` | QA-Coder 修复协商节点（新建） |
| `src/core/nodes/coder_node.ts` | 支持 fixPlan 优先执行；注入实际 stack trace；测试文件专项 mock 重置指引；移除 MAX_TASKS_PER_RUN |
| `src/core/nodes/qa_node.ts` | 静态 FAIL 文件提取；LLM 空 issues 安全兜底；改进文件归因和反停滞 prompt |
| `src/core/nodes/architect_mediation_node.ts` | 停滞检测（detectedRound）；注入上次仲裁指令及效果；注入最新测试输出；每次仲裁都是"新起点" |
| `src/core/nodes/verifier_node.ts` | 精确 devDeps 匹配；package.json 缺失为致命错误；Dockerfile 语法检查（第⑤项） |
| `src/core/nodes/infra_node.ts` | docker-compose 构建失败检测并传递到 testResults |
| `src/core/nodes/terminal_node.ts` | 保留 infra 构建错误消息，不用泛泛信息覆盖 |
| `src/core/nodes/pm_node.ts` | 输出 consensusCore 初始值 + meetingNote |
| `src/core/nodes/architect_node.ts` | 输出完整 consensusCore（含 framework/deps）+ consensusProgress 初始值 + meetingNote |
| `src/core/nodes/orchestrator_node.ts` | JS/TS 安全注入 package.json/tsconfig.json；更新 consensusProgress；meetingNote |
| `src/skills/file_write.ts` | 绝对路径自动转换为相对路径（agent 传入时的容错） |
| `public/index.html` | 三层共识面板替换旧 projectBrief 面板 |
| `src/server.ts` | 初始状态包含 consensusCore/consensusProgress/meetingNotes/fixPlan |
