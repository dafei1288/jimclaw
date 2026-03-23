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

# 从 checkpoint 恢复并继续执行
npx ts-node src/index.ts --replay workspace/run_xxx coder_final-r2

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
workspace/        # 每次运行的隔离产物目录（gitignored，含 boulder.json / trace-index.json / checkpoints/ / nodes/）
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

## 当前优先级

当前路线已调整为先补执行完整性，再扩展新能力：

1. 执行完整性与回归测试：补齐坏文件拦截、状态一致性、失败 run 摘要与纪要保底
2. 状态追踪增强：已补 `trace-index.json` 和 `checkpoints/` 作为基础索引与成功节点锚点，后续继续扩展任务溯源图谱和分支回溯入口
3. 编排能力增强：容器资源配额配置化、并行子任务、多 workspace 会话
4. 前端生态扩展：Vue / React / Svelte 支持、组件测试、E2E 测试

当前还提供了两个恢复预览接口：

- `GET /api/workspace/checkpoints`：列出当前 run 的 checkpoint
- `GET /api/workspace/checkpoint?id=<checkpointId>`：返回 checkpoint 的 replay 预览状态

另外支持 CLI 续跑：

- `npx ts-node src/index.ts --replay <workspacePath> <checkpointId>`：从指定 checkpoint 继续执行，并复用原 workspace 与 trace 链

Web 端的 workspace 页也提供了 checkpoint 列表和“继续”按钮，可直接从当前 run 的锚点续跑；续跑不会新建 `run_*`，而是在原 workspace 内继续写入 `boulder.json / trace-index.json / checkpoints/`。
另外，核心工具层已经补了 workspace 产物一致性校验，用于检查 `boulder.json / trace-index.json / checkpoints` 之间的 trace、节点和 round 是否对齐，以及 `subTasks` 和 `trace-index.files` 是否联动一致，后续回放和溯源图谱会直接复用这套规则。
针对最新 run 暴露出的工具链问题，`lint_fix` 现在会把 `prettier` 的安装/网络不可用识别为非阻塞环境告警，不再把这类瞬时工具问题误判成代码失败；但真正的 `prettier` 解析/语法错误仍然会阻塞。
另外，`coder` 现在会遵守 `orchestrator` 产出的文件依赖顺序，只处理依赖已完成的子任务，避免先写 controller、后补 model/service 这类跨文件契约漂移。

---

## 进度

详见 [TODO.md](./TODO.md)
