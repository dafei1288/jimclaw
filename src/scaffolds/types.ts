/**
 * Scaffold 提供者抽象层
 *
 * 设计原则：
 * - 每个 ScaffoldProvider 对应一种 language+framework 组合
 * - Express/TS 的现有代码通过 ExpressTypeScriptProvider 包装，不改原始逻辑
 * - 新语言只需添加 Provider 实现并注册
 */

/** Provider 可上下文信息 */
export interface ScaffoldContext {
  port: number;
  projectName: string;
  description: string;
  language: string;
  framework: string;
  declaredFiles: Set<string>;
  hasAuth: boolean;
  hasHealthRoute: boolean;
  hasFrontendPage: boolean;
  hasLogger: boolean;
  loggerModulePath: string | null;
  hasErrorHandler: boolean;
  errorHandlerModulePath: string | null;
  routeFiles: string[];
  apiContract: any;
  contract: any;
  spec: any;
  manifest: any;
  consensusCore: any;
  requirementProtocol: any;
}

/** Scaffold 提供者接口 */
export interface ScaffoldProvider {
  /** 唯一标识，如 "express-typescript", "fastapi-python" */
  id: string;

  /** 支持的语言（小写） */
  language: string;

  /** 支持的框架（小写，含通配符 * ） */
  frameworks: string[];

  /** 判断该 Provider 能否处理给定的目标文件 */
  canHandle(ctx: ScaffoldContext, normalizedTarget: string): boolean;

  /** 为目标文件生成 scaffold 代码。返回 null 表示不处理 */
  generate(ctx: ScaffoldContext, normalizedTarget: string): string | null;

  /** 该技术栈的文件扩展名 */
  fileExtensions(): string[];

  /** 测试命令 */
  testCommand(spec: any): string;

  /** 运行命令 */
  runCommand(spec: any, port: number): string;

  /** Docker 基础镜像 */
  baseDockerImage(): string;

  /** 在容器内安装依赖 */
  installCommand(spec: any): string;

  /** 入口文件路径（相对项目根） */
  entryFilePath(spec: any): string;

  /** 测试文件匹配模式 */
  testFilePattern(): string;

  /** 该 Provider 优先级（数字越小越优先） */
  priority(): number;
}

// ── Provider 注册表 ──

const providers: ScaffoldProvider[] = [];

export function registerScaffoldProvider(provider: ScaffoldProvider): void {
  providers.push(provider);
  providers.sort((a, b) => a.priority() - b.priority());
}

export function findScaffoldProvider(
  language: string,
  framework: string
): ScaffoldProvider | null {
  const lang = language.toLowerCase().trim();
  const fw = framework.toLowerCase().trim();
  for (const p of providers) {
    if (p.language.toLowerCase() !== lang) continue;
    if (p.frameworks.some((f) => f === "*" || f === fw || fw.includes(f))) {
      return p;
    }
  }
  return null;
}

export function getScaffoldProviderById(id: string): ScaffoldProvider | null {
  return providers.find((p) => p.id === id) || null;
}

export function getAllScaffoldProviders(): ScaffoldProvider[] {
  return [...providers];
}

/** 根据 language+framework 推断 templateId */
export function inferTemplateId(language: string, framework: string): string | null {
  const provider = findScaffoldProvider(language, framework);
  return provider?.id || null;
}
