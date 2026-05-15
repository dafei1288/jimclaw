# Frontend Contract Design

## 背景

当前 JimClaw 已经存在部分前后端分离能力：

- `TechSpec.frontend` 支持 `Vue` / `React` / `Svelte`。
- `src/scaffolds/react_typescript.ts` 与 `src/scaffolds/vue_typescript.ts` 能生成 `frontend/` 下的 Vite 项目文件。
- `infra_node`、`terminal_node`、`deploy_node` 已经能安装、构建、测试和验证 `frontend/`。

问题不在于“不能做现代前端”，而在于这些能力没有被统一写进执行协议。结果是：

- `ensureRequirementDrivenFiles()` 在 `frontendRequired=true` 时仍默认补 `public/index.html`，即使架构师已经规划了 `frontend/`。
- `ExecutionProtocol.project.workspaceLayout.frontendRoots` 只会写 `public`，不会表达 `frontend`。
- `tryExternalScaffoldProvider()` 选择 React/Vue provider 时读的是后端 `spec.framework`，不是 `spec.frontend.framework`。
- 静态页、React、Vue scaffold 默认生成完整 CRUD UI，可能调用 API 契约里不存在的 `POST/PUT/DELETE`。
- Orchestrator 自动注入静态页任务时，任务说明固定写“列表、新增、编辑、删除”，会误导 Coder。

## 目标

把前端形态和 UI 可调用能力变成协议的一部分，让 Coder/QA 只围绕已经确认的前端工程类型与 API 契约工作。

## 非目标

- 不在本阶段引入 Next.js、Nuxt、路由库、状态管理库或 UI 组件库。
- 不要求所有前端都必须是 React/Vue；简单任务仍可使用静态页 fallback。
- 不改变 JimClaw 自己的 dashboard `public/index.html`。

## 设计

### 1. FrontendContract

在 `ExecutionProtocol` 中新增 `contracts.frontend`：

```ts
{
  appType: "none" | "static" | "spa";
  framework: "none" | "vanilla" | "react" | "vue" | "svelte";
  rootDir: "" | "public" | "frontend";
  entryFiles: string[];
  apiUsage: Array<{
    resourcePath: string;
    methods: string[];
    supportsList: boolean;
    supportsCreate: boolean;
    supportsUpdate: boolean;
    supportsDelete: boolean;
  }>;
}
```

`apiUsage` 从 `apiContract.endpoints` 推导，不从实体名猜测。这样 `/api/products`、`/api/orders`、`/api/devices` 都走同一套逻辑，不硬编码 `/api/books`。

### 2. 前端形态选择

前端形态由 `spec.frontend` 和文件布局共同决定：

- `spec.frontend.framework=React` 或存在 `frontend/src/App.tsx`：`spa/react`。
- `spec.frontend.framework=Vue` 或存在 `frontend/src/App.vue`：`spa/vue`。
- 存在 `public/index.html` 且没有 `frontend/`：`static/vanilla`。
- 无前端文件：`none`。

`frontendRoots` 应准确包含 `frontend` 或 `public`，不能默认只写 `public`。

### 3. 文件注入规则

`ensureRequirementDrivenFiles()` 的规则调整为：

- 如果 `frontendRequired=true` 且 `spec.frontend` 已存在，不补 `public/index.html`。
- 如果 `filesToCreate` 已包含 `frontend/`，不补 `public/index.html`。
- 只有在没有现代前端规划时，才补静态页 fallback。

### 4. Scaffold provider 选择

生成 `frontend/` 文件时，优先读 `state.spec.frontend.framework`：

- `React` -> `react-typescript`
- `Vue` -> `vue-typescript`

不能用后端 `spec.framework` 决定前端 provider。

### 5. UI 能力受 API 契约约束

所有前端 scaffold 都必须遵守同一条规则：

- `GET /api/<resource>` -> 可以生成列表/刷新。
- `POST /api/<resource>` -> 才能生成新增表单和 create API。
- `PUT/PATCH /api/<resource>/:id` -> 才能生成编辑/更新。
- `DELETE /api/<resource>/:id` -> 才能生成删除按钮。

如果只有 GET，页面必须是只读列表，不生成 POST/PUT/DELETE fetch。

## 验收标准

- React 前端请求不再落回 Vue provider。
- 现代前端项目不再被额外注入 `public/index.html`。
- `ExecutionProtocol` 能表达 `frontend` root 和 `contracts.frontend.apiUsage`。
- GET-only API 契约下，static/React/Vue scaffold 都不生成写操作 UI 或 fetch。
- 明确 CRUD API 契约下，static/React/Vue scaffold 仍可生成相应写操作。
