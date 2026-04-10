# 操作经验教训（外部 Assistant 维护）

> 每次 session 开始时阅读此文件。宣布"成功"前必须通过所有验证清单。

## L-001: 永远不要只验证 API 端点就宣布成功

- **日期**: 2026-04-10
- **事件**: 混合项目 E2E，后端 `/api/health` 返回 200，我宣布成功。用户访问 `http://host:port/` 得到 404——前端根本没部署。
- **根因**: `vite build` 失败 (exit 127) 被 infra_node 静默忽略，我也没有读 audit 日志。
- **验证清单（E2E 跑完后必须全部执行）**:
  1. 读 `audit/Infrastructure.md` — 搜索 `exit code`、`not found`、`Critical Error`
  2. 读 `audit/Terminal.md` — 确认测试结果
  3. 对所有公开端点执行 `curl`（不只是 health check）
  4. 混合项目：`curl http://host:port/` 必须返回 HTML（不是 404/JSON）
  5. `docker exec` 确认 build 产物存在（`dist/`、`static/`）
  6. boulder.json 中 `testResults` 不含未解释的错误

## L-002: 修改 infra/terminal/verifier 后必须检查 audit 日志

- **教训**: 基础设施修改的效果只体现在 `audit/` 目录。代码改了但运行时行为可能不同。
- **验证**: E2E 跑完后，先读 `audit/Infrastructure.md` 和 `audit/Terminal.md`，再下结论。

## L-003: 同一 bug 在不同语言/框架上可能变体存在

- **事件**: `ensureRequirementDrivenFiles` 中 Node 项目有完整文件注入，但 Java/Python/Go/Rust 被一行 `return` 跳过。
- **教训**: 修改一个通用函数时，必须检查**所有分支**（不是只看当前任务相关的分支）。
- **检查方法**: `grep` 所有使用该函数的地方，逐一确认。

## L-004: "非致命错误"往往是致命的

- **事件**: infra_node 中 `npm run build` 失败被 `try-catch` 吞掉，流程继续走完 deploy → persistence。
- **教训**: infra 阶段的任何 build 失败都应终止流程。build 产物缺失 = 服务不完整 = 失败。
- **原则**: 宁可多报失败（false positive），不要静默吞错（false negative）。

## L-005: `execInContainer` 用 `sh -c` 时 `node_modules/.bin` 不在 PATH

- **事件**: `npm run build` 内部调用 `vite`，但 `sh -c` 环境下 `node_modules/.bin` 不在 PATH。
- **修复**: 前端 build 命令用 `cd frontend && npx vite build` 代替 `cd frontend && npm run build`。
- **适用范围**: 所有在非 Node 基础镜像（maven、golang、python）中运行前端 build 的场景。

## L-006: QA 的验证范围有系统性盲区

- **事件**: QA 只分析 `testResults` 文本，从不检查部署后的服务可用性。前端 404、build 失败在 QA 视野之外。
- **教训**: 不能依赖 QA 作为唯一的质量守门人。必须有部署后自动验证（post_deploy_verify）。
