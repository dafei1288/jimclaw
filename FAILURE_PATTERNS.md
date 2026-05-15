# 失败模式库（Failure Patterns）

> JimClaw 内部 agents + 外部 assistant 共同维护。每条 pattern 格式固定，agent 可程序化消费。
> 
> 命名规范：`FP-{NNN}`。标签用于自动匹配相关 pattern 注入 agent prompt。

---

## FP-001: npm scripts 在 Docker `sh -c` 中找不到命令

- **症状**: `sh: xxx: not found` (exit code 127)
- **根因**: `npm run <script>` 通过 `sh -c` 执行时，`node_modules/.bin` 不在 PATH。在非 Node 基础镜像（maven、golang、python）中更常见，因为这些镜像没有 Node 的全局 PATH 配置。
- **影响范围**: 所有混合项目（后端非 Node + 前端 Vue/React）
- **修复**: 用 `npx <cmd>` 代替裸命令，或在 `npm run build` 前加 `PATH=./node_modules/.bin:$PATH`
- **预防**: `infra_node` 的前端 build 命令始终用 `npx` 前缀
- **首次发现**: 2026-04-10, `run_1775806547907`
- **标签**: `docker`, `npm`, `frontend`, `exit-127`, `infra`

---

## FP-002: verifier 把配置文件误判为测试文件

- **症状**: `vitest.config.ts 未找到断言语句（如 expect()、assert.）`
- **根因**: 文件名含 `test`（如 `vitest.config.ts`、`jest.config.ts`）被 `testFilePatterns` 正则匹配
- **修复**: `nonTestFiles` 排除列表扩展到包含 `vitest.config.*`、`vite.config.*`、`jest.config.*`
- **预防**: 每次新增配置文件格式时同步更新 `nonTestFiles`
- **首次发现**: 2026-04-10
- **标签**: `verifier`, `config-file`, `false-positive`

---

## FP-003: 非 Node 项目 `ensureRequirementDrivenFiles` 直接返回空

- **症状**: Java/Python/Go/Rust 项目缺少测试文件，Maven 报 `No tests to run`
- **根因**: `ensureRequirementDrivenFiles()` 检测到非 Node 语言后直接 `return`，跳过了所有文件注入逻辑（包括测试文件）
- **修复**: 为 Java/Python/Go/Rust 各自添加基础文件注入分支
- **预防**: 修改通用函数时检查所有分支
- **首次发现**: 2026-04-10, `run_1775804713445`
- **标签**: `architect`, `filesToCreate`, `multi-language`, `logic-utils`

---

## FP-004: Python conftest.py 使用 httpx 导致 FastAPI async handler 测试失败

- **症状**: `ClientState.UNOPENED` 错误，8/8 tests ERROR at setup
- **根因**: `httpx.Client` + `ASGITransport` 不兼容 FastAPI async handler
- **修复**: 改用 `starlette.testclient.TestClient`（同步封装，最简单可靠）
- **预防**: Python scaffold 的 conftest.py 固定使用 `TestClient`
- **首次发现**: 2026-04-10
- **标签**: `python`, `fastapi`, `testing`, `conftest`

---

## FP-005: pytest.ini 含 asyncio_mode=auto 但未安装 pytest-asyncio

- **症状**: `PytestConfigWarning: unknown config option: asyncio_mode`
- **根因**: scaffold 生成的 `pytest.ini` 包含了非异步项目不需要的配置
- **修复**: 移除 `asyncio_mode=auto`
- **预防**: 只在检测到 async 需求时才注入 pytest-asyncio 配置
- **首次发现**: 2026-04-10
- **标签**: `python`, `pytest`, `config-file`

---

## FP-006: ts-node 10.9.2 + TypeScript 5.9.3 的 Debug Failure

- **症状**: `Debug Failure. Output generation failed` — ts-node 的 `transpileModule` 偶发编译器断言错误
- **根因**: ts-node 10.9.2 与 TypeScript 5.9.3 的兼容性问题（不是模型 API 问题）
- **修复**: 在 `transpileModule` 调用周围加 try-catch，不崩溃整个 coder_node
- **预防**: 此为外部依赖问题，无法根治。缓解措施：try-catch + retry + 预写入阶段减少编译次数
- **首次发现**: 2026-04-10
- **标签**: `ts-node`, `typescript`, `runtime-crash`, `external-dep`

---

## FP-007: infra build 失败被静默吞掉

- **症状**: 前端 `npm run build` 失败 (exit 127)，但流程继续走到 deploy，用户看到 404
- **根因**: `infra_node` 中 `isCommandFailureOutput` 只匹配 `Command failed with exit code \d+` 格式，不匹配 stderr 中的错误。错误被 try-catch 吞掉后 infra 继续。
- **修复**: (1) build 失败必须终止流程 (2) 增加 `post_deploy_verify` 节点
- **预防**: **infra 阶段的任何 build 失败都应终止**。宁可 false positive，不要 false negative。
- **首次发现**: 2026-04-10, `run_1775806547907`
- **标签**: `infra`, `build`, `silent-failure`, `critical`

---

## FP-008: QA 验证盲区 — 不检查部署后服务

- **症状**: 后端 API 通过但前端页面 404，QA 不报错
- **根因**: QA 只分析 `testResults` 文本，从不实际访问部署的服务。前端 build 失败在 QA 视野之外。
- **修复**: 增加 `post_deploy_verify` 节点，在 deploy 后对所有用户可见端点做 HTTP 检查
- **预防**: 质量验证不能只看单元测试输出，必须有端到端可达性验证
- **首次发现**: 2026-04-10
- **标签**: `qa`, `deploy`, `verification`, `critical`

---

## FP-009: Java/Rust TechSpec 缺 Zod 必填字段

- **症状**: `ZodError` — `dependencies`/`devDependencies` 为 `[]` 而非 `{}`，缺 `architecture`/`interfaces`
- **根因**: 确定性快速路径直接构造对象，未对齐 `TechSpecSchema` 的字段类型要求
- **修复**: 补全所有必填字段
- **预防**: 新增确定性 builder 时，用 Zod schema 验证输出
- **首次发现**: 2026-04-10
- **标签**: `architect`, `zod`, `schema`, `multi-language`

---

## FP-010: 混合项目 orchestrator 注入多余 public/index.html

- **症状**: 混合项目（Vue + Java）的 filesToCreate 中同时有 `public/index.html` 和 `frontend/index.html`
- **根因**: orchestrator 的通用逻辑检测到 `frontendRequired` 就注入 `public/index.html`，没检查是否已有 `frontend/` 目录
- **修复**: 当 `spec.frontend` 存在时跳过 `public/index.html` 注入
- **预防**: 混合项目的前端文件全部在 `frontend/` 子目录
- **首次发现**: 2026-04-10
- **标签**: `orchestrator`, `mixed-project`, `duplicate-file`

---

## FP-011: vite.config.ts 含硬编码占位符

- **症状**: 前端 proxy target 为 `http://localhost:__BACKEND_PORT__`
- **根因**: scaffold 模板使用了占位符，运行时没替换
- **修复**: `buildFrontendFiles()` 中用实际端口替换占位符
- **预防**: scaffold 模板中的占位符必须有对应的替换逻辑
- **首次发现**: 2026-04-10
- **标签**: `scaffold`, `frontend`, `placeholder`, `mixed-project`

---

## FP-012: Docker 容器重建导致所有依赖重装

- **症状**: 混合项目 retry 时 15+ 分钟重建容器（重新安装 Maven 依赖 + Node.js + npm）
- **根因**: infra_node 在 retry 时 `docker rm -f` 再 `docker run`，缓存卷只能缓解部分问题
- **修复**: (已部分缓解) 缓存卷 + 容器复用检查。根本解决需要持久化构建缓存层
- **预防**: infra_node 优先复用现有容器
- **首次发现**: 2026-04-10
- **标签**: `docker`, `infra`, `performance`, `mixed-project`

---

## FP-013: agent_pending 重试正则与 isAgentRecoveryError 不同步

- **症状**: `withNodeGuard` 识别 `Debug Failure` 为可恢复 → `agent_pending`，但 `isRetryable` 正则不匹配，导致 agent_pending 立即放弃
- **根因**: 两处正则表达式各自维护，新增错误类型时只改了一处
- **修复**: 两处正则同步更新
- **预防**: `isRetryable` 正则应直接引用 `isAgentRecoveryError` 的 pattern，或统一为一处定义
- **首次发现**: 2026-04-10
- **标签**: `agent-pending`, `regex`, `sync-bug`, `graph`

---

## FP-014: conftest.py/pytest.ini 被 QA 标记后走 LLM 重写导致死循环

- **症状**: QA 标记 conftest.py 失败 → coder 用 LLM 重写 → 代码提取失败 → QA 再标记 → 循环
- **根因**: 配置文件太短，LLM 代码提取容易失败
- **修复**: 加入 `isStructuralConfigFile()` 保护，QA 标记失败后始终用 scaffold 内容
- **预防**: 小型配置文件不应走 LLM 重写路径
- **首次发现**: 2026-04-10
- **标签**: `coder`, `qa`, `config-file`, `death-loop`

---

## FP-015: 宣布成功前不验证实际用户体验

- **症状**: 只检查 `curl /api/health` 返回 200 就宣布成功，用户访问 `http://host:port/` 得到 404
- **根因**: 没有标准化的验证清单，验证者凭感觉检查
- **修复**: 建立 LESSONS.md 中的验证清单 + post_deploy_verify 节点
- **预防**: 每次宣布成功前必须执行完整验证清单
- **首次发现**: 2026-04-10
- **标签**: `process`, `verification`, `critical`, `meta`

---

## FP-016: 项目创建语义被误判为资源写接口

- **症状**: 用户只要求 `GET /products` 和 `GET /api/products`，但 `apiContract` / `executionProtocol` / 前端页面被扩展出 `POST/PUT/DELETE /api/products`，页面出现新增、编辑、删除控件。
- **根因**: 写意图识别把“创建一个商品目录应用”中的“创建……应用”误判为“创建商品记录”；同时 `contract_sync` 修改 `apiContract` 后没有同步重建 `solutionProtocol` / `executionProtocol`，导致协议层漂移。
- **修复**: `ensureRequirementDrivenApiContract()` 按句段区分项目创建与实体创建；`contract_sync` 对 LLM 审查后的契约再次执行需求裁剪，并同步重建下游协议。
- **预防**: smoke 必须同时核对 `apiContract`、`executionProtocol.contracts.api`、`executionProtocol.contracts.frontend.apiUsage` 与生成页面控件，不能只看部署 200。
- **首次发现**: 2026-05-15, `run_1778782372300`
- **标签**: `api-contract`, `contract-sync`, `frontend`, `intent-detection`, `contract-drift`

---

## FP-017: agent_pending 在图内自旋导致无法恢复

- **症状**: Coder 模型连接失败后进入 `agent_pending`，但图内自动重试到耗尽并清空 `agentRecoveryPending`，最终状态不再可 `--resume`。
- **根因**: `agent_pending` 节点承担了“等待恢复”和“自动重试”两个职责，覆盖了 `withNodeGuard` 已落盘的恢复状态；同时相关回放测试仍按控制面设计预期挂起。
- **修复**: `agent_pending` 只保存并保留恢复状态，然后结束当前图执行；恢复动作交给 CLI/Web 的 resume 流程。
- **预防**: `agent_pending` 必须是持久化暂停点，不应在图内部循环清空 `agentRecoveryPending`。
- **首次发现**: 2026-05-15, managed harness focused suite
- **标签**: `agent-pending`, `resume`, `graph`, `control-plane`

---

## FP-018: 小项目跳过契约校验导致 import 漂移

- **症状**: 小型项目中 Coder 可以导入未导出的符号，或让 model 层依赖 controller 层，任务仍被标记为 completed。
- **根因**: import/export 校验和 ExecutionProtocol 角色依赖校验在文件数 ≤15 时被跳过，导致最常见的 MVP 项目反而缺少契约保护。
- **修复**: 移除小项目跳过逻辑，所有规模都执行导出契约与协议角色校验；同时 authRequired 场景保留最小 auth route/test，保证认证能力可验收。
- **预防**: 性能优化不能关闭契约校验；如需降噪，应按明确的协议例外处理，而不是按文件数量跳过。
- **首次发现**: 2026-05-15, `tests/core/coder-node.test.js`
- **标签**: `coder`, `execution-protocol`, `import-contract`, `auth`, `small-project`

---

## FP-019: ReleaseGate 不识别 HTML HTTP 证据

- **症状**: Evaluator 已经通过 `GET /products` 并拿到 HTML 响应，但 ReleaseGate 仍报“前端验收缺少 UI 证据”；另一个风险是只有 `/api/health` 通过也可能被放行。
- **根因**: UI evidence 只识别 screenshot/trace/playwright 关键词，没有把页面 GET 的 HTML 响应作为 UI 证据；同时 ReleaseGate 没有逐一检查 `apiContract` 中公开 GET 端点是否都有 passing HTTP evidence。
- **修复**: 将非 `/api/*` 页面端点的 HTML 响应纳入 UI evidence；ReleaseGate 要求所有公开 GET 端点都有 evaluator passing evidence。
- **预防**: release gate 的放行条件必须绑定具体端点 evidence，不能只看 sprint pass 或 health check。
- **首次发现**: 2026-05-15, `run_1778807069282`
- **标签**: `release-gate`, `evaluator`, `ui-evidence`, `health-only`, `endpoint-coverage`

---

## FP-020: Evaluator 修复范围未与 SprintContract 取交集

- **症状**: Evaluator 的 failed check 同时怀疑 sprint 内文件和 sprint 外文件时，修复计划可能把越界文件纳入 `repairScope`，Coder 后续容易追错文件或破坏其他智能体边界。
- **根因**: `repairContract` 直接合并 `suspectedFiles`、失败文件和 `fixPlan` 文件，没有和 active `SprintContract.agreedScope.allowedFiles` 做交集；共享上下文也没有展示 failed check、复现步骤和 allowed repair files。
- **修复**: 生成 `RepairContract` 时保存 `failedChecks`、`reproSteps`、`suspectedFiles`、`allowedRepairFiles`、`rerunChecks`，并将 `repairScope` 限定为 active sprint 允许文件；`buildSystemContext()` 注入 `[修复契约]` 摘要。
- **预防**: evaluator 驱动的修复必须先绑定 failed check，再通过 SprintContract 做边界裁剪；禁止只按 QA issue title 盲修。
- **首次发现**: 2026-05-15, Task 6 managed harness regression
- **标签**: `evaluator`, `repair-contract`, `sprint-contract`, `fix-plan`, `scope-control`

---

## FP-021: Express app 模块被误标为 other 导致 route 挂载被拦截

- **症状**: Coder 写出 `src/app.ts` 并 `import productsRouter from "./routes/products"` 后，执行协议校验报 `src/app.ts(other) 不允许依赖 src/routes/products.ts(route)`；修复后又出现 `src/index.ts(entry) 不允许依赖 src/app.ts(entry)`，流程进入 QA/fix_plan 盲修代码。
- **根因**: `inferProtocolFileRole()` 只把 `src/index.ts` 识别为 `entry`，没有把常见 Express 应用模块 `src/app.ts` / `src/server.ts` 识别为可挂载 route 的入口类文件；同时 `entry` 角色不允许依赖另一个 `entry`，误伤 `index.listen(app)` 结构。
- **修复**: 将 `src/app.ts`、`src/app.js`、`src/server.ts`、`src/server.js` 归类为 `entry`，继承 entry 对 route/controller/service/middleware 的合法依赖；允许 `entry` 依赖 `entry`。
- **预防**: 协议角色校验拦截前，必须先确认 role inference 覆盖主流框架入口命名；smoke 中的协议阻塞应优先判断是不是规划/协议错误，而不是默认让 Coder 改代码。
- **首次发现**: 2026-05-15, `run_1778811083795`
- **标签**: `execution-protocol`, `express`, `role-inference`, `coder`, `smoke`
