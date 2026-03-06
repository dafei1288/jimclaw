/**
 * 脚手架命令和中间件标准
 * 定义各语言/框架的官方脚手架命令和必备中间件
 */

/**
 * 脚手架命令配置
 */
export interface ScaffoldingCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout: number;
  description: string;
  postInstall?: string;  // 安装后需要执行的命令
}

/**
 * 中间件规格
 */
export interface MiddlewareSpec {
  name: string;
  package: string;
  version?: string;
  required: boolean;
  config: string;
  description: string;
  securityRelevance?: boolean;  // 是否与安全相关
}

/**
 * 语言/框架映射到脚手架命令
 */
export const SCAFFOLDING_COMMANDS: Record<string, ScaffoldingCommand> = {
  // ========== JavaScript/TypeScript ==========
  'vite-typescript': {
    command: 'npm',
    args: ['create', 'vite@latest', '.', '--', '--template', 'vanilla-ts'],
    timeout: 60000,
    description: 'Vite + TypeScript 快速脚手架',
    postInstall: 'npm install -D prettier eslint'
  },
  'express-typescript': {
    command: 'npx',
    args: ['express-generator', '--no-view', '--git'],
    timeout: 45000,
    description: 'Express.js TypeScript 项目生成器',
    postInstall: 'npm install -D typescript @types/node @types/express ts-node'
  },
  'nextjs-fullstack': {
    command: 'npx',
    args: ['create-next-app@latest', '.', '--typescript', '--tailwind', '--eslint', '--app'],
    timeout: 90000,
    description: 'Next.js 全栈脚手架（App Router）'
  },
  'nuxt-vue': {
    command: 'npx',
    args: ['nuxi', 'init', '.'],
    timeout: 60000,
    description: 'Nuxt.js Vue 全栈脚手架'
  },
  'react-vite': {
    command: 'npm',
    args: ['create', 'vite@latest', '.', '--', '--template', 'react-ts'],
    timeout: 60000,
    description: 'React + TypeScript + Vite'
  },

  // ========== Python ==========
  'fastapi': {
    command: 'pip',
    args: ['install', 'fastapi', 'uvicorn[standard]', 'pydantic'],
    timeout: 60000,
    description: 'FastAPI 高性能异步框架'
  },
  'fastapi-cookiecutter': {
    command: 'cookiecutter',
    args: ['gh:tiangolo/full-stack-fastapi-postgresql'],
    timeout: 60000,
    description: 'FastAPI 全栈模板（含 PostgreSQL）'
  },
  'flask-api': {
    command: 'pip',
    args: ['install', 'flask', 'flask-cors', 'flask-compress'],
    timeout: 45000,
    description: 'Flask 轻量级 API 框架'
  },
  'django': {
    command: 'django-admin',
    args: ['startproject', 'config', '.'],
    timeout: 60000,
    description: 'Django 全栈框架'
  },

  // ========== Go ==========
  'gin-standard': {
    command: 'go',
    args: ['get', '-u', 'github.com/gin-gonic/gin'],
    timeout: 60000,
    description: 'Gin 高性能 HTTP 框架'
  },
  'echo-standard': {
    command: 'go',
    args: ['get', '-u', 'github.com/labstack/echo/v4'],
    timeout: 60000,
    description: 'Echo 高性能 HTTP 框架'
  },
  'fiber-standard': {
    command: 'go',
    args: ['get', '-u', 'github.com/gofiber/fiber/v2'],
    timeout: 60000,
    description: 'Fiber 基于 Fasthttp 的高性能框架'
  },

  // ========== Java ==========
  'spring-boot': {
    command: 'curl',
    args: ['-s', 'https://start.spring.io/starter.zip', '-o', 'project.zip', '-d', 'dependencies=web,actuator'],
    timeout: 90000,
    description: 'Spring Boot 企业级框架',
    postInstall: 'unzip project.zip && mv project/* . && rm -rf project project.zip'
  },
  'quarkus': {
    command: 'mvn',
    args: ['io.quarkus:quarkus-maven-plugin:create', '-DprojectGroupId=com.example'],
    timeout: 90000,
    description: 'Quarkus 云原生 Java 框架'
  },

  // ========== Rust ==========
  'actix-web': {
    command: 'cargo',
    args: ['new', '--bin', 'project-name'],
    timeout: 60000,
    description: 'Actix Web 高性能 Rust 框架',
    postInstall: 'cargo add actix-web tokio'
  },
  'axum': {
    command: 'cargo',
    args: ['new', '--bin', 'project-name'],
    timeout: 60000,
    description: 'Axum 模块化 Rust Web 框架',
    postInstall: 'cargo add axum tokio'
  },

  // ========== C# ==========
  'aspnet-core': {
    command: 'dotnet',
    args: ['new', 'webapi', '-n', 'ProjectName'],
    timeout: 60000,
    description: 'ASP.NET Core Web API'
  }
};

/**
 * 必备中间件标准
 * 按语言分类，每个中间件都有配置示例和说明
 */
export const REQUIRED_MIDDLEWARE: Record<string, MiddlewareSpec[]> = {
  // ========== Node.js 中间件 ==========
  'node': [
    {
      name: 'helmet',
      package: 'helmet',
      version: '^7.0.0',
      required: true,
      securityRelevance: true,
      config: `// 安全头设置，防止 XSS、点击劫持等常见攻击
app.use(helmet());`,
      description: '安全头中间件，自动设置各种安全相关的 HTTP 头'
    },
    {
      name: 'cors',
      package: 'cors',
      version: '^2.8.5',
      required: true,
      config: `// 跨域资源共享配置
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));`,
      description: 'CORS 跨域配置，允许指定来源访问 API'
    },
    {
      name: 'compression',
      package: 'compression',
      version: '^1.7.4',
      required: true,
      config: `// 响应压缩，减少传输体积
app.use(compression());`,
      description: 'Gzip 压缩响应体，减少带宽消耗'
    },
    {
      name: 'body-parser',
      package: 'express',
      version: '^4.18.0',
      required: true,
      config: `// 请求体解析
app.use(express.json({ limit: '10mb' }));      // JSON 解析
app.use(express.urlencoded({ extended: true })); // URL 编码解析`,
      description: '解析请求体，支持 JSON 和 URL 编码格式'
    },
    {
      name: 'morgan',
      package: 'morgan',
      version: '^1.10.0',
      required: true,
      config: `// HTTP 请求日志
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}`,
      description: '记录 HTTP 请求日志，便于调试和监控'
    },
    {
      name: 'express-rate-limit',
      package: 'express-rate-limit',
      version: '^6.7.0',
      required: false,
      securityRelevance: true,
      config: `// API 速率限制，防止 DDoS 攻击
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 分钟
  max: 100,                   // 限制 100 个请求
  message: '请求过于频繁，请稍后再试'
});
app.use('/api', limiter);`,
      description: 'API 速率限制，防止恶意请求'
    },
    {
      name: 'express-validator',
      package: 'express-validator',
      version: '^7.0.0',
      required: false,
      config: `// 请求参数验证
const { body, param, query, validationResult } = require('express-validator');

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// 使用示例
app.post('/api/users',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  validateRequest,
  handler
);`,
      description: '请求参数验证，防止注入攻击和无效数据'
    }
  ],

  // ========== Python 中间件 ==========
  'python': [
    {
      name: 'cors-middleware',
      package: 'starlette.middleware.cors',
      version: '*',
      required: true,
      config: `from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],  # 生产环境应设置具体域名
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)`,
      description: 'FastAPI/Starlette CORS 中间件'
    },
    {
      name: 'gzip-middleware',
      package: 'starlette.middleware.gzip',
      version: '*',
      required: true,
      config: `from starlette.middleware.gzip import GZipMiddleware

app.add_middleware(GZipMiddleware, minimum_size=1000)`,
      description: '响应压缩中间件'
    },
    {
      name: 'trusted-host',
      package: 'starlette.middleware.trustedhost',
      version: '*',
      required: true,
      securityRelevance: true,
      config: `from starlette.middleware.trustedhost import TrustedHostMiddleware

app.add_middleware(TrustedHostMiddleware, allowed_hosts=['example.com', '*.example.com'])`,
      description: '受信任主机中间件，防止 Host 头攻击'
    },
    {
      name: 'https-redirect',
      package: 'starlette.middleware.httpsredirect',
      version: '*',
      required: false,
      securityRelevance: true,
      config: `from starlette.middleware.httpsredirect import HTTPSRedirectMiddleware

app.add_middleware(HTTPSRedirectMiddleware)`,
      description: 'HTTPS 重定向中间件'
    },
    {
      name: 'session',
      package: 'starlette.middleware.sessions',
      version: '*',
      required: false,
      config: `from starlette.middleware.sessions import SessionMiddleware

app.add_middleware(
  SessionMiddleware,
  secret_key="your-secret-key-here"
)`,
      description: 'Session 会话管理'
    }
  ],

  // ========== Go 中间件 ==========
  'go': [
    {
      name: 'cors',
      package: 'github.com/gin-contrib/cors',
      version: 'latest',
      required: true,
      config: `import "github.com/gin-contrib/cors"

r.Use(cors.Default())  // 或 cors.New(cors.Config{...}) 自定义配置`,
      description: 'Gin CORS 中间件'
    },
    {
      name: 'recovery',
      package: 'github.com/gin-gonic/gin',
      version: 'latest',
      required: true,
      config: `r.Use(gin.Recovery())  // 恢复 panic，返回 500 错误`,
      description: 'Panic 恢复中间件'
    },
    {
      name: 'logger',
      package: 'github.com/gin-gonic/gin',
      version: 'latest',
      required: true,
      config: `r.Use(gin.Logger())  // 日志中间件`,
      description: '请求日志中间件'
    },
    {
      name: 'secure',
      package: 'github.com/gin-contrib/secure',
      version: 'latest',
      required: true,
      securityRelevance: true,
      config: `import "github.com/gin-contrib/secure"

r.Use(secure.New(secure.Options{
  AllowedHosts:          []string{"example.com", "*.example.com"},
  SSLRedirect:           true,
  SSLHost:               "localhost",
  STSSeconds:            315360000,
  FrameDeny:             true,
  ContentTypeNosniff:    true,
  BrowserXssFilter:      true,
  ContentSecurityPolicy: "default-src 'self'",
}))`,
      description: '安全头中间件（Go 版 Helmet）'
    }
  ]
};

/**
 * 根据语言获取脚手架命令
 */
export function getScaffoldingCommand(
  language: string,
  framework?: string
): ScaffoldingCommand | null {
  const key = framework
    ? `${framework}-${language}`.toLowerCase()
    : language.toLowerCase();

  // 直接匹配
  if (SCAFFOLDING_COMMANDS[key]) {
    return SCAFFOLDING_COMMANDS[key];
  }

  // 模糊匹配
  const matched = Object.entries(SCAFFOLDING_COMMANDS).find(([k]) =>
    k.includes(language.toLowerCase()) || k.includes(framework?.toLowerCase() || '')
  );

  return matched ? matched[1] : null;
}

/**
 * 生成中间件配置代码
 */
export function generateMiddlewareConfig(
  language: string,
  options?: {
    includeRateLimit?: boolean;
    includeValidation?: boolean;
    corsOrigin?: string;
    customMiddlewares?: string[];
  }
): { imports: string[]; configs: string[] } {
  const middlewares = REQUIRED_MIDDLEWARE[language.toLowerCase()] || [];
  const imports: string[] = [];
  const configs: string[] = [];

  for (const mw of middlewares) {
    // 跳过可选中间件（除非明确指定）
    if (!mw.required && !options?.includeRateLimit && mw.name === 'express-rate-limit') {
      continue;
    }
    if (!mw.required && !options?.includeValidation && mw.name === 'express-validator') {
      continue;
    }

    // 添加 import
    const importMatch = mw.config.match(/import.*from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      imports.push(importMatch[0]);
    }

    // 添加配置
    let config = mw.config;

    // 自定义 CORS origin
    if (mw.name === 'cors' && options?.corsOrigin) {
      config = config.replace(/origin:.*?,/, `origin: '${options.corsOrigin}',`);
    }

    configs.push(config);
  }

  // 添加自定义中间件
  if (options?.customMiddlewares) {
    configs.push(...options.customMiddlewares);
  }

  return { imports, configs };
}

/**
 * 生成 package.json 依赖部分
 */
export function generatePackageJsonDependencies(
  language: string,
  middlewares: string[] = []
): { dependencies: Record<string, string>; devDependencies: Record<string, string> } {
  const specs = REQUIRED_MIDDLEWARE[language.toLowerCase()] || [];
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};

  for (const spec of specs) {
    // 只包含指定的中间件
    if (middlewares.length > 0 && !middlewares.includes(spec.name)) {
      continue;
    }

    const pkg = spec.package.split('/')[0]; // 取主包名
    const version = spec.version || 'latest';

    // 开发依赖通常是 @types/ 包
    if (pkg.startsWith('@types/')) {
      devDependencies[pkg] = version;
    } else {
      dependencies[pkg] = version;
    }
  }

  return { dependencies, devDependencies };
}

/**
 * 验证中间件配置完整性
 */
export function validateMiddlewareConfig(
  language: string,
  code: string
): { valid: boolean; missing: string[]; warnings: string[] } {
  const middlewares = REQUIRED_MIDDLEWARE[language.toLowerCase()] || [];
  const required = middlewares.filter(m => m.required);
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const mw of required) {
    // 检查 import 是否存在
    if (!code.includes(mw.package) && !code.includes(mw.name)) {
      missing.push(mw.name);
    }
  }

  // 检查安全相关中间件
  const securityMiddlewares = middlewares.filter(m => m.securityRelevance);
  for (const mw of securityMiddlewares) {
    if (!code.includes(mw.package) && !code.includes(mw.name)) {
      warnings.push(`[安全] 建议添加 ${mw.name}: ${mw.description}`);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings
  };
}

/**
 * 获取推荐的脚手架命令列表（按语言）
 */
export function getRecommendedScaffolding(language: string): Array<{ name: string; command: ScaffoldingCommand }> {
  const all = Object.entries(SCAFFOLDING_COMMANDS);
  const filtered = all.filter(([key, cmd]) =>
    key.includes(language.toLowerCase()) ||
    cmd.description.toLowerCase().includes(language.toLowerCase())
  );

  return filtered.map(([name, cmd]) => ({ name, command: cmd }));
}
