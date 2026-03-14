/**
 * 分阶段代码生成系统
 * 将代码生成拆分为三个阶段：骨架、实现、测试对齐
 */

import { z } from 'zod';

/**
 * 生成阶段枚举
 */
export enum GenerationStage {
  SCAFFOLD = 'scaffold',           // 阶段 1: 骨架生成
  IMPLEMENTATION = 'implementation', // 阶段 2: 业务实现
  TEST_ALIGNMENT = 'test_alignment'  // 阶段 3: 测试对齐
}

/**
 * 文件生成状态
 */
export interface FileGenerationState {
  fileName: string;
  stage: GenerationStage;
  scaffoldCode?: string;
  implementationCode?: string;
  finalCode?: string;
  diagnostics?: {
    scaffold?: Array<{ line: number; message: string }>;
    implementation?: Array<{ line: number; message: string }>;
    final?: Array<{ line: number; message: string }>;
  };
  errors: string[];
  completed: boolean;
}

/**
 * 分阶段生成配置
 */
export interface PhasedGenerationConfig {
  enableScaffoldStage: boolean;
  enableImplementationStage: boolean;
  enableTestAlignmentStage: boolean;
  maxRetriesPerStage: number;
  skipTestAlignmentIfNoTests: boolean;
}

/**
 * 默认配置
 */
export const DEFAULT_PHASED_CONFIG: PhasedGenerationConfig = {
  enableScaffoldStage: true,
  enableImplementationStage: true,
  enableTestAlignmentStage: true,
  maxRetriesPerStage: 2,
  skipTestAlignmentIfNoTests: true
};

/**
 * Zod Schema: 骨架代码输出验证
 */
export const ScaffoldOutputSchema = z.object({
  imports: z.array(z.string()).optional(),
  exports: z.array(z.string()).optional(),
  functions: z.array(z.object({
    name: z.string(),
    parameters: z.array(z.string()).optional(),
    returnType: z.string().optional(),
    isAsync: z.boolean().optional()
  })).optional(),
  classes: z.array(z.object({
    name: z.string(),
    methods: z.array(z.string()).optional()
  })).optional(),
  code: z.string().min(1)
});

/**
 * Zod Schema: 实现代码输出验证
 */
export const ImplementationOutputSchema = z.object({
  code: z.string().min(1),
  implementedFunctions: z.array(z.string()).optional(),
  todoCount: z.number().optional(),
  linesOfCode: z.number().optional()
});

/**
 * 阶段 1: 骨架生成 Prompt 模板
 */
export function getScaffoldPrompt(options: {
  fileName: string;
  language: string;
  dependencies: string[];
  apiContract?: string;
  templateExample?: string;
}): string {
  const { fileName, language, dependencies, apiContract, templateExample } = options;

  return `【阶段 1/3: 骨架生成】
目标：创建 ${fileName} 的可编译骨架代码，包含完整的导入和空函数占位符。

【严格规则】
1. 只输出代码，用 \`\`\`${getLanguageExtension(language)} 包裹
2. 必须包含所有必要的 import/require 语句
3. 创建所有类和函数的空实现（带 JSDoc/TSDoc 注释）
4. 确保文件能通过 LSP 诊断（无语法错误、无未定义导入）
5. 严禁输出 TODO/FIXME/throw new Error('not implemented')
6. 空函数体返回合理的默认值（null/0/[]/{}）

${templateExample ? `【参考模板 - 类似项目结构】
\`\`\`${getLanguageExtension(language)}
${templateExample}
\`\`\`
` : ''}

【文件信息】
- 文件名: ${fileName}
- 语言: ${language}
- 依赖: ${dependencies.join(', ') || '无外部依赖'}

${apiContract ? `【API 契约参考】
${apiContract}
` : ''}

【输出要求】
请生成完整的骨架代码，包括：
1. 所有必要的 import 语句
2. 导出的类/函数声明（带完整类型注解）
3. 每个函数的空实现（返回类型匹配的默认值）
4. JSDoc/TSDoc 注释说明函数用途

示例：
\`\`\`${getLanguageExtension(language)}
// 导入依赖
${getImportExample(language)}

/**
 * 计算两个数的和
 * @param a - 第一个数
 * @param b - 第二个数
 * @returns 两数之和
 */
export function add(a: number, b: number): number {
  return 0; // TODO: 实现逻辑
}

/**
 * 用户服务类
 */
export class UserService {
  /**
   * 获取用户信息
   * @param userId - 用户ID
   * @returns 用户对象
   */
  async getUser(userId: string): Promise<object | null> {
    return null; // TODO: 实现逻辑
  }
}
\`\`\`

请直接输出骨架代码，不要任何解释文字。`;
}

/**
 * 阶段 2: 业务实现 Prompt 模板
 */
export function getImplementationPrompt(options: {
  fileName: string;
  scaffoldCode: string;
  taskDescription: string;
  apiContract?: string;
  testFiles?: Array<{ name: string; content: string }>;
  language: string;
}): string {
  const { fileName, scaffoldCode, taskDescription, apiContract, testFiles, language } = options;

  return `【阶段 2/3: 业务实现】
目标：在骨架代码基础上填充具体的业务逻辑。

【当前骨架代码】
\`\`\`${getLanguageExtension(language)}
${scaffoldCode}
\`\`\`

【任务描述】
${taskDescription}

${apiContract ? `【API 契约 - 必须遵守】
${apiContract}
` : ''}

${testFiles && testFiles.length > 0 ? `【相关测试 - 必须通过】
${testFiles.map(f => `
文件: ${f.name}
\`\`\`
${f.content.slice(0, 1000)}${f.content.length > 1000 ? '\n... (已截断)' : ''}
\`\`\`
`).join('\n')}
` : ''}

【实现要求】
1. 保持骨架结构不变（import、类名、函数名、函数签名）
2. 将所有 TODO/FIXME 占位符替换为实际实现
3. 确保返回值类型与契约/测试一致
4. 添加必要的错误处理（try-catch，返回适当的错误响应）
5. 添加关键路径的日志（使用 console.log 或 logger）
6. 避免硬编码，使用配置/常量

【常见模式】
${getCommonPatterns(language)}

【输出要求】
请输出完整实现代码，用 \`\`\`${getLanguageExtension(language)} 包裹。
不要保留任何 TODO/FIXME 标记。`;
}

/**
 * 阶段 3: 测试对齐 Prompt 模板
 */
export function getTestAlignmentPrompt(options: {
  fileName: string;
  implementationCode: string;
  testFiles: Array<{ name: string; content: string }>;
  testErrors?: string[];
  language: string;
}): string {
  const { fileName, implementationCode, testFiles, testErrors, language } = options;

  return `【阶段 3/3: 测试对齐】
目标：调整实现代码以通过所有测试。

【当前实现代码】
\`\`\`${getLanguageExtension(language)}
${implementationCode}
\`\`\`

【测试文件】
${testFiles.map(f => `
=== ${f.name} ===
\`\`\`
${f.content}
\`\`\`
`).join('\n')}

${testErrors && testErrors.length > 0 ? `【当前测试失败】
${testErrors.join('\n')}
` : ''}

【分析与修复步骤】
1. 对比实现代码与测试期望，找出不匹配的地方：
   - 测试调用的函数/方法是否被正确导出
   - 函数签名是否匹配（参数名、类型、顺序）
   - 返回值格式是否正确（对象结构、数组、类型）
   - 边界情况是否处理（空值、负数、异常）

2. 只修改必要的部分：
   - 添加缺失的导出
   - 调整函数签名
   - 修复返回值格式
   - 补充边界处理

3. 保持已有逻辑不变：
   - 不要改变已经正确工作的部分
   - 不要重写整个函数

【常见问题修复】
${getCommonTestFixes(language)}

【输出要求】
请输出修复后的完整代码，用 \`\`\`${getLanguageExtension(language)} 包裹。
确保所有测试用例能通过。`;
}

/**
 * 辅助函数：获取语言扩展名
 */
function getLanguageExtension(language: string): string {
  const map: Record<string, string> = {
    'typescript': 'typescript',
    'javascript': 'javascript',
    'python': 'python',
    'go': 'go',
    'java': 'java',
    'rust': 'rust',
    'c#': 'csharp'
  };
  return map[language.toLowerCase()] || language;
}

/**
 * 辅助函数：获取导入示例
 */
function getImportExample(language: string): string {
  const examples: Record<string, string> = {
    'typescript': `import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';`,
    'javascript': `const express = require('express');
const { z } = require('zod');`,
    'python': `from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List`,
    'go': `import (
    "github.com/gin-gonic/gin"
    "net/http"
)`,
    'java': `import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;`
  };
  return examples[language.toLowerCase()] || '';
}

/**
 * 辅助函数：获取常见代码模式
 */
function getCommonPatterns(language: string): string {
  const patterns: Record<string, string> = {
    'typescript': `
\`\`\`typescript
// 1. 错误处理模式
try {
  const result = await someOperation();
  return { success: true, data: result };
} catch (error) {
  console.error('操作失败:', error);
  return { success: false, error: error.message };
}

// 2. 参数验证模式
const schema = z.object({
  name: z.string().min(1),
  email: z.string().email()
});
const validated = schema.parse(input);

// 3. 异步模式
async function processData(id: string): Promise<Result> {
  const data = await fetchData(id);
  return transform(data);
}
\`\`\``,
    'python': `
\`\`\`python
# 1. 错误处理模式
try:
    result = some_operation()
    return {"success": True, "data": result}
except Exception as e:
    logger.error(f"操作失败: {e}")
    raise HTTPException(status_code=500, detail=str(e))

# 2. 参数验证模式
from pydantic import BaseModel, validator

class CreateUserRequest(BaseModel):
    name: str
    email: str

    @validator('email')
    def email_must_be_valid(cls, v):
        if '@' not in v:
            raise ValueError('必须是有效的邮箱')
        return v

# 3. 异步模式
async def process_data(id: str) -> dict:
    data = await fetch_data(id)
    return transform(data)
\`\`\``
  };
  return patterns[language.toLowerCase()] || '';
}

/**
 * 辅助函数：获取常见测试修复
 */
function getCommonTestFixes(language: string): string {
  const fixes: Record<string, string> = {
    'typescript': `
\`\`\`typescript
// 问题：函数未导出
// 修复：添加 export 关键字
export function myFunction() { ... }

// 问题：测试无法调用私有方法
// 修复：提取为独立的公共函数或提供测试接口
export function internalLogic(input: any) { ... }

// 问题：返回值格式不匹配
// 修复：调整返回格式以匹配测试期望
// 测试期望: { data: string }
return { data: result };  // 而不是 return result;

// 问题：未处理的 Promise rejection
// 修复：添加 try-catch 和正确的错误传播
async function handler() {
  try {
    const result = await operation();
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
\`\`\``,
    'python': `
\`\`\`python
# 问题：函数未在模块中导出
# 修复：在 __all__ 中声明或直接从路由导入
__all__ = ['my_function']

# 问题：测试无法访问异步结果
# 修复：确保使用 await 或事件循环
async def test_my_function():
    result = await my_function()
    assert result is not None

# 问题：返回值格式不匹配
# 修复：使用 Pydantic 模型确保格式一致
class Response(BaseModel):
    data: str
    success: bool

return Response(data=result, success=True)

# 问题：未处理的异常
# 修复：添加 try-except 并返回适当的错误响应
try:
    result = operation()
    return {"success": True, "data": result}
except Exception as e:
    return {"success": False, "error": str(e)}
\`\`\``
  };
  return fixes[language.toLowerCase()] || '';
}

/**
 * 验证骨架代码质量
 */
export function validateScaffoldCode(code: string, language: string): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // 检查是否有 TODO/FIXME
  if (/TODO|FIXME|throw new Error\('not implemented'\)/.test(code)) {
    issues.push('骨架代码不应包含 TODO/FIXME 标记');
  }

  // 检查导入语句
  if (!/import|require|from/.test(code)) {
    issues.push('骨架代码缺少导入语句');
  }

  // 检查导出语句
  if (!/export|module\.exports/.test(code)) {
    issues.push('骨架代码缺少导出语句');
  }

  // 检查函数/类定义
  const hasFunction = /function\s+\w+|const\s+\w+\s*=\s*\(|class\s+\w+|def\s+\w+/.test(code);
  if (!hasFunction) {
    issues.push('骨架代码不包含任何函数或类定义');
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

/**
 * 验证实现代码质量
 */
export function validateImplementationCode(code: string, language: string): {
  valid: boolean;
  issues: string[];
  stats: {
    todoCount: number;
    linesOfCode: number;
    functionCount: number;
  };
} {
  const issues: string[] = [];
  const todoMatches = code.match(/TODO|FIXME/g) || [];
  const lines = code.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));
  const functionMatches = code.match(/function\s+\w+|const\s+\w+\s*=\s*\([^)]*\)\s*=>|def\s+\w+/g) || [];

  // 检查 TODO 数量
  if (todoMatches.length > 3) {
    issues.push(`实现代码包含 ${todoMatches.length} 个 TODO 标记，应该实现更多逻辑`);
  }

  // 检查代码行数
  if (lines.length < 10) {
    issues.push('实现代码过短，可能缺少必要逻辑');
  }

  // 检查是否有实际逻辑（不仅是返回固定值）
  const hasLogic = /if\s*\(|for\s*\(|while\s*\(|\.map\(|\.filter\(|\.reduce\(|try\s*\{/.test(code);
  if (!hasLogic && lines.length > 20) {
    issues.push('实现代码缺少控制流语句，可能只是返回固定值');
  }

  return {
    valid: issues.length === 0,
    issues,
    stats: {
      todoCount: todoMatches.length,
      linesOfCode: lines.length,
      functionCount: functionMatches.length
    }
  };
}

/**
 * 提取代码块（从 LLM 响应中）
 */
export function extractCodeBlock(response: string, language?: string): string {
  // 尝试匹配 markdown 代码块
  const codeBlockRegex = /```(?:\w*)\n([\s\S]*?)```/g;
  const matches = Array.from(response.matchAll(codeBlockRegex));

  if (matches.length > 0) {
    // 返回最长的代码块
    return matches.reduce((longest, current) =>
      current[1].length > longest[1].length ? current : longest
    )[1];
  }

  // 尝试匹配特定语言的代码块
  if (language) {
    const langRegex = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``);
    const langMatch = response.match(langRegex);
    if (langMatch) {
      return langMatch[1];
    }
  }

  // 没有代码块，返回原文本
  return response;
}

/**
 * 生成阶段摘要
 */
export function generateStageSummary(
  stage: GenerationStage,
  fileName: string,
  success: boolean,
  details?: any
): string {
  const stageNames: Record<GenerationStage, string> = {
    [GenerationStage.SCAFFOLD]: '骨架生成',
    [GenerationStage.IMPLEMENTATION]: '业务实现',
    [GenerationStage.TEST_ALIGNMENT]: '测试对齐'
  };

  const status = success ? '✅' : '❌';
  let summary = `${status} [${stageNames[stage]}] ${fileName}`;

  if (details) {
    if (stage === GenerationStage.SCAFFOLD && details.functions) {
      summary += ` (${details.functions.length} 个函数)`;
    }
    if (stage === GenerationStage.IMPLEMENTATION && details.stats) {
      summary += ` (${details.stats.linesOfCode} 行, ${details.stats.todoCount} TODO)`;
    }
    if (details.errors && details.errors.length > 0) {
      summary += ` - 错误: ${details.errors[0]}`;
    }
  }

  return summary;
}
