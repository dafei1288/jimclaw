# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run with Terminal UI (recommended — real-time monitoring with colors)
npx ts-node src/tui.ts "your task description"

# Run standard CLI session
npx ts-node src/index.ts "your task description"

# Run web dashboard (served at http://localhost:3000)
npx ts-node src/server.ts

# Simulate step-by-step team interaction (no live LLM calls)
npx ts-node src/test-flow.ts

# Test LLM connectivity
npx ts-node src/test-llm.ts

# Compile TypeScript
npx tsc
```

> `npm test` is currently a placeholder — no test suite exists yet.

## Architecture

JimClaw is a multi-agent AI system for autonomous code development. It is built on **LangGraph.js** as a directed state machine. The central workflow is defined in `src/core/graph.ts` (`createJimClawGraph()`).

### Workflow (node order)

```
pm → architect → contract_sync → [approval] → orchestrator → coder → infra_setup → terminal → verifier → qa
                                                                 ↑         ↑                              |
                                                                 |         |      (retryCount >= 2,       |
                                                                 |         └───── !mediationDirs)         |
                                                                 |               architect_mediation      |
                                                                 └──────── retry (up to maxRetries) ──────┘
                                                                                                          ↓
                                                                                        deploy → post_mortem → persistence
```

**QA conditional routing logic:**
- `isDone` → `deploy`
- `retryCount >= maxRetries` → `post_mortem`
- `retryCount >= 2 && !mediationDirectives` → `architect_mediation`
- else → `coder`

**Verifier conditional routing:**
- `testResults` starts with `"[Verifier 预检失败]"` → `coder` (skip QA, direct re-code)
- else → `qa`

Node descriptions:

- **pm**: Generates a `TaskContract` (structured task definition) from a free-text prompt.
- **architect**: Produces a `TechSpec` and `SystemManifest` (services, ports, env vars, dependencies). Uses `get_server_ip` + `find_free_port` tools to fill real IP/port into `entryPoint`. Rules enforce: express in `dependencies`, `app.listen('0.0.0.0')`, relative API paths for frontend, `tsconfig.json` for TS projects.
- **contract_sync**: Validates `ApiContract` consistency before coding begins; includes static Zod-based endpoint validation (path format, HTTP method, deduplication).
- **approval**: Optional human-in-the-loop checkpoint; only active when an `onEvent` callback is provided.
- **orchestrator**: Decomposes `TechSpec` into ordered, file-scoped `SubTask[]`.
- **coder**: Implements each sub-task with an inner self-correction loop (up to 3 attempts per file). Runs LSP diagnostics and lint-fix in real time. Skips files not in QA's `failedFiles` list during retries. Injects `mediationDirectives` into prompts when present. **Todo-Enforcer**: scans each written file for `// TODO` / `// FIXME` / `throw new Error('not implemented')` markers — forces retry if found.
- **architect_mediation**: Triggered once when `retryCount >= 2` and no prior mediation exists. The architect (独孤) analyzes cross-file contract conflicts in the full codebase and outputs binding `MediationDirective[]` fix instructions.
- **infra_setup**: Starts an isolated Docker container (`node:20-alpine` or `python:3.11-slim`) with all ports from `manifest.services` mapped to the host. Workspace is mounted at `/app`. Runs `npm install` inside the container. Reuses the existing container on retry cycles. Stores `containerId` in state for downstream nodes.
- **terminal**: Runs the unit-test command inside the container via `docker exec`. Falls back to direct shell execution if no container is present.
- **verifier**: (**Atlas 原则**) Static pre-QA check — no LLM call, runs in milliseconds. Four checks: ① all `filesToCreate` files exist, ② server's runtime imports are in `dependencies` (not `devDependencies`), ③ server file contains `app.listen(`, ④ test file contains actual assertions. Failure routes directly back to `coder`, skipping expensive test runs.
- **qa**: Two-phase testing. Phase 1: unit tests via `terminal` results. Phase 2: starts server inside container (`docker exec -d`, PID saved to `/tmp/server.pid`), generates and runs either Playwright E2E tests (when frontend HTML detected) or fetch-based API integration tests (from host, port is mapped). Kills server via container PID on completion.
- **deploy**: Starts the production server inside the container (`docker exec -d`). Health-checks the mapped port from the host.
- **post_mortem**: PM agent summarizes lessons learned, appended to `KNOWLEDGE.md`.
- **persistence**: Archives all artifacts in `workspace/run_<timestamp>/`; auto-prunes old runs (keeps latest 10). On success: prints container name, access URL, and management commands. On failure: `docker rm -f` cleans up the container.

### Core layer (`src/core/`)

- **`agent.ts`** — `BaseAgent`: wraps a LangChain model with a persona (`AgentPersona`), system prompt, optional tool list, and memory injection from `KNOWLEDGE.md`.
- **`skill.ts`** — `Skill<T>`: generic skill wrapper using Zod for input schema; converts to `DynamicStructuredTool` for LangChain.
- **`graph.ts`** — `createJimClawGraph()`: the complete state machine (~1100 lines). Defines all state types and node logic. Contains module-level helper `execInContainer(id, cmd, opts)` for routing shell commands through Docker.

### State types (`src/core/graph.ts`)

| Type | Description |
|------|-------------|
| `TaskContract` | PM output: title, requirements, acceptanceCriteria |
| `TechSpec` | Architect output: language, testCommand, runCommand, entryPoint, filesToCreate, interfaces |
| `SystemManifest` | Services (name, port), environment variables |
| `ApiContract` | Endpoint definitions (path, method, request/response shapes) |
| `SubTask` | File-scoped dev task with status and lastError |
| `MediationDirective` | Architect arbitration instruction: file, action, detail |
| `FileChangeEntry` | Per-file write record (round, file, status, error) for frontend display |
| `JimClawState` | Full graph state: all above + retryCount, mediationDirectives, qaFailures, packageJsonHash, **containerId**, projectBrief, codeLog |

### Agents (`src/agents/team.ts`)

Four personas, each with a fixed model assignment in `jimclaw.config.json`:

| Agent | Persona | Model key | Skills (按需注入) |
|-------|---------|-----------|-----------------|
| PM (观止) | Product Manager | `anthropic_strong` | `[]` |
| Architect (独孤) | Software Architect | `anthropic_strong` | `[FileRead, GetServerIP, FindFreePort]` |
| Coder (星河) | Full-stack Dev | `minmax` | `[FileRead, FileWrite, LintFix, LSPDiagnose]` |
| QA (清扬) | Test Engineer | `glm` | `[Shell]` |

> QA's Docker and HealthCheck operations are called directly in `graph.ts` (not via agent tool), so they are not in the agent's skill list.

### Skills (`src/skills/`)

Each file exports one `Skill` object:

| Skill | File | Purpose |
|-------|------|---------|
| `file_read` | `file_read.ts` | Read files from workspace |
| `file_write` | `file_write.ts` | Write files to workspace |
| `shell_exec` | `shell_exec.ts` | Run shell commands with timeout; supports `isBackground` |
| `docker_exec` | `docker_exec.ts` | Docker / docker-compose operations (used directly in graph.ts) |
| `playwright_exec` | `playwright_exec.ts` | Browser-based E2E testing (used directly in graph.ts) |
| `health_check` | `health_check.ts` | HTTP health polling with retry (used directly in graph.ts) |
| `lsp_diagnose` | `lsp_diagnose.ts` | Static type/syntax diagnostics |
| `lint_fix` | `lint_fix.ts` | Auto-format and lint correction |

### Model management (`src/utils/models.ts`)

`ModelManager` reads `jimclaw.config.json` to instantiate the correct LangChain model per agent. It also injects the last 2000 characters of `KNOWLEDGE.md` into every agent's system prompt for continuous learning.

## Configuration

**`jimclaw.config.json`** — model mappings, API keys/endpoints, and global settings:
- `maxRetries`: how many coder→qa retry cycles before giving up (default 5).
- `workspace`: output root directory.
- `evolution`: whether post-mortem insights are appended to `KNOWLEDGE.md`.

**`.env`** — fallback for API keys (e.g. `ANTHROPIC_API_KEY`).

## Docker container lifecycle

Every run gets one isolated container named `jimclaw_run_<timestamp>`:

```
infra_setup  →  docker run -d --name jimclaw_<id> -p PORT:PORT -v WORKSPACE:/app node:20-alpine
terminal     →  docker exec <id> sh -c "NODE_ENV=test <testCmd>"
qa           →  docker exec -d <id> sh -c "PORT=X <runCmd> & echo $! > /tmp/server.pid"
             →  (tests run from host, port is mapped)
             →  docker exec <id> sh -c "kill $(cat /tmp/server.pid)"
deploy       →  docker exec -d <id> sh -c "PORT=X <runCmd>"
persistence  →  print container name + access URL   (success)
             →  docker rm -f <id>                   (failure)
```

Container is **reused across retry cycles** (infra_setup checks `.State.Running` before starting a new one). Port mapping covers all ports in `manifest.services[]`.

## Key conventions

- All agent prompts are written in **Chinese (中文)** by design.
- Adding a new skill: create `src/skills/<name>.ts`, export a `Skill` object, mount it on the relevant agent in `src/agents/team.ts`.
- Adding a new workflow node: define the node function inside the `createJimClawGraph()` chain in `src/core/graph.ts`, add it to the graph with `.addNode()` **within the chain** (required for TypeScript type inference), and wire edges with `workflow.addEdge()` / `workflow.addConditionalEdges()`.
- `KNOWLEDGE.md` is auto-written by the `post_mortem` node — do not edit manually during a session.
- Each run produces isolated artifacts under `workspace/run_<timestamp>/` (gitignored).
- `mediationDirectives` is set once per session (when `retryCount >= 2`). After mediation, normal retry continues until `maxRetries`.
- `containerId` is set by `infra_setup` and persists in state for all downstream nodes. Never hardcode container names — derive from `path.basename(WORKSPACE)`.

## 编码约束（对 AI 助手强制执行）

### 1. 必须使用中文
- 所有面向用户的输出、注释、日志消息、提示词（prompt）、团队对话消息均须使用中文
- 代码标识符（变量名、函数名、接口名）和技术术语保持英文，遵循工程惯例
- 违反示例：`console.log("Task finished")` → 应改为 `console.log("[任务] 已完成")`

### 2. 禁止硬编码（文件名、扩展名、端口等）
以下内容**绝对不允许**在代码中硬编码，必须从运行时状态动态获取：

| 禁止硬编码的内容 | 正确做法 |
|----------------|---------|
| 文件名 `"server.js"` / `"unit_test.js"` | 从 `state.subTasks` 提取：`subTasks.find(t => /server/i.test(t.fileTarget))?.fileTarget` |
| 文件扩展名 `.js` / `.ts` / `.py` | 从 `spec.language` 或 `task.fileTarget` 的扩展名动态判断 |
| 端口号 `3000` / `8080` | 从 `manifest.services[].port` 或 `process.env.PORT` 获取 |
| 测试命令 `"node unit_test.js"` | 从 `spec.testCommand` 获取 |
| 运行命令 `"node server.js"` | 从 `spec.runCommand` 获取 |
| 入口点 URL `"http://localhost:3000"` | 从 `spec.entryPoint` 获取 |
| 容器名称 `"jimclaw_run_xxx"` | 从 `\`jimclaw_${path.basename(WORKSPACE)}\`` 动态构造 |

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
const implFile = allFiles.find(f => !/test|spec/i.test(f) && !f.endsWith("package.json")) ?? "server.js";

// ✅ 正确：从环境变量获取端口
const PORT = parseInt(process.env.PORT || "3000", 10);

// ✅ 正确：从 spec 获取测试命令（在容器内执行）
await execInContainer(state.containerId, `NODE_ENV=test ${state.spec.testCommand}`);
```
