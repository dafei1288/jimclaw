# JimClaw × Sisyphus：从 oh-my-opencode 借鉴的设计精髓

> 文档日期：2026-03-03
> 参考项目：[oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)

---

## 一、背景

oh-my-opencode 是对 opencode / Claude Code 的增强封装，其核心是 **Sisyphus 协议**——名字来自希腊神话中永无止境推石头的西西弗斯，象征 Agent 必须"执着到完成"，不能在 stub 代码或半成品状态下声称任务完成。

调研后提炼出三条对 JimClaw 最有价值的设计原则：

| 原则 | oh-my-opencode 实现 | JimClaw 原有问题 |
|------|---------------------|-----------------|
| **执着完成** | Ralph Loop + todo-enforcer：扫描未完成标记，强制续行 | Coder 写完文件即返回，不验证内容是否真正完整 |
| **独立验证** | Atlas 节点：永不信任子 Agent 声称的结果，独立读文件核实 | QA 跑测试失败了才知道有问题，缺乏预检机制 |
| **按需上下文** | 工具/MCP 按 Agent 职责选择性注入，Context 保持清洁 | Agent 工具集未按职责裁剪 |

---

## 二、Ralph Loop 原理

oh-my-opencode 的 Ralph Loop 是一个**持续压迫机制**：

```
while (!allTodosCompleted):
    向 Agent 注入系统提醒：
      "你不能声称完成，直到所有 todo 标记为已完成。
       已完成：N  待做：M  必须现在就完成剩余工作！"

    等待 Agent 响应

    if still incomplete:
        指数退避：首次 30s，第N次 30s × 2^(N-1)
        连续 5 次失败后 → 升级到最强模型（Oracle）
```

**核心洞见**：Agent 最常见的失败模式是"自欺欺人地声称完成"（交出 stub 代码，声称 TODO 之后处理）。Ralph Loop 通过系统级强制检查堵死这条退路。

---

## 三、三个具体改动

### 改动 A：Todo-Enforcer（对标 Ralph Loop）

**位置**：`src/core/graph.ts` — Coder 节点内部循环，文件写入后、`filePassed = true` 之前

**原理**：扫描写入代码中的未完成标记，发现则强制重写：

```typescript
const INCOMPLETE_MARKERS = [
  /\/\/\s*TODO/i,
  /\/\/\s*FIXME/i,
  /throw new Error\(['"]not implemented/i,
  /\/\*\s*placeholder/i,
];

const hasIncomplete = INCOMPLETE_MARKERS.some(r => r.test(code));
if (hasIncomplete && fileRetryCount < 2) {
  task.lastError = "文件包含未完成标记（TODO/FIXME），必须补全后才能提交";
  fileRetryCount++;
  continue;
}
```

**效果**：Coder 不能交 stub 代码就走人，必须真正完成每个函数。

---

### 改动 B：Pre-QA Verifier（对标 Atlas 独立验证）

**位置**：`src/core/graph.ts` — 新节点 `verifier`，插在 `terminal` → `qa` 之间

**工作流变化**：
```
旧：terminal → qa
新：terminal → verifier → qa
                  ↓ 发现硬伤（不调 LLM，秒级）
               coder（直接重写，跳过 terminal）
```

**四项检查**（纯代码扫描，不调 LLM）：

| 检查项 | 失败时的含义 |
|--------|-------------|
| filesToCreate 中所有文件真实存在 | Coder 漏写了某个文件 |
| server 文件 require/import 的包都在 `dependencies`（非 devDependencies） | 运行时会 Cannot find module |
| server 文件包含 `app.listen()` | 服务器启动后立即退出 |
| 测试文件包含实际断言（assert./expect()） | 测试是空壳，永远通过 |

**快速失败路由**：发现问题 → 直接构造 `qaFailures` → 路由回 Coder，省掉无效的测试轮次。

---

### 改动 C：Skills 按需注入（对标 On-demand MCP）

**位置**：`src/agents/team.ts`

**原则**：每个 Agent 只获得完成其职责所需的最小工具集。

| Agent | 之前 | 修改后 |
|-------|------|--------|
| PM（观止） | `[]` | `[]`（不变，已经合理） |
| Architect（独孤） | `[FileRead, GetServerIP, FindFreePort]` | 不变 |
| Coder（星河） | `[FileRead, FileWrite, LintFix, LSPDiagnose]` | 不变，已合理 |
| QA（清扬） | `[FileRead, Shell, Docker, Playwright, HealthCheck]` | 移除 Docker、HealthCheck（这两个在 graph.ts 里直接调用，不通过 agent tool） |

---

## 四、不建议现在实现的

| 特性 | 原因 |
|------|------|
| **Hash-Anchored Edits**（带来 58.6% 成功率提升） | JimClaw 已有 LSP 诊断 + 精准修复 patch 兜底，短期优先级低 |
| **Category-based model routing** | 任务范畴→最优模型自适应分配，需要充分模型评测数据支撑 |
| **Boulder state 跨会话持久化** | KNOWLEDGE.md 已部分满足；完整实现需要状态快照机制 |
| **11 Agent 专科分工** | JimClaw 的 4 角色已够用；过多 Agent 增加编排复杂度 |

---

## 五、影响评估

| 改动 | 解决的问题 | 复杂度 |
|------|-----------|--------|
| A: Todo-Enforcer | 防止 stub 代码进入 QA，减少无效 retry 轮次 | 低（~15 行） |
| B: Pre-QA Verifier | 快速拦截"缺文件/缺依赖/无 listen/空测试"，省掉整轮测试 | 中（新节点 ~60 行） |
| C: Skills 裁剪 | 减少 QA Agent context，提升专注度 | 低（删 2 行） |
