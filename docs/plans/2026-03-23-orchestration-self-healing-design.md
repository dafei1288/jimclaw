# Orchestration Self-Healing Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让编排层优先自动处理常见环境问题（依赖、端口、安装失败），避免把环境故障误派给 coder 造成自旋。

**Architecture:** 在 `coder` 与 `infra_setup` 之间增加环境闸门节点，统一做依赖预检与确定性修复；在 `qa` 增加环境问题优先路由、失败指纹与重试预算；在状态层补齐阻塞原因与修复轨迹字段，形成可观测闭环。

**Tech Stack:** TypeScript, LangGraph StateGraph, Node.js/npm, Docker

---

## 1. 背景与现状问题

当前流程中，常见环境问题会被当成代码问题反复回流：

1. 依赖缺失或安装失败（如 `ETARGET @types/mongoose`）无法被稳定修复，导致循环。
2. `diagnose_code` 在环境未就绪时返回硬错误，触发 coder 无效重写。
3. QA 路由缺少“环境优先”分支，导致 fix_plan/coder 被无意义触发。
4. 缺少“同一错误重复次数”止损机制，重试上限过高时会长时间自旋。

## 2. 设计目标

1. 常规环境错误可自动修复并继续流程，不依赖 LLM猜测。
2. 环境未就绪时不进入代码修复闭环。
3. 同一错误重复出现时有硬止损策略。
4. 全流程可审计：知道“为什么阻塞、尝试过什么、结果如何”。

## 3. 非目标

1. 不改业务代码生成质量策略。
2. 不引入新的外部基础设施（消息队列、数据库）。
3. 不做 UI 改造，仅补充状态字段供前端读取。

## 4. 方案总览

### 4.1 新增环境闸门节点 `env_guard`

放置位置：`coder -> env_guard -> infra_setup`

职责：
1. Node/TS 项目检查 `package.json` 是否存在。
2. 自动清理已知无效依赖（当前先覆盖 `@types/mongoose`）。
3. 本地执行 `npm install --silent` 作为环境预热。
4. 安装失败时返回结构化阻塞信息（`envReady=false` + `blockedReason`）。

收益：把“依赖失败”从后置测试阶段前移，减少无效轮次。

### 4.2 QA 环境优先路由

在 `qa_node` 中：
1. 先做问题分类（环境/代码/架构）。
2. 若是环境问题，调用 `tryFixEnvironmentProblem`。
3. 修复成功时设置 `recoveredEnvironment=true`，并直接回到 `infra_setup`，跳过 `fix_plan -> coder`。

### 4.3 失败指纹与止损

新增字段：
1. `failureFingerprint`: 当前轮失败签名（归一化错误文本）。
2. `sameFailureCount`: 连续相同签名次数。

路由策略：
1. `sameFailureCount >= 2` 且未恢复环境时，直接止损到 `post_mortem`（避免无上限自旋）。

### 4.4 修复账本（Repair Ledger）

新增 `repairLedger`，每轮记录：
1. 发生阶段（qa/env_guard）。
2. 失败签名（可选）。
3. 修复动作。
4. 结果（success/failed）。

## 5. 详细编排变更

### 5.1 Graph 路由

1. 新增节点：`env_guard`。
2. `coder` 无 pending 任务时，不再直接进入 `infra_setup`，改为 `env_guard`。
3. `env_guard` 条件路由：
   - `envReady=true` -> `infra_setup`
   - `envReady=false` -> `qa`
4. `qa` 条件路由新增：
   - `recoveredEnvironment=true` -> `infra_setup`
   - `sameFailureCount>=2` -> `post_mortem`

### 5.2 状态模型

新增 Annotation 字段：
1. `envReady: boolean | null`
2. `blockedReason: string`
3. `recoveredEnvironment: boolean`
4. `failureFingerprint: string`
5. `sameFailureCount: number`
6. `repairLedger: { round:number; phase:string; action:string; result:"success"|"failed"; fingerprint?:string }[]`

## 6. 验收标准

1. 当依赖未安装或版本无效时，系统优先进入环境修复路径，不触发 coder 重写。
2. `ETARGET @types/mongoose` 可被自动修复并继续流程。
3. 同一失败指纹连续出现 2 次后流程止损，不再长时间自旋。
4. `npx tsc --noEmit` 在主工程通过。
5. `repairLedger` 中可看到至少一条修复动作记录（在触发场景下）。

## 7. 风险与回滚

风险：
1. 止损阈值过低可能提前终止可修复问题。
2. `env_guard` 可能增加单轮耗时（`npm install`）。

回滚：
1. 可仅移除 `qa` 新路由条件，恢复旧路径。
2. 保留状态字段不影响兼容性。

