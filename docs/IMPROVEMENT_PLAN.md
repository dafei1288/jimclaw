# JimClaw V2 重构开发计划：服务化与单步可测性

## 1. 核心目标
将 JimClaw 现有的巨石架构（Monolithic Graph）拆解为解耦的 REST 服务，实现：
- **原子化执行**: 每个阶段（PM/Arch/Coder/QA）都可独立触发、独立测试。
- **人工深度干预**: 在阶段切换点允许用户修改 Artifact。
- **状态透明化**: 摆脱对单一 LangGraph 实例的依赖，状态持久化至任务工作区。

## 2. 详细执行路线图

### 阶段一：逻辑层解耦 (Foundation)
- [ ] **T1.1**: 定义 `src/core/services/` 目录，建立 4 个核心服务类。
- [ ] **T1.2**: 剥离 PM 逻辑：`PMService.generate(goal) -> Contract`。
- [ ] **T1.3**: 剥离 Architect 逻辑：`ArchitectService.design(contract) -> Spec`（包含端口探测）。
- [ ] **T1.4**: 剥离 Coder 逻辑：`CoderService.implement(subTask) -> Code`。
- [ ] **T1.5**: 剥离 QA 逻辑：`QAService.audit(testResults, context) -> Issue[]`。

### 阶段二：API 矩阵实现 (RESTful Layer)
- [ ] **T2.1**: 在 `src/server.ts` 引入 `v2Router`。
- [ ] **T2.2**: 实现 `POST /api/v2/:runId/step/pm`。
- [ ] **T2.3**: 实现 `POST /api/v2/:runId/step/architect`。
- [ ] **T2.4**: 实现 `POST /api/v2/:runId/step/coder`。
- [ ] **T2.5**: 实现 `POST /api/v2/:runId/step/qa`。
- [ ] **T2.6**: 实现 `POST /api/v2/:runId/step/deploy`。

### 阶段三：前端交互重构 (Command Center)
- [ ] **T3.1**: 增加“手动模式”开关。
- [ ] **T3.2**: 增加 Artifact 编辑器（支持直接在 Web 端修改 contract.json 和 spec.json）。
- [ ] **T3.3**: 增加“单步执行”按钮组。

### 阶段四：质量保证 (Quality)
- [ ] **T4.1**: 针对每个 V2 API 编写 curl 测试用例。
- [ ] **T4.2**: 完善错误拦截：API 层强制执行 JSON Schema 校验。

## 3. 验收标准
1. **单步可测**: 我可以只传一个 `contract.json` 给 API，就拿到 `spec.json`，而不需要提供 `userGoal`。
2. **状态不丢失**: 刷新页面后，当前进行到的步骤和已生成的代码能够通过 `runId` 完美恢复。
3. **部署可控**: 部署失败后，我可以直接修改 `server.ts` 再次调用 `deploy` 接口，而不需要重新生成代码。
