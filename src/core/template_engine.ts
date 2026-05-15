/**
 * 模板引擎核心模块
 * 用于加载、管理和渲染项目模板，支持脚手架生成
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 模板元数据
 */
export interface TemplateMetadata {
  id: string;
  name: string;
  language: string;
  version: string;
  description: string;
  tags: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files: Record<string, string>;
  middleware: string[];
  features: Record<string, boolean>;
  scaffoldExample?: string;
}

/**
 * 模板渲染上下文
 */
export interface TemplateContext {
  // 项目信息
  projectName: string;
  port: number;
  language: string;

  // API 契约
  endpoints?: Array<{ method: string; path: string; description: string }>;

  // 功能开关
  features?: Record<string, boolean>;

  // 自定义变量
  [key: string]: any;
}

/**
 * 模板引擎类
 */
export class TemplateEngine {
  private templates: Map<string, TemplateMetadata> = new Map();
  private templateDir: string;
  private loaded = false;

  constructor(templateDir: string = path.join(process.cwd(), 'templates')) {
    this.templateDir = templateDir;
  }

  /**
   * 加载所有模板
   */
  async loadTemplates(): Promise<number> {
    if (this.loaded) {
      return this.templates.size;
    }

    const frameworksDir = path.join(this.templateDir, 'frameworks');

    // 确保目录存在
    try {
      await fs.access(frameworksDir);
    } catch {
      console.warn(`[TemplateEngine] 模板目录不存在: ${frameworksDir}`);
      await fs.mkdir(frameworksDir, { recursive: true });
      await this.createDefaultTemplates();
    }

    const entries = await fs.readdir(frameworksDir, { withFileTypes: true });
    let loaded = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(frameworksDir, entry.name, 'meta.json');
        try {
          const metaContent = await fs.readFile(metaPath, 'utf-8');
          const meta: TemplateMetadata = JSON.parse(metaContent);
          this.templates.set(meta.id, meta);
          loaded++;
          console.log(`[TemplateEngine] ✓ 已加载模板: ${meta.id} - ${meta.name}`);
        } catch (e: any) {
          console.warn(`[TemplateEngine] ✗ 跳过无效模板 ${entry.name}: ${e.message}`);
        }
      }
    }

    this.loaded = true;
    console.log(`[TemplateEngine] 共加载 ${loaded} 个模板`);
    return loaded;
  }

  /**
   * 创建默认模板（首次运行时）
   */
  private async createDefaultTemplates(): Promise<void> {
    const expressDir = path.join(this.templateDir, 'frameworks', 'express-typescript');
    await fs.mkdir(expressDir, { recursive: true });
    await fs.mkdir(path.join(expressDir, 'files'), { recursive: true });

    // 创建元数据
    const meta: TemplateMetadata = {
      id: 'express-typescript',
      name: 'Express + TypeScript',
      language: 'TypeScript',
      version: '1.0.0',
      description: '生产级 Express REST API 模板，包含完整的中间件配置',
      tags: ['api', 'rest', 'backend', 'production-ready'],
      dependencies: {
        'express': '^4.18.0',
        'cors': '^2.8.5',
        'helmet': '^7.0.0',
        'compression': '^1.7.4',
        'morgan': '^1.10.0'
      },
      devDependencies: {
        '@types/express': '^4.17.0',
        '@types/node': '^20.0.0',
        '@types/cors': '^2.8.0',
        '@types/compression': '^1.7.0',
        '@types/morgan': '^1.9.0',
        'typescript': '^5.0.0',
        'jest': '^29.0.0',
        '@types/jest': '^29.0.0',
        'ts-jest': '^29.0.0',
        'eslint': '^8.0.0',
        'prettier': '^3.0.0'
      },
      files: {
        server: 'files/server.ts',
        test: 'files/server.test.ts',
        tsconfig: 'files/tsconfig.json',
        package: 'files/package.json'
      },
      middleware: ['helmet', 'cors', 'compression', 'morgan', 'error-handler'],
      features: {
        health_check: true,
        cors: true,
        rate_limiting: false,
        websocket: false,
        static_files: true
      },
      scaffoldExample: `import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

const app: Application = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// 在此处注册路由（由 agent 在后续 subTask 中完成）

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(\`[服务] 已启动，端口 \${PORT}\`);
  });
}

export default app;`
    };

    await fs.writeFile(
      path.join(expressDir, 'meta.json'),
      JSON.stringify(meta, null, 2)
    );

    console.log(`[TemplateEngine] 已创建默认模板: express-typescript`);
  }

  /**
   * 根据语言和特性推荐模板
   */
  recommendTemplate(
    language: string,
    features: string[] = []
  ): TemplateMetadata | null {
    const candidates = Array.from(this.templates.values()).filter(
      t => t.language.toLowerCase() === language.toLowerCase()
    );

    if (candidates.length === 0) {
      return null;
    }

    // 按特性匹配度排序
    const scored = candidates.map(t => {
      const matchedFeatures = features.filter(
        f => t.features[f === 'websocket' ? 'websocket' : f] ||
             t.tags.some(tag => tag.toLowerCase().includes(f.toLowerCase()))
      );
      return { template: t, score: matchedFeatures.length };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].template;
  }

  /**
   * 简单的模板渲染（支持 {{ variable }} 和条件块）
   */
  private renderTemplate(content: string, context: TemplateContext): string {
    let result = content;

    // 处理 {{#if condition}}...{{/if}}
    result = result.replace(
      /\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, condition, body) => {
        const value = this.getNestedValue(context, condition);
        return value ? body : '';
      }
    );

    // 处理 {{#unless condition}}...{{/unless}}
    result = result.replace(
      /\{\{#unless\s+([\w.]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g,
      (_, condition, body) => {
        const value = this.getNestedValue(context, condition);
        return !value ? body : '';
      }
    );

    // 处理 {{#each items}}...{{/each}}
    result = result.replace(
      /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_, arrayName, body) => {
        const items = context[arrayName];
        if (!Array.isArray(items)) return '';

        return items.map(item => {
          let itemBody = body;
          if (typeof item === 'object' && item !== null) {
            Object.entries(item).forEach(([k, v]) => {
              itemBody = itemBody.replace(
                new RegExp(`\\{\\{${k}\\}\\}`, 'g'),
                String(v)
              );
            });
          }
          return itemBody;
        }).join('\n');
      }
    );

    // 处理 {{ variable }}
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return context[key] !== undefined ? String(context[key]) : `{{${key}}}`;
    });

    return result;
  }

  /**
   * 获取嵌套属性值
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
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
      let entries: any[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在
      }

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
          let outputPath = relativePath;
          if (entry.name.endsWith('.j2') || entry.name.endsWith('.tpl')) {
            content = this.renderTemplate(content, context);
            // 移除 .j2 或 .tpl 后缀
            outputPath = relativePath.replace(/\.j2$|\.tpl$/, '');
          }

          files.set(outputPath, content);
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

    const commands: Record<string, string> = {
      'express-typescript': `npm init -y && npm install ${Object.keys(template.dependencies || {}).join(' ')}`,
      'fastapi-python': `pip install fastapi uvicorn`,
      'nextjs-fullstack': `npx create-next-app@latest ${projectName} --typescript --tailwind --eslint`,
      'gin-go': `go mod init ${projectName} && go get -u github.com/gin-gonic/gin`
    };

    return commands[templateId] || '';
  }

  /**
   * 获取模板数量
   */
  getTemplateCount(): number {
    return this.templates.size;
  }

  /**
   * 获取所有模板
   */
  getAllTemplates(): TemplateMetadata[] {
    return Array.from(this.templates.values());
  }

  /**
   * 根据语言获取模板
   */
  getTemplatesByLanguage(language: string): TemplateMetadata[] {
    return Array.from(this.templates.values()).filter(
      t => t.language.toLowerCase() === language.toLowerCase()
    );
  }
}

// 单例实例
let templateEngineInstance: TemplateEngine | null = null;

export function getTemplateEngine(): TemplateEngine {
  if (!templateEngineInstance) {
    templateEngineInstance = new TemplateEngine();
  }
  return templateEngineInstance;
}
