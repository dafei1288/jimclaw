# B2: 去硬编码 — Scaffold 抽象层设计

## 目标
将 `getDeterministicTemplateScaffold()` 从 "只认 Express/TypeScript" 改为
按 `spec.language + spec.framework` 分发的多语言 scaffold 系统。

## 当前状况

```
getDeterministicTemplateScaffold()
  ├── 入口硬检查: templateId !== "express-typescript" → return null
  ├── 16 个 build*Scaffold 函数，全部生成 TS 代码
  ├── package.json scaffold 硬编码 ts-node / tsc / jest
  ├── tsconfig.json scaffold（仅 TS 需要）
  ├── jest.config.cjs scaffold（仅 TS 需要）
  ├── src/index.ts scaffold 硬编码 express
  ├── tests/*.test.ts scaffold 硬编码 supertest
  └── Dockerfile scaffold 硬编码 node:20-alpine
```

## 设计方案

### 核心思路：ScaffoldProvider 接口

```typescript
interface ScaffoldProvider {
  language: string;        // "typescript" | "python" | "java" | ...
  framework: string;       // "express" | "fastapi" | "spring-boot" | ...
  
  // 必需的 scaffold 方法
  packageJson(state, options): string | null;
  entryPoint(state, options): string | null;
  testFile(state, options): string | null;
  dockerfile(state, options): string | null;
  serviceFile(state, options): string | null;
  crudRoute(state, options): string | null;
  
  // 配置文件（按语言可选）
  tsconfig?(state): string | null;
  jestConfig?(state): string | null;
  requirementsTxt?(state): string | null;
  pomXml?(state): string | null;
  
  // 辅助
  fileExtensions(): string[];     // [".ts"] 或 [".py"] 或 [".java"]
  testCommand(spec): string;      // "npm test" 或 "pytest" 或 "mvn test"
  runCommand(spec): string;       // "npm start" 或 "uvicorn ..." 或 "mvn spring-boot:run"
  baseDockerImage(): string;      // "node:20-alpine" 或 "python:3.11-slim"
}
```

### 文件结构

```
src/scaffolds/
  ├── index.ts                    # ScaffoldProvider 注册表
  ├── types.ts                    # 接口定义
  ├── express-typescript.ts       # 当前所有 build*Scaffold 迁移至此
  └── fastapi-python.ts           # 新增 Python/FastAPI provider
```

### 实施步骤

#### Step 1: 抽取接口 + 迁移 Express/TS（不改行为）
1. 定义 `ScaffoldProvider` 接口
2. 创建 `ExpressTypeScriptProvider` 类
3. 把 `getDeterministicTemplateScaffold` 改为查注册表
4. 所有现有 build*Scaffold 函数移入 ExpressTypeScriptProvider
5. **验证**: 行为完全不变，`npx tsc --noEmit` 通过

#### Step 2: 支撑代码去硬编码
1. `architect_node.ts` 中的确定性降级：检测语言→选 provider
2. `coder_node.ts` 中的 `stripInvalidImports`：文件扩展名从 provider 获取
3. `infra_node.ts` 中的 Docker 基础镜像：从 provider 获取
4. `terminal_node.ts` 中的测试命令：从 provider 获取
5. **验证**: Express/TS 行为不变

#### Step 3: 创建 FastAPI/Python provider
1. 实现 `FastApiPythonProvider`
2. Python scaffold:
   - `requirements.txt` (fastapi, uvicorn, pytest, httpx)
   - `app/main.py` (FastAPI 入口)
   - `app/models.py` (Pydantic models)
   - `app/routers/*.py` (API routes)
   - `tests/test_*.py` (pytest + httpx)
   - `Dockerfile` (python:3.11-slim)
3. **验证**: `pytest` 项目能跑通

## 风险
- Step 1 迁移量大（~2800 行 scaffold 代码），但纯机械搬运，不改逻辑
- Step 3 需要测试 Python 容器环境
- `stripInvalidImports` 对 Python 不适用（Python 没有 static import），需要条件跳过

## 预期收益
- Express/TS: 成功率不变（82%）
- FastAPI/Python: 新赛道，预期 50%+ 初始成功率
- 后续添加 Go、Java 只需新增 Provider
