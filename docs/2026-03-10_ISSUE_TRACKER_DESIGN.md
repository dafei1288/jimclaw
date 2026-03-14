# JimClaw 智能缺陷追踪系统 (Issue Tracker) 详细设计方案

**日期**: 2026-03-10
**版本**: v1.0
**状态**: 方案已确立，准备执行

## 1. 背景与现状分析
目前 JimClaw 的质量反馈机制极其脆弱，存在以下致命问题：
- **信息过载与失真**: QA 节点仅机械地搬运终端报错堆栈，没有对问题进行提炼，导致 Coder 面对冗长的日志无法定位核心矛盾。
- **缺乏持久化追踪**: 之前的报错信息在每轮重试中会被简单覆盖，系统没有“历史记忆”，容易导致问题反复出现。
- **缺乏优先级意识**: 系统无法区分“导致程序崩溃的致命 Bug”和“不影响运行的格式警告”，导致开发流程频繁被次要矛盾卡死。
- **Agent 间职责模糊**: QA 并没有真正行使“质量把控”的分析权力，仅仅充当了正则匹配工具。

## 2. 核心架构设计

### 2.1 缺陷模型 (Issue Model)
在 `JimClawState` 中引入 `Issue` 对象，作为 Agent 间沟通质量问题的“唯一合法货币”。

```typescript
export type IssueSeverity = 'critical' | 'major' | 'minor';
export type IssueStatus = 'open' | 'resolved' | 'ignored';

export interface Issue {
  id: string;              // 唯一标识，如 "BUG-001"
  title: string;           // 缺陷简述
  description: string;     // QA 提炼后的详细现象与修复建议
  severity: IssueSeverity; // 严重程度
  status: IssueStatus;     // 状态流转
  relatedFiles: string[];  // 影响到的文件列表
  rawErrorSnippet: string; // 关键报错堆栈摘录（用于存证）
  detectedRound: number;   // 发现时的重试轮次
}
```

### 2.2 状态合并逻辑 (Reducer)
使用基于 ID 的增量合并策略。QA 提交的新 Issue 会追加到列表中，Coder 修复后由 QA 更新状态为 `resolved`。确保“历史遗留问题”不会因为新一轮测试而消失。

## 3. 核心节点重构逻辑

### 3.1 QA 节点：职能觉醒
QA（清扬）将从“传声筒”升级为“审计员”：
- **输入**: 单元测试结果、部署连通性日志、容器运行时日志、PM 验收标准、架构接口契约。
- **处理**: 调用 LLM 分析上述所有信息，对比“预期行为”与“实际报错”，生成结构化的 `Issue[]`。
- **决策**:
    - 若存在 `critical` 级别的 Open Issue，流程强制打回 Coder。
    - 若仅存在 `minor` 级别的问题，标记为不阻塞，允许流程继续，但工单保留在 Coder 的看板中。

### 3.2 Coder 节点：工单驱动修复
Coder（星河）的 Prompt 将进行模块化升级：
- **注入待办**: 在实现每个文件前，系统会自动检索该文件关联的所有 `open` 状态的 Issue。
- **精准修复**: 提示词要求 Coder 必须优先针对 Issue 列表中的描述进行定向修复，而非全盘重写。

### 3.3 架构师节点：基于工单的仲裁
当 Issue 状态反复在 `open` 和 `resolved` 之间跳变（说明 Coder 修不好）时，触发 `architect_mediation`。架构师通过分析 Issue 历史记录，下达最高权力的仲裁指令。

## 4. 数据流转闭环 (Cycle)
1. **发现**: `Deploy/Terminal` 产生原始数据 -> `QA` 分析数据并创建/更新 `Issue`。
2. **分发**: `Graph` 根据 Issue 的 Severity 决定路由（重试 or 仲裁 or 继续）。
3. **修复**: `Coder` 看到 Issue 描述，执行修复动作。
4. **验证**: `QA` 再次测试，若现象消失，将 Issue 状态改为 `resolved`。

## 5. UI 展示增强
- **Web 页面**: 在“决策与质量看板”中增加专门的 **Bug 看板**，用红、橙、黄三色展示不同等级的 Issue。
- **审计日志**: 每一轮产生的 Issue 列表将作为核心内容记录在 `audit/清扬.md` 中。

---
**设计结论**: 通过“工单系统”建立 Agent 间的契约化沟通，实现质量问题的闭环管理，彻底告别“盲目重试”。
