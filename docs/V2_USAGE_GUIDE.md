# JimClaw V2 开发者操作指南 (REST API 版)

JimClaw V2 将原本黑盒的 AI 开发流程拆解为 5 个标准的原子服务。你可以通过 HTTP 请求按顺序驱动，也可以在中间环节手动干预产出物。

## 1. 基础信息
- **Base URL**: `http://localhost:3000/api/v2`
- **Content-Type**: `application/json`
- **工作区**: 所有产物均存放在 `/workspace/:runId` 目录下。

---

## 2. 标准协作流程

### 第一步：PM 需求建模 (pm)
**职责**：将你的“一句话需求”转化为标准的“任务契约”。
- **Endpoint**: `POST /:runId/step/pm`
- **输入**:
  ```json
  { "goal": "做一个图书管理系统，包含借书和还书接口" }
  ```
- **输出**: `contract.json` (包含 requirements 和 acceptanceCriteria)。
- **干预点**: 你可以在下一步之前，手动修改 `contract.json` 里的验收标准。

### 第二步：架构方案设计 (architect)
**职责**：基于契约选择技术栈，并自动实测探测宿主机空闲端口。
- **Endpoint**: `POST /:runId/step/architect`
- **输入**: `(空)` 或 `{ "contract": {...} }`
- **动作**: 自动执行 `find_free_port` 锁定端口。
- **输出**: `spec.json`, `manifest.json`, `api_contract.json`。
- **干预点**: 你可以修改 `spec.json` 里的 `filesToCreate` 列表，控制 AI 只生成你关心的文件。

### 第三步：定向代码开发 (coder)
**职责**：根据技术规范，实现特定的子任务文件。
- **Endpoint**: `POST /:runId/step/coder`
- **输入**: (必须指定任务列表)
  ```json
  {
    "tasks": [
      {
        "id": "t1",
        "fileTarget": "server.ts",
        "description": "实现核心服务入口",
        "contextRequirement": "需要使用 Express"
      }
    ]
  }
  ```
- **动作**: 自动执行正则提取、JSON 强校验、LSP 诊断和 Lint 修复。
- **输出**: 真实的代码文件写入磁盘。

### 第四步：质量审计与 Bug 定级 (qa)
**职责**：像人类测试一样分析报错，提炼并定级 Bug。
- **Endpoint**: `POST /:runId/step/qa`
- **输入**: `{ "testResults": "报错原文...", "retryCount": 1 }`
- **输出**: `issues.json` (结构化的缺陷工单列表)。
- **价值**: 将杂乱的日志转化为 Coder 听得懂的“修复建议”。

### 第五步：部署验收与健康检查 (deploy)
**职责**：启动 Docker 环境，并实地执行 curl 探测。
- **Endpoint**: `POST /:runId/step/deploy`
- **输入**: `(空)`
- **动作**: 环境清理 -> 启动容器 -> npm install -> 健康检查探测。
- **输出**: `{ "success": true, "url": "http://IP:PORT" }`

---

## 3. 混合实战技巧

### 场景 A：定向修复 Bug
当你从 QA 接口拿到一个 ID 为 `BUG-001` 的工单后，你可以再次调用 Coder 接口进行“手术级修复”：
```bash
curl -X POST http://localhost:3000/api/v2/run_01/step/coder \
     -d '{
       "tasks": [...],
       "issueTracker": [{"id": "BUG-001", "description": "端口没对上", ...}]
     }'
```

### 场景 B：手动注入架构
你可以直接跳过 PM 阶段，自己写一个 `contract.json` 丢进 `workspace/my_run/`，然后直接调用 `architect` 接口，强制 AI 按照你的契约去设计。

---

## 4. 故障排除
- **路径错误**: 所有路径在 API 层已实现自动 prefix，你只需传相对路径（如 `src/app.ts`）。
- **端口冲突**: 架构师会自动调用工具找端口，请务必相信架构师产出的 `manifest.json` 里的端口号。
- **日志查看**: 所有的原始思考过程依然在 `workspace/:runId/audit/` 下。
