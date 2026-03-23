# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
                                                                 ↑    ↑                                    |
                                                                 |    |                    ┌───────────────┤
                                                                 |    |              retryCount%3==2?      |
                                                                 |    |              architect_mediation    |
                                                                 |    |                    |               |
                                                                 |    └── (has fixPlan) ──┤               |
                                                                 |                        ▼               |
                                                                 └──────────────── fix_plan ◄─────────────┘
                                                                        (QA-Coder协商修复方向)
                                                                                                          ↓
                                                                                        deploy → post_mortem → persistence
```

**QA conditional routing logic:**
- `isDone` → `deploy`
- `retryCount >= maxRetries` → `post_mortem`
- `retryCount >= 2 && (retryCount - 2) % 3 === 0` → `architect_mediation`（每3轮强制仲裁）
- else → `fix_plan`（QA-Coder 先协商修复方向，再实现）

**Verifier conditional routing:**
- `testResults` 含 `"文件缺失"` → `coder`（直接补文件，跳过 QA）
- other failures → `qa`（Verifier 其他预检失败走 QA 分析）

Node descriptions:

- **pm**: Generates a `TaskContract` (structured task definition) from a free-text prompt.
- **architect**: Produces a `TechSpec` and `SystemManifest` (services, ports, env vars, dependencies). Uses `get_server_ip` + `find_free_port` tools to fill real IP/port into `entryPoint`. Rules enforce: express in `dependencies`, `app.listen('0.0.0.0')`, relative API paths for frontend, `tsconfig.json` for TS projects. Also defines `framework`, `dependencies`, `devDependencies` as team consensus baseline.
- **contract_sync**: Validates `ApiContract` consistency before coding begins; includes static Zod-based endpoint validation (path format, HTTP method, deduplication).
- **approval**: Optional human-in-the-loop checkpoint; only active when an `onEvent` callback is provided.
- **orchestrator**: Decomposes `TechSpec` into ordered, file-scoped `SubTask[]`. Safety net: auto-injects `package.json` / `tsconfig.json` subtasks for JS/TS projects if missing.
- **coder**: Implements each sub-task. If `state.fixPlan` exists (set by `fix_plan` node), uses QA-confirmed diagnosis and exact change description instead of self-guessing. Injects real test stack trace (from `testResults`) for failing files. Injects `mediationDirectives` when present. Includes test-file-specific guard: Jest mock reset pattern, `noUnusedLocals` awareness, `mock.calls` index correctness.
- **fix_plan**: (**New**) QA-Coder negotiation before implementation. Step 1 — Coder reads failing files and states its root-cause understanding + proposed change. Step 2 — QA reviews: approves or corrects each item, adds any missed files. The agreed `FixPlan[]` is stored in state; Coder executes it precisely in the next round. Produces `note-fixplan-r{N}` meeting note.
- **architect_mediation**: Triggered every 3 rounds of failure (`retryCount` = 2, 5, 8, …). The architect (独孤) sees: open issues with age (rounds since detected), stagnant issues (3+ rounds unresolved), previous mediation directives and their outcome, latest test output. Outputs new binding `MediationDirective[]` targeting specific files. After mediation, routes directly to `coder` (bypasses `fix_plan`, directives are already precise).
- **infra_setup**: Starts an isolated Docker container (`node:20-alpine` or `python:3.11-slim`) with all ports from `manifest.services` mapped to the host. Workspace is mounted at `/app`. Runs `npm install` inside the container. Reuses the existing container on retry cycles. Build failures (dockerfile parse errors, compose errors) are propagated to `testResults` for QA analysis.
- **terminal**: Runs the unit-test command inside the container via `docker exec`. Preserves infra build error message if `containerId` is empty.
- **verifier**: (**Atlas 原则**) Static pre-QA check — no LLM call, runs in milliseconds. Five checks: ① all `filesToCreate` files exist, ② server file contains listen declaration, ③ test file contains assertions, ④ runtime frameworks not in `devDependencies` (exact match, avoids `@types/express` false positive), ⑤ Dockerfile first line is a valid instruction. Missing-file failures route to `coder`; other failures route to `qa`.
- **qa**: Analyzes `testResults` via LLM, maintains `issueTracker` (id-dedup across rounds). Static regex extracts failing test files from `FAIL tests/xxx.test.ts` lines (reliable fallback). If LLM returns empty issues but tests still fail, preserves existing open issues to prevent empty-`failedFiles` death loop. Updates `consensusProgress.openIssues`.
- **deploy**: Starts the production server inside the container (`docker exec -d`). Health-checks the mapped port from the host.
- **post_mortem**: PM agent summarizes lessons learned, appended to `KNOWLEDGE.md`.
- **persistence**: Archives all artifacts in `workspace/run_<timestamp>/`; auto-prunes old runs (keeps latest 10). On success: prints container name, access URL, and management commands. On failure: `docker rm -f` cleans up the container.

### Core layer (`src/core/`)

- **`agent.ts`** — `BaseAgent`: wraps a LangChain model with a persona (`AgentPersona`), system prompt, optional tool list, and memory injection from `KNOWLEDGE.md`.
- **`skill.ts`** — `Skill<T>`: generic skill wrapper using Zod for input schema; converts to `DynamicStructuredTool` for LangChain.
- **`graph.ts`** — `createJimClawGraph()`: the complete state machine (~1100 lines). Defines all state types and node logic. Contains module-level helper `execInContainer(id, cmd, opts)` for routing shell commands through Docker.

### State types (`src/core/graph_types.ts`)

| Type | Description |
|------|-------------|
| `TaskContract` | PM output: title, requirements, acceptanceCriteria |
| `TechSpec` | Architect output: language, framework, testCommand, runCommand, entryPoint, filesToCreate, dependencies, devDependencies |
| `SystemManifest` | Services (name, port), environment variables |
| `ApiContract` | Endpoint definitions (path, method, request/response shapes) |
| `SubTask` | File-scoped dev task with status and lastError |
| `MediationDirective` | Architect arbitration instruction: file, action, detail |
| `FixPlanItem` | QA-Coder negotiated fix for one file: diagnosis, proposedChange, qaApproval, qaFeedback |
| `FileChangeEntry` | Per-file write record (round, file, status, error) for frontend display |
| `ConsensusCore` | Permanent project identity: title, requirements, architectureSummary, techStack, framework, port, coreDependencies, coreDevDependencies, criticalDecisions |
| `ConsensusProgress` | Round-updated snapshot: completedFiles, pendingFiles, currentRound, openIssues |
| `MeetingNote` | Per-phase summary (≤80 chars) + pointer to full content file under `workspace/nodes/` |
| `JimClawState` | Full graph state: all above + retryCount, mediationDirectives, **fixPlan**, qaFailures, packageJsonHash, **containerId**, projectBrief (legacy), codeLog, **consensusCore**, **consensusProgress**, **meetingNotes** |

### Agents (`src/agents/team.ts`)

Four personas, each with a fixed model assignment in `jimclaw.config.json`:

| Agent | Persona | Model key | Skills (按需注入) |
|-------|---------|-----------|-----------------|
| PM (观止) | Product Manager | `anthropic_strong` | `[]` |
| Architect (独孤) | Software Architect | `anthropic_strong` | `[FileRead, GetServerIP, FindFreePort, WebSearch, WebFetch, ReadMeetingNote]` |
| Coder (星河) | Full-stack Dev | `minmax` | `[FileRead, FileWrite, LintFix, LSPDiagnose, WebSearch, WebFetch, ReadMeetingNote]` |
| QA (清扬) | Test Engineer | `glm` | `[FileRead, Shell, ReadMeetingNote]` |

> QA now has `FileRead` and `ReadMeetingNote` to support the `fix_plan` negotiation step, where QA reads failing files before approving/correcting Coder's proposed fix.

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
| `web_search` | `web_search.ts` | Web search for up-to-date docs and solutions |
| `web_fetch` | `web_fetch.ts` | Fetch content from a URL |
| `read_meeting_note` | `read_meeting_note.ts` | Read full meeting note content by ID from `workspace/nodes/` |
| `find_free_port` | `find_free_port.ts` | Scan for an available host port (used by architect) |
| `get_server_ip` | `get_server_ip.ts` | Get the server's real IP address (used by architect) |

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
- `mediationDirectives` is refreshed every 3 rounds (`retryCount` = 2, 5, 8, …). Each mediation sees previous directives + their outcome, enabling course-correction. After mediation, routes directly to `coder` (bypasses `fix_plan`).
- `fixPlan` is set by `fix_plan` node each retry round (non-mediation rounds). Coder always uses the agreed plan instead of self-guessing the fix approach.
- `containerId` is set by `infra_setup` and persists in state for all downstream nodes. Never hardcode container names — derive from `path.basename(WORKSPACE)`.
- `fix_plan` node writes `note-fixplan-r{N}`; `architect_mediation` writes `note-mediation-r{N}`. Both are visible in `meetingNotes` for subsequent agents.

### 三层共识系统（Team Consensus）

System prompts are built by `buildSystemContext(state)` in `src/core/logic_utils.ts`, **not** by reading `projectBrief` directly. The three layers are:

1. **`consensusCore`** (permanent) — set by `pm` (partial: title + requirements) then completed by `architect` (architectureSummary, techStack, framework, port, coreDependencies, coreDevDependencies); `architect_mediation` appends to `criticalDecisions`. Never reset between rounds.
2. **`consensusProgress`** (updated each round) — `architect` sets initial `pendingFiles`; `orchestrator` updates from subTasks; `coder` updates `completedFiles/pendingFiles`; `qa` updates `openIssues` (one-liner summaries of open issues).
3. **`meetingNotes`** (append-only, id-dedup) — each node writes a short `summary` (≤80 chars, always in prompt) and a full `.md` file to `workspace/nodes/{id}.md`. Agents (Architect, Coder, QA) can call `read_meeting_note(note_id)` to fetch full content on demand.

Note IDs follow the pattern `note-{phase}-r{round}`:

| Phase | Note ID pattern | Written by |
|-------|----------------|------------|
| pm | `note-pm-r0` | pm_node |
| architect | `note-architect-r0` | architect_node |
| orchestrator | `note-orchestrator-r0` | orchestrator_node |
| coder | `note-coder-r{N}` | coder_node (each retry) |
| qa | `note-qa-r{N}` | qa_node (each retry) |
| fix_plan | `note-fixplan-r{N}` | fix_plan_node (each retry) |
| mediation | `note-mediation-r{N}` | architect_mediation_node |

`projectBrief: ConsensusEntry[]` is retained in state for backward compatibility but nodes no longer write new content to it.

### QA-Coder 协商回路（fix_plan）

The core feedback loop that prevents blind retries:

```
qa → fix_plan → coder
      │
      ├─ Step 1: Coder reads failing files, states:
      │          • Root-cause understanding
      │          • Exact proposed change (line/method level)
      │          • Confidence (high/medium/low)
      │
      └─ Step 2: QA reviews each item:
                 • approved: Coder understood correctly, proceed
                 • corrected: QA provides the real root cause + fix direction
                 + adds any missed files
                 → produces fixPlan[] stored in state

coder (next): reads fixPlan, executes approved/corrected instructions
              instead of self-guessing from issueTracker titles
```

This eliminates the most common failure mode: Coder misattributes a test failure to the wrong file and rewrites correct code for 5+ rounds.

## Core Philosophy

1.  **Language Agnostic**: JimClaw must handle all languages (TS, Python, Go, etc.) equally. Never write logic that only works for JavaScript.
2.  **Skill-First Action**: If a task can be done via a Skill (e.g., finding a port, diagnosing code), the Agent MUST use that tool instead of the system making a "guess".
3.  **Zero Log Swallowing**: Every thought, every tool output (including errors), and every raw prompt must be persisted to the `audit/` directory. Never hide failures.
4.  **End-to-End Dynamic Ports**: Never assume or hardcode ports (like 3000 or 8080). Use `find_free_port` to discover available ports and lock them into the `manifest` contract.

## 编码约束（对 AI 助手强制执行）

### 1. 必须使用中文
- 所有面向用户的输出、注释、日志消息、提示词（prompt）、团队对话消息均须使用中文
- 代码标识符（变量名、函数名、接口名）和技术术语保持英文，遵循工程惯例

### 2. 禁止硬编码（文件名、扩展名、端口等）
以下内容**绝对不允许**在代码中硬编码，必须从运行时状态动态获取：

| 禁止硬编码的内容 | 正确做法 |
|----------------|---------|
| 文件名 `"server.js"` | 从 `state.subTasks` 提取 |
| 文件扩展名 `.js` / `.ts` | 从 `spec.language` 或 `task.fileTarget` 动态判断 |
| 内部/外部端口号 | **必须调用 `find_free_port` 探测，并从 `manifest.services[0].port` 获取** |
| 测试命令 | 从 `spec.testCommand` 获取 |
| 运行命令 | 从 `spec.runCommand` 获取 |
| 入口点 URL | 从 `deploymentStatus.url` 获取 |
| 容器名称 | 从 `\`jimclaw_${path.basename(WORKSPACE)}\`` 动态构造 |

正确示例：
```typescript
// ✅ 正确：从 manifest 获取架构师探测出的真实端口
const APP_PORT = state.manifest?.services?.[0]?.port || 8080;

// ✅ 正确：从 spec 获取测试命令（在容器内执行）
await execInContainer(state.containerId, `NODE_ENV=test ${state.spec.testCommand}`);
```
