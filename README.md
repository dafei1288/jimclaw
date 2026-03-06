# JimClaw: 拟人化多智能体协作进化系统

JimClaw 是一个借鉴了 Claude Code、OpenClaw 和 OpenCode 设计理念的智能体系统。它通过拟人化的角色设定、执着的循环迭代（Sisyphus 协议）以及架构师仲裁机制，实现高度自主的代码开发与维护。

## 核心特性

### 拟人化团队协作
| 角色 | 名字 | 职责 |
|------|------|------|
| PM | 观止 | 任务契约定义、子任务拆解、复盘总结 |
| Architect | 独孤 | 技术设计、API 契约、冲突仲裁 |
| Coder | 星河 | 代码实现、文件级自纠错 |
| QA | 清扬 | 结构化失败分析、质量评估 |

### Sisyphus 协议（编写-运行-修复闭环）
- **文件级自纠错**：每个文件独立重试最多 3 次，失败立即触发 LSP 诊断和重写。
- **定向修复**：QA 返回结构化失败信息（`failedFiles` / `testErrors` / `failedTestNames`），coder 只重跑失败文件，跳过已通过文件。
- **package.json 哈希**：检测依赖变化，无变化时跳过 `npm install`，提升重试效率。

### 架构师仲裁机制（新）
当 coder 自救失败 2 轮后，架构师（独孤）自动介入：
1. 全量分析所有文件内容 + QA 失败报告 + API 契约。
2. 输出绑定性 `MediationDirective[]`，精确到每个文件的字段/函数/返回值。
3. Coder 后续迭代强制执行这些指令，直到通过或达到 `maxRetries`。

典型解决场景：`package.json` 缺少测试依赖、API 路径不一致、HTTP 状态码与测试预期不符等跨文件契约冲突。

### 多端实时监控
- **TUI**：终端彩色实时仪表盘，每个节点输出结构化摘要。
- **Web 看板**：Socket.io + React，展示阶段进度、子任务状态、QA 失败详情、仲裁指令（橙色面板）。

### 进化型长期记忆
- 每次任务结束后自动复盘，经验写入 `KNOWLEDGE.md`。
- 每个 Agent 启动时读取知识库，持续学习历史教训。

---

## 工作流

```
pm → architect → contract_sync → [approval] → orchestrator → coder → infra_setup → terminal → qa
                                                                 ↑         ↑                    |
                                                                 |         └─ architect_mediation|
                                                                 |           (retryCount >= 2,   |
                                                                 |            首次触发)           |
                                                                 └──── 继续重试至 maxRetries ─────┘
                                                                                                  ↓
                                                                                    deploy → post_mortem → persistence
```

**QA 路由规则：**
- 通过 → `deploy`
- `retryCount >= maxRetries` → `post_mortem`（放弃）
- `retryCount >= 2` 且未仲裁 → `architect_mediation`（首次仲裁）
- 其他 → `coder`（继续重试）

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 核心编排 | LangGraph.js（状态机） |
| Agent 框架 | LangChain（多模型支持） |
| 类型校验 | Zod（运行时 Schema 验证） |
| 语言 | TypeScript / Node.js |
| 终端 UI | chalk（彩色输出） |
| Web UI | Express + Socket.io + React + TailwindCSS |
| 代码诊断 | LSP Diagnose Skill + Lint Fix Skill |

---

## 快速开始

### 1. 配置环境

```bash
cp .env.example .env
# 填写 ANTHROPIC_API_KEY 等密钥
```

### 2. 安装依赖

```bash
npm install
```

### 3. 运行

```bash
# 推荐：终端实时监控
npx ts-node src/tui.ts "实现一个 todo list REST API，带完整测试"

# Web 看板（访问 http://localhost:3000）
npx ts-node src/server.ts

# 标准命令行
npx ts-node src/index.ts "你的任务需求"
```

---

## 项目结构

```
src/
  core/
    graph.ts      # 完整状态机定义（节点、边、所有状态类型）
    agent.ts      # BaseAgent 基类（Persona + 模型 + 记忆注入）
    skill.ts      # Skill<T> 泛型工具封装
  agents/
    team.ts       # 四个 Agent 实例定义
  skills/
    file_read.ts / file_write.ts / shell_exec.ts
    docker_exec.ts / playwright_exec.ts / health_check.ts
    lsp_diagnose.ts / lint_fix.ts
  utils/
    models.ts     # ModelManager（读取 jimclaw.config.json）
  tui.ts          # 终端实时界面
  server.ts       # Web 后端 + Socket.io
  index.ts        # 标准 CLI 入口
public/
  index.html      # React Web 看板（单文件，含仲裁指令面板）
workspace/        # 每次运行的隔离产物目录（gitignored）
KNOWLEDGE.md      # 自动进化的知识库（post_mortem 节点写入）
jimclaw.config.json  # 模型配置、maxRetries、workspace 路径
```

---

## 配置说明

**`jimclaw.config.json`** 主要字段：

```json
{
  "maxRetries": 5,
  "workspace": "workspace",
  "evolution": true,
  "models": {
    "anthropic_strong": { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022" },
    "minmax": { ... },
    "glm": { ... }
  }
}
```

---

## 进度

详见 [TODO.md](./TODO.md)
