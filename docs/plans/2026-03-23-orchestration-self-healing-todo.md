# TODO: Orchestration Self-Healing

## 执行顺序

- [x] 1. 扩展状态模型字段（env/block/retry/fingerprint/ledger）
  - 文件：`src/core/graph_types.ts`
  - 验证：`npx tsc --noEmit`

- [x] 2. 新增环境闸门节点 `env_guard`
  - 文件：`src/core/nodes/env_guard_node.ts`
  - 功能：依赖预检、无效依赖修复、`npm install` 预热、结构化阻塞输出
  - 验证：`npx tsc --noEmit`

- [x] 3. 接入编排图路由
  - 文件：`src/core/graph.ts`
  - 变更：
    - `coder -> env_guard -> infra_setup`
    - `env_guard` 条件分支（`envReady`）
    - `qa` 条件分支（`recoveredEnvironment` / `sameFailureCount`）
  - 验证：`npx tsc --noEmit`

- [x] 4. 扩展故障指纹与修复账本工具函数
  - 文件：`src/core/logic_utils.ts`
  - 功能：`buildFailureFingerprint` 与 ledger 工具
  - 验证：`npx tsc --noEmit`

- [x] 5. 升级 QA 环境优先路由
  - 文件：`src/core/nodes/qa_node.ts`
  - 功能：
    - 环境问题优先自修复
    - 修复成功直达 `infra_setup`
    - 连续同指纹计数
  - 验证：`npx tsc --noEmit`

- [x] 6. 端到端编排回归验证（本地最小）
  - 命令：
    - `npx tsc --noEmit`
    - 手工构造一个 `ETARGET @types/mongoose` 场景，确认不会进入 coder 自旋
  - 产出：记录验证结果与残余风险
