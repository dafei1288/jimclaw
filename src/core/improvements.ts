/**
 * JimClaw 改进模块导出
 *
 * 此文件聚合三项核心改进的模块导出：
 * 1. 模板库系统 (Template Engine)
 * 2. 分阶段生成系统 (Phased Generation)
 * 3. 脚手架与中间件标准 (Scaffolding & Middleware Standards)
 */

// ========== 值导入 ==========
import { getScaffoldingCommand, REQUIRED_MIDDLEWARE, SCAFFOLDING_COMMANDS, generateMiddlewareConfig, generatePackageJsonDependencies, validateMiddlewareConfig } from './middleware_standards';
import { getTemplateEngine, type TemplateEngine } from './template_engine';
import { getScaffoldPrompt, getImplementationPrompt, getTestAlignmentPrompt, validateScaffoldCode, validateImplementationCode, extractCodeBlock, generateStageSummary, DEFAULT_PHASED_CONFIG } from './phased_generation';
import type { ScaffoldingCommand } from './middleware_standards';
import type { MiddlewareSpec } from './middleware_standards';
import type { TemplateMetadata, TemplateContext } from './template_engine';
import type { GenerationStage, FileGenerationState, PhasedGenerationConfig } from './phased_generation';

// ========== 重新导出（供外部使用） ==========

// 模板引擎
export { TemplateEngine, getTemplateEngine };
export type { TemplateMetadata, TemplateContext };

// 分阶段生成
export {
  getScaffoldPrompt,
  getImplementationPrompt,
  getTestAlignmentPrompt,
  validateScaffoldCode,
  validateImplementationCode,
  extractCodeBlock,
  generateStageSummary,
  DEFAULT_PHASED_CONFIG
};
export type { FileGenerationState, PhasedGenerationConfig };

// 脚手架与中间件标准
export {
  SCAFFOLDING_COMMANDS,
  REQUIRED_MIDDLEWARE,
  getScaffoldingCommand,
  generateMiddlewareConfig,
  generatePackageJsonDependencies,
  validateMiddlewareConfig
};
export type { ScaffoldingCommand, MiddlewareSpec };

// 重新导出 GenerationStage 枚举（作为值）
export { GenerationStage } from './phased_generation';

// ========== 便捷函数 ==========

/**
 * 一键获取完整的脚手架配置（命令 + 中间件）
 */
export async function getScaffoldingSetup(
  language: string,
  framework?: string
): Promise<{
  command: ScaffoldingCommand | null;
  middlewares: MiddlewareSpec[];
  imports: string[];
  configs: string[];
  packageJson: { dependencies: Record<string, string>; devDependencies: Record<string, string> };
}> {
  // 获取脚手架命令
  const command = getScaffoldingCommand(language, framework);

  // 获取中间件配置
  const middlewareList = REQUIRED_MIDDLEWARE[language.toLowerCase()] || [];
  const { imports, configs } = generateMiddlewareConfig(language);

  // 生成 package.json 依赖
  const packageJson = generatePackageJsonDependencies(
    language,
    middlewareList.map(m => m.name)
  );

  return {
    command,
    middlewares: middlewareList,
    imports,
    configs,
    packageJson
  };
}

/**
 * 推荐最佳模板（基于语言和需求）
 */
export async function recommendBestTemplate(
  language: string,
  features: string[] = []
): Promise<TemplateMetadata | null> {
  const engine = getTemplateEngine();
  await engine.loadTemplates();
  return engine.recommendTemplate(language, features);
}

/**
 * 验证项目配置完整性
 */
export function validateProjectConfig(
  language: string,
  code: string,
  requirements?: {
    hasRateLimit?: boolean;
    hasValidation?: boolean;
    corsOrigin?: string;
  }
): {
  valid: boolean;
  missing: string[];
  warnings: string[];
  summary: string;
} {
  const middlewareResult = validateMiddlewareConfig(language, code);
  const issues: string[] = [...middlewareResult.missing];
  const warnings: string[] = [...middlewareResult.warnings];

  // 检查特定需求
  if (requirements?.hasRateLimit) {
    if (!code.includes('rate-limit') && !code.includes('rateLimit')) {
      issues.push('速率限制中间件未配置');
    }
  }

  if (requirements?.hasValidation) {
    if (!code.includes('validator') && !code.includes('zod') && !code.includes('joi')) {
      warnings.push('建议添加请求验证中间件');
    }
  }

  // 生成摘要
  const summary = issues.length === 0 && warnings.length === 0
    ? '✅ 项目配置完整，符合最佳实践'
    : `⚠️ 发现 ${issues.length} 个问题，${warnings.length} 个警告`;

  return {
    valid: issues.length === 0,
    missing: issues,
    warnings,
    summary
  };
}

/**
 * 创建完整的项目生成计划
 */
export async function createProjectPlan(options: {
  language: string;
  framework?: string;
  features?: string[];
  projectName?: string;
  port?: number;
}): Promise<{
  template: TemplateMetadata | null;
  scaffolding: {
    command: ScaffoldingCommand | null;
    middlewares: MiddlewareSpec[];
  };
  validation: {
    checks: string[];
    middlewareRequired: string[];
  };
}> {
  const engine = getTemplateEngine();
  await engine.loadTemplates();

  const template = await engine.recommendTemplate(
    options.language,
    options.features || []
  );

  const scaffolding = await getScaffoldingSetup(options.language, options.framework);

  const validation = {
    checks: [
      '语法检查',
      '类型检查',
      '中间件完整性',
      '安全配置'
    ],
    middlewareRequired: scaffolding.middlewares
      .filter(m => m.required)
      .map(m => m.name)
  };

  return {
    template,
    scaffolding,
    validation
  };
}
