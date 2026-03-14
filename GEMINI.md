# GEMINI.md - JimClaw Project Context

## Project Overview

**JimClaw** is a multi-agent collaboration system for autonomous code development. It uses a "Sisyphus Protocol" — iterative plan-implement-verify cycles — augmented by an architect arbitration mechanism that resolves cross-file contract conflicts when the coder self-correction loop stalls.

### Core Architecture

- **Orchestration**: Built with **LangGraph.js**, using a directed state machine with conditional routing.
- **Agents**: Defined in `src/agents/team.ts`. Four personas inherit from `BaseAgent` and use LangChain models.
- **Skill System**: Modular tools defined with Zod schemas, mounted as LangChain `DynamicStructuredTool`.
- **Memory**: Every session archives artifacts to `workspace/run_<timestamp>/`. Post-mortem lessons are appended to `KNOWLEDGE.md` and injected into every agent's system prompt.

### Workflow

```
pm → architect → contract_sync → [approval] → orchestrator → coder → infra_setup → terminal → qa
                                                                 ↑         ↑                    |
                                                                 |         └─ architect_mediation|
                                                                 └──── retry (up to maxRetries) ─┘
                                                                                                  ↓
                                                                                    deploy → post_mortem → persistence
```

**QA routing:**
- Pass → `deploy`
- `retryCount >= maxRetries` → `post_mortem`
- `retryCount >= 2 && !mediationDirectives` → `architect_mediation` (triggers once)
- else → `coder`

### Key Nodes

| Node | Agent | Purpose |
|------|-------|---------|
| `pm` | 观止 | Generates `TaskContract` from free-text goal |
| `architect` | 独孤 | Produces `TechSpec`, `SystemManifest`, `ApiContract` |
| `contract_sync` | 清扬 | Static Zod validation of API endpoints |
| `orchestrator` | 观止 | Decomposes `TechSpec` into ordered `SubTask[]` |
| `coder` | 星河 | Implements files; inner self-correction loop (3 attempts/file); injects `mediationDirectives` |
| `architect_mediation` | 独孤 | Analyzes full codebase for cross-file conflicts; outputs `MediationDirective[]` |
| `infra_setup` | — | npm install + Docker/Compose setup |
| `terminal` | — | Runs `spec.testCommand` in workspace |
| `qa` | 清扬 | Returns structured failures: `failedFiles`, `testErrors`, `failedTestNames` |
| `deploy` | — | Starts app, health-checks entry point |
| `post_mortem` | 观止 | Writes lessons to `KNOWLEDGE.md` |
| `persistence` | — | Archives session; prunes old run dirs (keep 10) |

### State Types

All defined in `src/core/graph.ts`:

- `TaskContract` — title, requirements, acceptanceCriteria
- `TechSpec` — language, testCommand, runCommand, entryPoint, filesToCreate, interfaces
- `SystemManifest` — services (name/port/description), environment, sharedConfig
- `ApiContract` — endpoints with path, method, request/response shapes
- `SubTask` — id, fileTarget, dependencies, contextRequirement, status, lastError
- `MediationDirective` — file, action, detail (architect arbitration instruction)
- `JimClawState` — full graph state including all above + retryCount, mediationDirectives, qaFailures, packageJsonHash

### Tech Stack

- **Language**: TypeScript (Node.js)
- **Frameworks**: LangChain, LangGraph.js
- **Validation**: Zod (runtime schemas for all LLM outputs)
- **UI**: Express, Socket.io, React, TailwindCSS (Web); chalk (TUI)
- **Models**: Anthropic (Claude), MiniMax, GLM, and others via `jimclaw.config.json`

## Building and Running

### Prerequisites

- Node.js & npm
- `.env` file with API keys (e.g. `ANTHROPIC_API_KEY`)

### Key Commands

```bash
npm install
npx ts-node src/tui.ts "build a todo list REST API with tests"   # TUI (recommended)
npx ts-node src/server.ts                                          # Web dashboard at :3000
npx ts-node src/index.ts "your goal"                               # Plain CLI
npx tsc                                                            # Compile TypeScript
```

## Development Conventions

### Project Structure

```
src/
  core/         graph.ts, agent.ts, skill.ts
  agents/       team.ts (four agent instances)
  skills/       file_read, file_write, shell_exec, docker_exec,
                playwright_exec, health_check, lsp_diagnose, lint_fix
  utils/        models.ts (ModelManager)
  tui.ts        Terminal UI
  server.ts     Web backend + Socket.io
  index.ts      CLI entry point
public/
  index.html    React dashboard (single file)
```

### Coding Standards

- **Strict Typing**: All core components use strict TypeScript and Zod for runtime LLM output validation.
- **Persona-Driven**: Agents stay in character; all prompts are written in Chinese.
- **Atomic Skills**: Each skill performs one task and returns a plain string result.
- **Chain-first addNode**: New nodes must be added inside the `new StateGraph(...).addNode(...)` chain — not as separate `workflow.addNode()` calls — so TypeScript correctly infers valid node names for `addConditionalEdges`.

## 核心开发哲学（铁律）

### 1. 语言无关性 (Language Agnostic)
JimClaw 是为全语言自动化设计的。严禁在系统层（Nodes/Core）编写针对特定语言（如仅支持 JavaScript）的硬编码逻辑。任何涉及文件操作、路径解析或环境搭建的改进，必须同等考虑 Python, Go, Java 等所有支持语言的兼容性。

### 2. 技能优先 (Skill-Driven Autonomy)
凡是 Agent 可以通过 Skill 或 MCP 工具完成的操作（如端口探测、网络调研、代码诊断），严禁在 Graph Node 逻辑中代劳。必须通过 Prompt 指引 Agent 主动调用工具获取真实数据，并基于工具反馈确立“架构契约”。

### 3. 极致透明 (Zero Log Swallowing)
严禁吞掉或隐藏任何执行日志。
- Agent 的所有 Prompt、Thinking 和回复必须持久化。
- 工具调用的原始入参和 Stdout/Stderr 必须全量记录。
- 严禁在 Coder 节点中掩盖工具报错（如 Lint 失败也标记为成功）。

## 编码约束（对 AI 助手强制执行）

### 1. 必须使用中文
- 所有面向用户的输出、注释、日志消息、提示词（prompt）、团队对话消息均须使用中文
- 代码标识符（变量名、函数名、接口名）和技术术语保持英文，遵循工程惯例
- 违反示例：`console.log("Task finished")` → 应改为 `console.log("[任务] 已完成")`

### 2. 禁止硬编码（文件名、扩展名、端口等）
以下内容**绝对不允许**在代码中硬编码，必须从运行时状态动态获取：

| 禁止硬编码的内容 | 正确做法 |
|----------------|---------|
| 文件名 `"server.js"` / `"unit_test.js"` | 从 `state.subTasks` 提取：`getEntryPoint(state)` |
| 文件扩展名 `.js` / `.ts` / `.py` | 从 `spec.language` 或 `task.fileTarget` 的扩展名动态判断 |
| 端口号 `3000` / `8080` | 从 `manifest.services[].port` 或 `process.env.PORT` 获取 |
| 测试命令 `"node unit_test.js"` | 从 `spec.testCommand` 获取 |
| 运行命令 `"node server.js"` | 从 `spec.runCommand` 获取 |
| 入口点 URL `"http://localhost:3000"` | 从 `spec.entryPoint` 获取 |

违反示例（**禁止**）：
```typescript
// ❌ 错误：硬编码文件名和扩展名
failedFiles: ["unit_test.js", "server.js"]

// ❌ 错误：硬编码端口
const PORT = 3000;

// ❌ 错误：硬编码测试命令
await shell.run("node unit_test.js");
```

正确示例：
```typescript
// ✅ 正确：从状态动态提取
const allFiles = state.subTasks.map(t => t.fileTarget);
const testFile = allFiles.find(f => /test|spec/i.test(f)) ?? "unit_test.js";
const implFile = getImplementationFile(state);

// ✅ 正确：从环境变量获取端口
const PORT = parseInt(process.env.PORT || "3000", 10);

// ✅ 正确：从 spec 获取测试命令
await shell.run(`cd ${WORKSPACE} && NODE_ENV=test ${state.spec.testCommand}`);
```

### Adding New Components

1. **New skill**: create `src/skills/<name>.ts`, export a `Skill` object with Zod input schema, mount on the relevant agent in `src/agents/team.ts`.
2. **New workflow node**: add `.addNode("node_name", async (state) => { ... })` to the chain in `createJimClawGraph()`, then wire edges with `workflow.addEdge()` / `workflow.addConditionalEdges()`.
3. **New state field**: add an `Annotation` entry to `JimClawState`; sync the field in `src/server.ts` stream loop and `public/index.html` state handlers.
