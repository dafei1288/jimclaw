# 混合项目设计方案 (Mixed Project Design)

## 1. 问题分析

### 当前系统限制

| 组件 | 当前假设 | 混合项目需求 |
|------|---------|------------|
| `spec.language` | 单一字符串 `"TypeScript"` | 需要表达 `"TypeScript + Java"` |
| Docker 镜像 | 单一镜像 (`node:20-alpine`) | 需要两个运行时 |
| `containerId` | 单一容器 | 需要两个容器 |
| `manifest.services` | 单服务 `[{name,port}]` | 已支持多服务 |
| Scaffold | 单语言 Provider | 需要组合两个 Provider |
| `testCommand` | 单一命令 | 两个独立测试命令 |
| `runCommand` | 单一命令 | 两个独立运行命令 |
| Infra `docker run` | `-p PORT:PORT` 单端口映射 | 多端口映射 |
| `allocatedHostPort` | 单端口 | 多端口 |

### 关键决策：一个容器还是两个？

**结论：单容器（backend）+ 前端静态文件内嵌方案。不使用两个容器。**

#### 为什么不用两个容器？

1. **配置复杂度**：`containerId` 需要变成 `Map<string,string>`，所有使用它的地方（terminal、deploy、qa、coder 的 shell_exec）都要改
2. **端口管理**：两个容器需要两个端口，网络隔离需要 Docker network 桥接
3. **部署拓扑**：生产环境通常不会前后端分离到两个容器——用 nginx 反代或后端直接 serve 静态文件
4. **超时风险**：两个容器启动翻倍，pip install + npm install 串行

#### 单容器方案怎么做？

**模式 A（推荐）：后端容器 + 前端构建产物内嵌**
```
容器镜像: backend 语言镜像 (e.g., maven:3.9)
构建步骤:
  1. npm install (安装 Node.js 工具链——但 maven 镜像没有 Node!)
  2. npm run build (编译 Vue/React)
  3. 后端 serve dist/ 静态文件
```

**问题**：maven/golang/rust 镜像没有 Node.js，无法 `npm run build`。

**模式 B（最终选择）：多阶段 Docker build + compose**

不用两个容器，而是用一个 **多运行时镜像** 或 **docker-compose**。

等等——回退到现实：

用户说"Vue + Java"，实际场景是：
- 前端 Vue 项目有独立测试 (`npm test`)
- 后端 Java 项目有独立测试 (`mvn test`)
- 运行时前端访问后端 API

**模式 C（务实选择）：后端容器为主，前端走宿主机验证**

```
主容器: backend (Java/Python/Go/Rust)
infra_setup:
  1. docker run backend 容器
  2. 在 backend 容器内安装 Node.js（apk add / apt install）
  3. npm install && npm run build
  4. 后端 serve dist/ 或复制到 static 目录

testCommand: "mvn test && npm test"  // 两个都跑
runCommand: "mvn spring-boot:run"     // 后端为主
```

**问题**：在 maven/alpine 里装 Node.js 可行（`apk add nodejs npm`），但增加 30-60 秒。golang-alpine 同理。

**模式 D（最优）：混合项目 = 后端 API only，前端是独立产物**

JimClaw 的核心场景是 API 开发。混合项目的真正含义是：
- 后端提供 API（Java/Python/Go/Rust）
- 前端提供 UI（Vue/React）
- **两者在同一个 workspace 里，但运行时只需要后端容器**

这样：
1. infra 只需要 backend 容器
2. 前端代码在容器内构建（需要 Node.js）或跳过前端运行时
3. 测试分别运行（前端在宿主机或容器内的 Node 环境）

---

## 2. 最终设计方案

### 2.1 架构决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 容器数量 | **1 个**（后端镜像） | 降低复杂度，避免 containerId 多实例 |
| 前端构建 | **容器内安装 Node.js** | backend:alpine 镜像可用 `apk add nodejs npm`（~10MB，~30秒） |
| 前端测试 | **容器内执行** | 环境一致，避免宿主机 Node 版本差异 |
| 部署 | **后端 serve 静态文件** | Spring Boot/Gin/FastAPI 都支持 static files |
| Spec 变更 | `spec.language` 保持单一，新增 `spec.frontend` 子对象 | 向后兼容 |

### 2.2 Spec 扩展

```typescript
interface TechSpec {
  // ... existing fields ...
  language: string;        // 后端语言: "Java", "Python", "Go", "Rust", "TypeScript"
  framework: string;       // 后端框架: "Spring Boot", "FastAPI", etc.
  
  // 新增
  frontend?: {
    language: "TypeScript" | "JavaScript";
    framework: "Vue" | "React" | "Svelte";
    buildCommand: string;  // "npm run build"
    testCommand: string;   // "npm test"
    outputDir: string;     // "dist"
    sourceDir: string;     // "frontend"
  };
}
```

### 2.3 State 扩展

```typescript
interface JimClawState {
  // ... existing ...
  // 不需要新的 containerId——仍然是单容器
  // 但 infra 需要知道前端存在
}
```

### 2.4 文件布局

```
workspace/
├── backend/                    ← 后端代码
│   ├── pom.xml / requirements.txt / go.mod / Cargo.toml
│   ├── src/                    ← 后端源码
│   └── tests/                  ← 后端测试
├── frontend/                   ← 前端代码 (独立子目录)
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── App.vue / App.tsx
│   │   └── components/
│   └── tests/                  ← 前端测试
├── Dockerfile                  ← 构建用 (可选)
└── shared/                     ← API 类型定义 (可选)
```

**注意**：不用 `backend/` 子目录！当前系统假设所有文件在 workspace 根目录。改为子目录会破坏所有路径逻辑。

**修正方案**：保持根目录平铺，前端文件放在 `frontend/` 子目录：

```
workspace/
├── pom.xml                     ← 后端文件在根目录 (不变)
├── src/main/java/...           ← 后端源码 (不变)
├── frontend/                   ← 前端代码 (新)
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   └── tests/
└── Dockerfile
```

### 2.5 各组件修改清单

#### A. Architect (`architect_node.ts`)

**检测逻辑**：
```typescript
// 已有的 detectTargetStack() 扩展
function detectTargetStack(goal: string, title: string) {
  // 新增：检测 "Vue + Java" / "React + Python" 等混合意图
  const frontendMatch = goal.match(/(vue|react|svelte|前端|frontend)\s*[\+和与]+\s*(java|python|go|rust|spring|fastapi|gin|axum)/i);
  const backendMatch = goal.match(/(java|python|go|rust|spring|fastapi|gin|axum)\s*[\+和与]+\s*(vue|react|svelte|前端|frontend)/i);
  
  if (frontendMatch || backendMatch) {
    return {
      language: extractBackendLanguage(goal),
      frontend: extractFrontendFramework(goal),  // "vue" | "react" | "svelte"
      isMixed: true,
    };
  }
}
```

**确定性输出**（以 Vue + Java 为例）：
```
spec.filesToCreate = [
  "pom.xml",                          // Java 后端
  "src/main/java/.../Application.java",
  "src/main/java/.../controller/HealthController.java",
  "src/main/resources/application.properties",
  "frontend/package.json",            // Vue 前端
  "frontend/vite.config.ts",
  "frontend/tsconfig.json",
  "frontend/src/App.vue",
  "frontend/src/main.ts",
  "frontend/src/components/HealthCheck.vue",
  "frontend/tests/HealthCheck.test.ts",
  "Dockerfile",
];
spec.language = "Java";
spec.framework = "Spring Boot 3";
spec.frontend = { language: "TypeScript", framework: "Vue", ... };
spec.testCommand = "mvn test -B";     // 后端测试（infra 先跑）
spec.frontend.testCommand = "cd frontend && npm test";  // 前端测试
spec.runCommand = "mvn spring-boot:run -Dserver.port=${PORT}";
```

#### B. Infra (`infra_node.ts`)

**镜像选择**：不变（选 backend 镜像）

**新增步骤**：检测 `frontend/` 目录存在时：
```bash
# 在 backend 容器内安装 Node.js (alpine 镜像)
apk add --no-cache nodejs npm    # ~30 秒

# 安装前端依赖
cd /app/frontend && npm install --loglevel=error

# (可选) 构建前端
npm run build
```

**测试执行顺序**：
```
terminal: 先跑后端测试，再跑前端测试
  mvn test -B
  cd frontend && npm test
```

#### C. Scaffold (`src/scaffolds/`)

新增 `MixedScaffoldProvider` 概念——组合两个已有 Provider：

```typescript
// 不需要新的 Provider 类
// 而是在 buildDeterministic*Output 中混合两个 scaffold 的文件列表
// 后端 scaffold 生成后端文件，前端 scaffold 生成 frontend/ 目录下的文件
```

#### D. Verifier (`verifier_node.ts`)

**不变**：已有 route detection 支持 Java/Go/Python/Rust
**新增**：前端文件存在时，检查 `frontend/package.json` 和 `frontend/src/` 入口

#### E. Coder (`coder_node.ts`)

**关键变更**：`frontend/` 下的文件由前端 scaffold 生成（确定性），coder 不需要额外处理。
**`isSafeDeterministicScaffoldFile`**：需要识别 `frontend/` 路径下的文件。

#### F. Terminal (`terminal_node.ts`)

**变更**：如果 `spec.frontend` 存在，分两步执行：
```typescript
// 1. 后端测试
await execInContainer(containerId, `sh -c "${backendTestCmd}"`, { timeout });
// 2. 前端测试 (如果后端测试通过)
await execInContainer(containerId, `sh -c "cd frontend && ${frontendTestCmd}"`, { timeout });
```

#### G. Deploy (`deploy_node.ts`)

**变更**：后端容器 serve 前端静态文件：
- Spring Boot: 将 `frontend/dist/` 复制到 `src/main/resources/static/`
- FastAPI: `app.mount("/static", StaticFiles(directory="frontend/dist"))`
- Gin: `r.Static("/assets", "./frontend/dist/assets")`
- Express: `app.use(express.static("frontend/dist"))`

### 2.6 不修改的组件

| 组件 | 原因 |
|------|------|
| `graph.ts` 路由逻辑 | 不变——节点流相同 |
| `qa_node.ts` | 不变——QA 分析 testResults |
| `fix_plan_node.ts` | 不变——修复逻辑不关心语言 |
| `orchestrator_node.ts` | 小改——subTask 分组 |
| `graph_types.ts` | 小改——`TechSpec.frontend` 扩展 |
| `persistence_node.ts` | 不变 |

### 2.7 实施优先级

#### Phase 1：最小可行（Vue/React + Java/Python/Go/Rust 健康检查）
- [ ] `graph_types.ts`: TechSpec 增加 `frontend?` 字段
- [ ] `logic_utils.ts`: `buildRequirementProtocol` 检测混合意图
- [ ] `architect_node.ts`: `detectTargetStack` 返回混合信息 + 确定性输出
- [ ] 新增 `src/scaffolds/vue_typescript.ts` 前端 scaffold
- [ ] `infra_node.ts`: alpine 镜像安装 Node.js + 前端依赖
- [ ] `terminal_node.ts`: 双测试命令
- [ ] E2E: "Vue + Java 健康检查 API + 前端页面"

#### Phase 2：完整 CRUD
- [ ] `vue_typescript.ts` scaffold 支持 CRUD 组件
- [ ] `coder_node.ts`: 前端文件 scaffold fallback
- [ ] `deploy_node.ts`: 后端 serve 静态文件
- [ ] E2E: "Vue + Java 用户管理 CRUD"

#### Phase 3：React 支持 + 高级场景
- [ ] `react_typescript.ts` scaffold
- [ ] 多服务编排（真正的微服务，远期）

### 2.8 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Node.js 安装失败 | 低 | 中 | fallback: 跳过前端构建，只跑后端 |
| Node.js 安装时间 | 已验证 | - | alpine `apk add`: ~5s, Ubuntu `apt-get`: ~30s |
| 前端测试超时 | 中 | 低 | 前端测试独立超时，不影响后端 |
| `mvn` + `npm` 组合超慢 | 中 | 中 | 串行不可避免，但两个 install 可并行 |
| 前端文件被 coder 覆盖 | 低 | 低 | `isSafeDeterministicScaffoldFile` 保护 |
| Docker 卷挂载性能（Windows）| 中 | 低 | 已知问题，不是新引入的 |

### 2.9 不需要两个容器的原因（详细论证）

1. **端口管理**：单容器只需一个端口，前端通过 `http://backend:PORT` 访问
2. **网络隔离**：前后端在同一容器内可以用 `localhost` 通信，无需 Docker network
3. **状态管理**：`containerId` 保持 `string` 类型，所有节点不需要修改
4. **部署简单**：生产环境常见模式是 JAR 包含前端静态文件
5. **调试简单**：一个容器日志容易追踪
6. **资源效率**：不需要额外的容器开销

如果未来需要真正的微服务（独立部署），可以用 docker-compose——但这是 Phase 3+ 的事。

### 2.10 Node.js 安装命令表（容器内）

| 基础镜像 | OS | 安装命令 | 时间 | 体积 |
|---------|-----|---------|------|------|
| `node:20-alpine` | Alpine | **已内置** | 0s | - |
| `golang:1.21-alpine` | Alpine | `apk add --no-cache nodejs npm` | ~5s | ~30MB |
| `rust:1.75` | Debian | `apt-get update -qq && apt-get install -y -qq nodejs npm` | ~15s | ~80MB |
| `maven:3.9-eclipse-temurin-17` | Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_20.x \| bash - && apt-get install -y nodejs` | ~30s | ~60MB |
| `python:3.11` | Debian | `apt-get update -qq && apt-get install -y -qq nodejs npm` | ~15s | ~80MB |

**优化**：可在 infra 阶段缓存 Node.js 安装——但首次运行时间已可接受。
