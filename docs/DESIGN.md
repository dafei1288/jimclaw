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
pm → architect → contract_sync → [approval] → orchestrator → coder → infra_setup → terminal → qa
                                                                 ↑         ↑                    |
                                                                 |         |  (retryCount >= 2,  |
                                                                 |         └── !mediationDirs)   |
                                                                 |        architect_mediation     |
                                                                 └──── retry (up to maxRetries) ──┘
                                                                                                  ↓
                                                                                    deploy → post_mortem → persistence
```

**QA 节点内部 6 阶段：**
```
1. Coder 自检失败？→ 直接重试
2. 单元测试输出检测（NODE_ENV=test testCommand）→ 失败则重试
3. 启动 server（PORT=XXXX，后台）
4. GLM-5 coding 模式生成 integration_test.js（fetch + node:assert，零依赖）
5. 执行集成测试 → 关闭 server
6. 评估：全通过 isDone=true；否则 qaFailures → coder retry
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

### projectBrief 团队共识机制

```
State.projectBrief: string[]   ← 累积型，concat reducer

各节点追加内容：
  Architect  → "[Architect] 语言: JS | testCommand: node unit_test.js"
             → "[Architect] 单元测试约束: 只测纯函数，禁 supertest/axios/fetch"
             → "[Architect] API 端点: GET /api/items, POST /api/items, ..."
  QA         → "[QA] 第N轮 单元测试失败: <错误摘要>"
             → "[QA] 第N轮 集成测试失败: <错误摘要>"
  Mediation  → "[Mediation] 仲裁诊断: <根因摘要>"

注入方式：agents.xxx.chat([...], cb, { brief: state.projectBrief })
         → getSystemPrompt(brief) 生成"团队共识"区块注入 system prompt
```

### 角色职责分离

| 角色 | 负责 | 禁止 |
|------|------|------|
| Coder | 实现文件 + 单元测试（纯函数，node:test/unittest/JUnit） | supertest、HTTP 客户端、启动 server |
| QA | 启动 server、生成+执行集成测试、评估结果 | — |
| Architect | 系统设计、语言/框架选型、IP/端口资源分配 | 建议测试文件使用 HTTP 客户端 |

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
| `src/agents/team.ts` | 构造参数改用 createModelSetForAgent |
| `src/core/graph.ts` | State 新增 projectBrief；各节点指定 mode/brief；QA 重写；prompt 全面重构 |
| `src/skills/get_server_ip.ts` | 获取服务器真实 IP（新建） |
| `src/skills/find_free_port.ts` | 扫描空闲端口（新建） |
