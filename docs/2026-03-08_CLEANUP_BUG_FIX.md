# 容器清理漏洞修复记录

**日期**：2026-03-08
**问题级别**：P0（阻断知识积累 + 资源泄漏）

---

## 一、问题现象

历史运行记录（workspace/run_*）中，仅 2/13 次运行生成了 `session.json`，其余运行均以"无声失败"结束：

- 容器不会被清理，残留在 `docker ps` 中持续占用端口
- `KNOWLEDGE.md` 从未生成，系统无法在任务间积累经验
- Web 看板显示 `Error`，但无具体错误原因

## 二、根本原因分析

### 原因 1：LangGraph stream 异常时直接中断

图中任何节点（`qa`、`deploy` 等）抛出未捕获异常时，LangGraph 的 stream 会立即终止。由于 `post_mortem` 和 `persistence` 排在流程末尾，**它们根本不会被执行**，容器清理逻辑也因此失效。

```
图执行失败
    ↓
stream 抛出异常
    ↓
server.ts / tui.ts 的 catch 块：只打印日志，无清理
    ↓
容器孤立，session.json 未写入，KNOWLEDGE.md 未更新
```

### 原因 2：`post_mortem` 节点的 LLM 调用无保护

```typescript
// 修复前：LLM 失败 → 整个节点崩溃 → persistence 不执行
const response = await agents.pm.chat(...);  // 无 try-catch
```

若 LLM API 超时或返回异常，`post_mortem` 节点本身崩溃，`persistence` 节点无法执行。

### 原因 3：`persistence` 中序列化先于容器清理

```typescript
// 修复前
JSON.stringify(state, null, 2)   // ← 可能崩溃（BaseMessage 等复杂对象）
docker rm -f containerId         // ← 从未执行
```

`state.messages` 包含 LangChain `BaseMessage[]` 对象，完整序列化时可能失败，导致容器清理代码永远无法到达。

### 原因 4：`lessons_learned` 从未持久化（设计缺陷）

`post_mortem` 生成的经验教训仅 `console.log`，从未写入 `KNOWLEDGE.md`，即便流程成功完成，知识也白白丢失。

---

## 三、修复方案

### 修复 1：调用层兜底清理（`server.ts` / `tui.ts`）

在 stream 消费循环外追踪 `containerId`，在 `catch` 块中执行兜底清理：

```typescript
// server.ts
let trackedContainerId: string | null = null;  // 声明在 try 外部
try {
  // ...
  for await (const chunk of stream) {
    if (stateUpdate.containerId) trackedContainerId = stateUpdate.containerId;
    // ...
  }
} catch (error) {
  if (trackedContainerId) {
    await exec(`docker rm -f ${trackedContainerId} 2>/dev/null || true`);
  }
}
```

**关键细节**：`let` 必须声明在 `try` 块**外部**，否则 `catch` 块因块级作用域无法访问该变量。

### 修复 2：`post_mortem` 节点全局 try-catch

```typescript
.addNode("post_mortem", async (state) => {
  try {
    // ... LLM 调用、KNOWLEDGE.md 写入
    return { teamChatLog: [...] };
  } catch (e) {
    // 降级：不依赖 LLM，直接写入原始错误信息
    await fs.appendFile(knowledgePath, `错误记录: ${e}`);
    return { teamChatLog: [{ sender: ..., content: "复盘失败，已记录基础信息" }] };
  }
})
```

无论 LLM 是否成功，节点始终返回有效状态，`persistence` 节点可以正常执行。

### 修复 3：`persistence` 执行顺序调整 + 安全序列化

```typescript
.addNode("persistence", async (state) => {
  // ① 优先处理容器（最关键，必须最先执行）
  if (state.containerId) {
    if (isDeployed) { /* 打印访问信息 */ }
    else { await docker_rm_f(state.containerId); }  // 带 try-catch
  }

  // ② 安全序列化（排除 BaseMessage 等复杂对象）
  try {
    const snapshot = {
      userGoal, retryCount, isDone, contract, spec,
      manifest, subTasks, qaFailures, teamChatLog, codeLog
      // 不包含 messages: BaseMessage[]
    };
    await fs.writeFile("session.json", JSON.stringify(snapshot));
  } catch (e) { console.warn(e); }

  // ③ 清理旧 run 目录
  // ...
})
```

### 修复 4：`lessons_learned` 持久化

每次 `post_mortem` 成功或失败，均将结果追加到 `KNOWLEDGE.md`：

```
## 经验教训
时间: 2026-03-08T...
任务: 图书馆管理系统开发
结果: ❌ 失败 | 重试次数: 5

- 成功因素: ...
- 失败因素: ...
- 改进建议: ...
```

---

## 四、修复后的清理保障层次

```
第一层：persistence 节点（正常流程）
    → 容器清理在 session.json 写入之前执行

第二层：post_mortem try-catch（节点异常降级）
    → post_mortem LLM 失败时，persistence 仍可执行

第三层：server.ts / tui.ts catch（图执行崩溃）
    → 任意节点崩溃导致 stream 中断时，调用层执行兜底清理
```

---

## 五、涉及文件

| 文件 | 修改内容 |
|------|---------|
| `src/server.ts` | `trackedContainerId` 追踪 + catch 兜底清理 |
| `src/tui.ts` | 同上 |
| `src/core/graph.ts` | `post_mortem` 全局 try-catch + KNOWLEDGE.md 持久化；`persistence` 执行顺序调整 + 安全序列化 |
