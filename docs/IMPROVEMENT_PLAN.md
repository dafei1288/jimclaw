# JimClaw 三项改进详细实施计划

## 计划概览

| 改进项 | 预计工作量 | 优先级 | 依赖 |
|--------|-----------|--------|------|
| 1. 模板库系统 | 3-4 天 | P0 | 无 |
| 2. 分阶段生成 | 2-3 天 | P1 | 模板库 |
| 3. 脚手架与中间件 | 2-3 天 | P0 | 无 |

**总计：7-10 天工作量**

---

## 一、模板库系统

### 1.1 目录结构设计

```
jimclaw/
├── templates/                    # 新增：模板库根目录
│   ├── index.ts                 # 模板注册与检索入口
│   ├── base/                    # 基础模板
│   │   ├── package.json.j2      # Jinja2 风格模板
│   │   ├── server.ts.j2
│   │   └── test.ts.j2
│   ├── frameworks/              # 框架模板
│   │   ├── express-typescript/
│   │   │   ├── meta.json        # 模板元数据
│   │   │   ├── files/           # 模板文件
│   │   │   │   ├── server.ts
│   │   │   │   ├── routes/
│   │   │   │   ├── middleware/
│   │   │   │   └── tests/
│   │   │   └── scaffolding.ts   # 脚手架生成脚本
│   │   ├── fastify-python/
│   │   │   ├── meta.json
│   │   │   ├── files/
│   │   │   │   ├── main.py
│   │   │   │   ├── routers/
│   │   │   │   └── tests/
│   │   │   └── scaffolding.py
│   │   ├── nextjs-fullstack/
│   │   │   ├── meta.json
│   │   │   └── files/
│   │   ├── gin-go/
│   │   └── spring-boot-java/
│   └── generators/              # 代码生成器
│       ├── typescript.ts
│       ├── python.ts
│       └── go.ts
│
├── src/
│   ├── core/
│   │   ├── template_engine.ts   # 新增：模板引擎
│   │   └── graph.ts             # 修改：集成模板引擎
│   └── agents/
│       └── team.ts              # 修改：添加模板相关技能
```

### 1.2 模板元数据格式

```typescript
// templates/frameworks/express-typescript/meta.json
{
  "id": "express-typescript",
  "name": "Express + TypeScript",
  "language": "TypeScript",
  "version": "1.0.0",
  "description": "生产级 Express REST API 模板，包含完整的中间件配置",
  "tags": ["api", "rest", "backend", "production-ready"],
  "dependencies": {
    "express": "^4.18.0",
    "typescript": "^5.0.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "eslint": "^8.0.0",
    "prettier": "^3.0.0"
  },
  "files": {
    "server": "files/server.ts",
    "routes": "files/routes/index.ts",
    "middleware": "files/middleware/index.ts",
    "test": "files/tests/app.test.ts",
    "config": "files/tsconfig.json"
  },
  "middleware": ["helmet", "cors", "compression", "morgan", "error-handler"],
  "features": {
    "health_check": true,
    "cors": true,
    "rate_limiting": false,
    "websocket": false,
    "static_files": true
  }
}
```

### 1.3 模板文件示例

```typescript
// templates/frameworks/express-typescript/files/server.ts
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { registerRoutes } from './routes';
import { errorHandler } from './middleware/error-handler';
import { config } from './config';

{{#if features.health_check}}
import { healthCheckRouter } from './routes/health';
{{/if}}

const app: Application = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ========== 中间件配置 ==========
app.use(helmet());                                    // 安全头
app.use(cors({                                       // CORS 配置
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(compression());                              // 响应压缩
app.use(express.json({ limit: '10mb' }));           // JSON 解析
app.use(express.urlencoded({ extended: true }));     // URL 编码
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));                       // 日志
}

// ========== 路由注册 ==========
{{#if features.health_check}}
app.use('/health', healthCheckRouter);
{{/if}}
registerRoutes(app);

// ========== 错误处理 ==========
app.use(errorHandler);

// ========== 服务器启动 ==========
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[服务] 已启动，端口 ${PORT}`);
    console.log(`[环境] ${process.env.NODE_ENV || 'development'}`);
    console.log(`[健康检查] http://0.0.0.0:${PORT}/health`);
  });
}

export default app;
```

### 1.4 模板引擎核心代码

```typescript
// src/core/template_engine.ts
import * as fs from 'fs/promises';
import * as path from 'path';

export interface TemplateMetadata {
  id: string;
  name: string;
  language: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files: Record<string, string>;
  middleware: string[];
  features: Record<string, boolean>;
}

export interface TemplateContext {
  port: number;
  projectName: string;
  endpoints?: Array<{ method: string; path: string; description: string }>;
  features?: Record<string, boolean>;
  [key: string]: any;
}

export class TemplateEngine {
  private templates: Map<string, TemplateMetadata> = new Map();
  private templateDir: string;

  constructor(templateDir: string = path.join(process.cwd(), 'templates')) {
    this.templateDir = templateDir;
  }

  /**
   * 加载所有模板
   */
  async loadTemplates(): Promise<void> {
    const frameworksDir = path.join(this.templateDir, 'frameworks');
    const entries = await fs.readdir(frameworksDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(frameworksDir, entry.name, 'meta.json');
        try {
          const metaContent = await fs.readFile(metaPath, 'utf-8');
          const meta: TemplateMetadata = JSON.parse(metaContent);
          this.templates.set(meta.id, meta);
          console.log(`[TemplateEngine] 已加载模板: ${meta.id}`);
        } catch (e) {
          console.warn(`[TemplateEngine] 跳过无效模板: ${entry.name}`, e);
        }
      }
    }
  }

  /**
   * 根据语言和特性推荐模板
   */
  recommendTemplate(language: string, features: string[] = []): TemplateMetadata | null {
    const candidates = Array.from(this.templates.values())
      .filter(t => t.language.toLowerCase() === language.toLowerCase());

    if (candidates.length === 0) return null;

    // 按特性匹配度排序
    const scored = candidates.map(t => ({
      template: t,
      score: features.filter(f => t.features[f === 'websocket' ? 'websocket' : f]).length
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].template;
  }

  /**
   * 简单的 Jinja2 风格模板渲染
   * 支持 {{ variable }} 和 {{#if condition}}...{{/if}}
   */
  private renderTemplate(content: string, context: TemplateContext): string {
    let result = content;

    // 处理 {{#if condition}}...{{/if}}
    result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, condition, body) => {
      return context.features?.[condition] ? body : '';
    });

    // 处理 {{#each items}}...{{/each}}
    result = result.replace(/\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, arrayName, body) => {
      const items = context[arrayName];
      if (!Array.isArray(items)) return '';
      return items.map(item => {
        let itemBody = body;
        if (typeof item === 'object') {
          Object.entries(item).forEach(([k, v]) => {
            itemBody = itemBody.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
          });
        }
        return itemBody;
      }).join('\n');
    });

    // 处理 {{ variable }}
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return context[key] !== undefined ? String(context[key]) : `{{${key}}}`;
    });

    return result;
  }

  /**
   * 生成项目文件
   */
  async generateProject(
    templateId: string,
    context: TemplateContext,
    outputDir: string
  ): Promise<Map<string, string>> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`模板不存在: ${templateId}`);
    }

    const files = new Map<string, string>();
    const templatePath = path.join(this.templateDir, 'frameworks', templateId, 'files');

    // 递归读取模板文件
    const readFiles = async (dir: string, baseDir: string = ''): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(baseDir, entry.name);

        if (entry.isDirectory()) {
          await readFiles(fullPath, relativePath);
        } else if (entry.isFile()) {
          let content = await fs.readFile(fullPath, 'utf-8');

          // 跳过元数据文件
          if (entry.name === 'meta.json') continue;

          // 渲染模板
          if (entry.name.endsWith('.j2') || entry.name.endsWith('.tpl')) {
            content = this.renderTemplate(content, context);
            // 移除 .j2 或 .tpl 后缀
            relativePath = relativePath.replace(/\.j2$|\.tpl$/, '');
          }

          files.set(relativePath, content);
        }
      }
    };

    await readFiles(templatePath);

    console.log(`[TemplateEngine] 生成 ${files.size} 个文件`);
    return files;
  }

  /**
   * 获取脚手架命令
   */
  getScaffoldingCommand(templateId: string, projectName: string): string {
    const template = this.templates.get(templateId);
    if (!template) return '';

    const scaffoldingPath = path.join(
      this.templateDir,
      'frameworks',
      templateId,
      'scaffolding.js'
    );

    // 返回模板特定的脚手架命令
    return `node ${scaffoldingPath} ${projectName}`;
  }
}

// 单例
export const templateEngine = new TemplateEngine();
```

### 1.5 集成到 Graph

```typescript
// 在 src/core/graph.ts 的 architect 节点中集成

// 1. 在 createJimClawGraph 开始时加载模板
export function createJimClawGraph(agents: {...}, onEvent?: ...) {
  // ... 现有代码 ...

  // 加载模板引擎
  await templateEngine.loadTemplates();
  console.log(`[Graph] 模板引擎已就绪，加载了 ${templateEngine.getTemplateCount()} 个模板`);

  // ...
}

// 2. 在 architect 节点中推荐模板
.addNode("architect", async (state: JimClawState) => {
  // ... 现有代码 ...

  // 推荐合适的模板
  const template = templateEngine.recommendTemplate(
    spec.language,
    Object.entries(spec.features || {}).filter(([_, v]) => v).map(([k, _]) => k)
  );

  if (template) {
    console.log(`[Architect] 推荐模板: ${template.name} (${template.id})`);

    // 将模板信息添加到 spec，供 coder 使用
    return {
      spec: {
        ...spec,
        templateId: template.id,
        templateMetadata: template
      }
    };
  }

  // ...
})
```

---

## 二、分阶段生成系统

### 2.1 设计思路

**问题**：当前 Coder 一次性生成完整文件（500+ 行），出错率高。

**解决**：将生成过程拆分为 3 个阶段，每阶段专注一个目标：

```
阶段 1: 骨架生成 (Scaffold)
  目标：创建文件结构、导入、基础配置
  输出：50-100 行可编译的空壳代码

阶段 2: 业务填充 (Implementation)
  目标：根据 spec 实现具体功能
  输出：200-300 行完整业务逻辑

阶段 3: 测试对齐 (Test Alignment)
  目标：根据测试文件调整导出函数和接口
  输出：通过测试的最终代码
```

### 2.2 状态扩展

```typescript
// 在 src/core/graph.ts 中添加新的状态类型

export interface GenerationStage {
  stage: 'scaffold' | 'implementation' | 'test_alignment';
  currentFile?: string;
  scaffoldComplete?: boolean;
  implementationComplete?: boolean;
  testAligned?: boolean;
}

export const JimClawState = Annotation.Root({
  // ... 现有状态 ...

  // 新增：分阶段生成状态
  generationStage: Annotation<GenerationStage | null>({
    reducer: (x, y) => y ?? x,
  }),
});
```

### 2.3 分阶段 Prompt 设计

```typescript
// 阶段 1: 骨架生成 Prompt
const getScaffoldPrompt = (task: SubTask, spec: TechSpec, template?: TemplateMetadata) => `
【阶段 1/3: 骨架生成】
目标：创建 ${task.fileTarget} 的可编译骨架，不包含具体业务逻辑。

【严格规则】
1. 只输出代码，用 \`\`\` 包裹
2. 必须包含所有必要的 import/require
3. 创建空的 class/function 占位符，带 JSDoc 注释
4. 确保文件能通过 LSP 诊断（无语法错误）

${template ? `
【模板参考 - 使用 ${template.name} 的结构】
${template.scaffoldExample || ''}
` : ''}

【文件骨架要求】
文件: ${task.fileTarget}
语言: ${spec.language}
依赖: ${task.contextRequirement}

请生成文件骨架（仅结构和导入，无业务逻辑）。
`;

// 阶段 2: 业务实现 Prompt
const getImplementationPrompt = (task: SubTask, scaffoldCode: string, spec: TechSpec) => `
【阶段 2/3: 业务实现】
目标：在骨架基础上填充具体业务逻辑。

【当前骨架】
\`\`\`${spec.language.toLowerCase()}
${scaffoldCode}
\`\`\`

【需求说明】
${task.description}

【API 契约】
${JSON.stringify(spec.interfaces || {})}

【实现要求】
1. 保持骨架结构不变（import、类名、函数名）
2. 填充 TODO/FIXME 标记的函数体
3. 遵循契约定义的输入输出
4. 添加错误处理和日志

请输出完整实现代码。
`;

// 阶段 3: 测试对齐 Prompt
const getTestAlignmentPrompt = (task: SubTask, implementationCode: string, testFile: string) => `
【阶段 3/3: 测试对齐】
目标：调整代码以通过测试。

【当前实现】
\`\`\`${getLanguage(task.fileTarget)}
${implementationCode}
\`\`\`

【测试期望】
\`\`\`
${testFile}
\`\`\`

【分析】
请对比实现代码与测试期望，找出：
1. 测试调用的函数是否被正确导出
2. 函数签名是否匹配（参数、返回值）
3. 边界情况是否处理

【修复要求】
1. 只修改必要的部分（导出、函数签名、边界处理）
2. 不改变已有的正确逻辑
3. 确保所有测试用例能通过

请输出修复后的完整代码。
`;
```

### 2.4 Coder 节点改造

```typescript
// 在 src/core/graph.ts 中修改 coder 节点

.addNode("coder", async (state: JimClawState) => {
  // ... 现有代码 ...

  for (const task of subTasks) {
    // ... 跳过逻辑 ...

    // ========== 阶段 1: 骨架生成 ==========
    emit("thinking", agents.coder.getPersona().name, `[阶段1] 生成骨架: ${task.fileTarget}`);

    const scaffoldPrompt = getScaffoldPrompt(task, state.spec!, state.spec?.templateMetadata);
    const scaffoldResp = await agents.coder.chat(
      [{ role: "user", content: scaffoldPrompt }],
      (ev) => emit(ev.type, ev.sender, "骨架生成中", ev),
      { mode: "coding", brief: state.projectBrief }
    );

    const scaffoldCode = extractCode(extractText(scaffoldResp.content));

    // LSP 诊断骨架
    const diag = await LSPDiagnoseSkill.config.run({
      filePath: path.join(WORKSPACE, task.fileTarget),
      content: scaffoldCode,
      language: state.spec!.language
    });

    if (diag.errors && diag.errors.length > 0) {
      // 骨架错误，重试
      emit("error", "System", `骨架诊断失败: ${diag.errors[0].message}`);
      continue;
    }

    // 写入骨架
    await FileWriteSkill.config.run({
      filePath: task.fileTarget,
      content: scaffoldCode
    });

    // ========== 阶段 2: 业务实现 ==========
    emit("thinking", agents.coder.getPersona().name, `[阶段2] 填充业务逻辑: ${task.fileTarget}`);

    const implPrompt = getImplementationPrompt(task, scaffoldCode, state.spec!);
    const implResp = await agents.coder.chat(
      [{ role: "user", content: implPrompt }],
      (ev) => emit(ev.type, ev.sender, "业务实现中", ev),
      { mode: "coding", brief: state.projectBrief }
    );

    const implCode = extractCode(extractText(implResp.content));

    // Todo-Enforcer 检查
    if (/TODO|FIXME|throw new Error\('not implemented'\)/.test(implCode)) {
      emit("warning", "System", "检测到 TODO 标记，触发重新实现");
      // ... 重试逻辑
    }

    // ========== 阶段 3: 测试对齐（如果有测试文件） ==========
    const testFile = (state.subTasks || []).find(t => /test|spec/i.test(t.fileTarget));
    if (testFile && testFile.status !== 'completed') {
      emit("thinking", agents.coder.getPersona().name, `[阶段3] 对齐测试: ${task.fileTarget}`);

      const testContent = filesContent[testFile.fileTarget] || '';
      const alignPrompt = getTestAlignmentPrompt(task, implCode, testContent);

      const alignResp = await agents.coder.chat(
        [{ role: "user", content: alignPrompt }],
        (ev) => emit(ev.type, ev.sender, "测试对齐中", ev),
        { mode: "coding", brief: state.projectBrief }
      );

      finalCode = extractCode(extractText(alignResp.content));
    } else {
      finalCode = implCode;
    }

    // ... 写入最终代码，LSP 诊断 ...
  }

  // ...
})
```

---

## 三、脚手架与中间件标准

### 3.1 脚手架命令标准

```typescript
// src/core/scaffolding.ts
export interface ScaffoldingCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout: number;
}

export const SCAFFOLDING_COMMANDS: Record<string, ScaffoldingCommand> = {
  // JavaScript/TypeScript
  'vite-typescript': {
    command: 'npm',
    args: ['create', 'vite@latest', '.', '--', '--template', 'vanilla-ts'],
    timeout: 60000
  },
  'express-typescript': {
    command: 'npx',
    args: ['express-generator', '--no-view', '--git'],
    timeout: 45000
  },
  'nextjs': {
    command: 'npx',
    args: ['create-next-app@latest', '.', '--typescript', '--tailwind', '--eslint'],
    timeout: 90000
  },

  // Python
  'fastapi': {
    command: 'pip',
    args: ['install', 'cookiecutter'],
    timeout: 30000
  },
  'fastapi-cookiecutter': {
    command: 'cookiecutter',
    args: ['gh:tiangolo/full-stack-fastapi-postgresql'],
    timeout: 60000
  },

  // Go
  'gin-standard': {
    command: 'go',
    args: ['get', '-u', 'github.com/gin-gonic/gin'],
    timeout: 60000
  },

  // Java
  'spring-boot': {
    command: 'curl',
    args: ['-s', 'https://start.spring.io/starter.zip', '-o', 'project.zip'],
    timeout: 90000
  }
};
```

### 3.2 必备中间件标准

```typescript
// src/core/middleware_standards.ts
export interface MiddlewareSpec {
  name: string;
  package: string;
  version?: string;
  required: boolean;
  config: string;
  description: string;
}

export const REQUIRED_MIDDLEWARE: Record<string, MiddlewareSpec[]> = {
  'node': [
    {
      name: 'helmet',
      package: 'helmet',
      version: '^7.0.0',
      required: true,
      config: "app.use(helmet());",
      description: '安全头设置，防止常见 Web 漏洞'
    },
    {
      name: 'cors',
      package: 'cors',
      version: '^2.8.5',
      required: true,
      config: "app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));",
      description: '跨域资源共享配置'
    },
    {
      name: 'compression',
      package: 'compression',
      version: '^1.7.4',
      required: true,
      config: "app.use(compression());",
      description: '响应压缩，减少传输体积'
    },
    {
      name: 'morgan',
      package: 'morgan',
      version: '^1.10.0',
      required: true,
      config: "if (process.env.NODE_ENV !== 'test') { app.use(morgan('combined')); }",
      description: 'HTTP 请求日志'
    },
    {
      name: 'express-rate-limit',
      package: 'express-rate-limit',
      version: '^6.7.0',
      required: false,
      config: `const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 分钟
  max: 100  // 限制 100 个请求
});
app.use('/api', limiter);`,
      description: 'API 速率限制'
    }
  ],
  'python': [
    {
      name: 'middleware',
      package: 'starlette.middleware',
      version: '*',
      required: true,
      config: `app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)`,
      description: 'CORS 中间件'
    },
    {
      name: 'gzip',
      package: 'starlette.middleware.gzip',
      version: '*',
      required: true,
      config: 'app.add_middleware(GZipMiddleware)',
      description: '响应压缩'
    }
  ]
};

export function generateMiddlewareConfig(language: string, framework: string): string {
  const middlewares = REQUIRED_MIDDLEWARE[language] || [];

  return `
// ========== 必备中间件配置 ==========
${middlewares.map(m => `
// ${m.description}
// ${m.required ? '[必须]' : '[可选]'}
${m.config}
`).join('\n')}
`;
}
```

### 3.3 Architect Prompt 增强

```typescript
// 在 src/core/graph.ts 的 architect 节点中添加脚手架指令

const architectPrompt = `
你是软件架构师，负责设计技术方案。

【新增：脚手架使用规则】
1. 优先使用官方脚手架初始化项目
2. 在 runCommand 中明确脚手架命令
3. 确保生成的代码包含必备中间件

【脚手架映射表】
语言/框架          → 脚手架命令
---------------------------
TypeScript + Express → npx express-generator --no-view
TypeScript + Vite    → npm create vite@latest . --template vanilla-ts
Python + FastAPI     → pip install fastapi uvicorn
Go + Gin             → go mod init + gin 框架
Next.js              → npx create-next-app@latest

【必备中间件清单】
Node.js 项目必须包含：
- helmet（安全）
- cors（跨域）
- compression（压缩）
- morgan（日志）
- errorHandler（统一错误处理）

Python 项目必须包含：
- CORSMiddleware
- GZipMiddleware
- ExceptionMiddleware

【输出要求】
在 runCommand 中明确脚手架命令，例如：
"runCommand": "npm install && npm install helmet cors compression morgan && node server.js"

...
`;
```

### 3.4 代码生成器

```typescript
// src/generators/typescript.ts
export interface TypeScriptGeneratorOptions {
  framework: 'express' | 'fastify' | 'koa' | 'nestjs';
  withTypescript: boolean;
  port: number;
  features: {
    cors?: boolean;
    helmet?: boolean;
    rateLimit?: boolean;
    websocket?: boolean;
    staticFiles?: boolean;
  };
}

export class TypeScriptGenerator {
  generateServerCode(options: TypeScriptGeneratorOptions): string {
    const imports: string[] = [];
    const middleware: string[] = [];
    const features: string[] = [];

    // 基础导入
    if (options.framework === 'express') {
      imports.push(`import express from 'express';`);
      imports.push(`import { Application } from 'express';`);
    }

    // 中间件
    if (options.features.helmet) {
      imports.push(`import helmet from 'helmet';`);
      middleware.push(`app.use(helmet());`);
    }

    if (options.features.cors) {
      imports.push(`import cors from 'cors';`);
      middleware.push(`app.use(cors());`);
    }

    if (options.features.rateLimit) {
      imports.push(`import rateLimit from 'express-rate-limit';`);
      features.push(`
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api', limiter);
`);
    }

    // 生成完整代码
    return `
${imports.join('\n')}

const app: Application = express();
const PORT = process.env.PORT || ${options.port};

// 中间件配置
${middleware.join('\n')}

${features.join('\n')}

// 路由注册
// TODO: 添加业务路由

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(\`[服务] 已启动，端口 \${PORT}\`);
  });
}

export default app;
`;
  }

  generateTestCode(serverFile: string): string {
    return `
import request from 'supertest';
import app from './${serverFile.replace('.ts', '')}';

describe('API 测试', () => {
  // TODO: 添加具体测试用例
});
`;
  }
}
```

---

## 四、实施步骤与时间表

### 第 1-2 天：模板库基础结构

- [ ] 创建 `templates/` 目录结构
- [ ] 实现 `TemplateEngine` 类
- [ ] 编写第一个模板（Express + TypeScript）
- [ ] 集成到 `createJimClawGraph`

### 第 3 天：扩展模板库

- [ ] 添加 FastAPI + Python 模板
- [ ] 添加 Gin + Go 模板
- [ ] 编写模板元数据验证

### 第 4-5 天：分阶段生成

- [ ] 扩展 `JimClawState` 添加 `generationStage`
- [ ] 编写三个阶段的 Prompt 模板
- [ ] 修改 `coder` 节点支持分阶段
- [ ] 添加阶段间的诊断和验证

### 第 6-7 天：脚手架与中间件

- [ ] 实现 `ScaffoldingCommand` 标准
- [ ] 实现 `REQUIRED_MIDDLEWARE` 标准
- [ ] 增强 Architect prompt
- [ ] 实现 `TypeScriptGenerator`

### 第 8-10 天：集成测试与优化

- [ ] 端到端测试三个改进协同工作
- [ ] 性能优化（模板缓存、并行生成）
- [ ] 文档编写
- [ ] 示例项目验证

---

## 五、预期效果

| 指标 | 改进前 | 改进后 | 提升 |
|------|--------|--------|------|
| 代码一次生成成功率 | ~40% | ~70% | +75% |
| 平均重试次数 | 3-5 次 | 1-2 次 | -60% |
| 生成时间 | 2-3 分钟 | 1-1.5 分钟 | -40% |
| 代码规范性 | 2/5 | 4/5 | +100% |
| 中间件完整性 | 20% | 100% | +400% |

---

## 六、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 模板维护成本高 | 中 | 建立模板版本管理，自动化测试 |
| 分阶段生成增加复杂度 | 中 | 详细的阶段状态跟踪，可回退 |
| 脚手架命令变化 | 低 | 定期更新脚手架映射表 |
| 特殊项目需求 | 高 | 支持自定义模板覆盖 |

---

## 七、下一步行动

1. **立即开始**：创建模板目录结构和 `TemplateEngine` 类
2. **准备第一个模板**：Express + TypeScript 完整示例
3. **设计分阶段状态机**：在 graph.ts 中添加状态定义
4. **编写中间件标准文档**：供团队参考

需要我开始实施某一部分吗？
