/**
 * 分阶段代码生成器
 * 在 Coder 节点中实现三阶段代码生成：骨架 -> 实现 -> 测试对齐
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseAgent } from './agent';
import {
  GenerationStage,
  getScaffoldPrompt,
  getImplementationPrompt,
  getTestAlignmentPrompt,
  validateScaffoldCode,
  validateImplementationCode,
  extractCodeBlock,
  generateStageSummary,
  type FileGenerationState,
  type PhasedGenerationConfig,
  DEFAULT_PHASED_CONFIG
} from './phased_generation';

/**
 * 分阶段生成上下文
 */
export interface PhasedGenerationContext {
  workspaceDir: string;
  language: string;
  projectBrief: string[];
  apiContract?: any;
  templateMetadata?: any;
  filesContent: Record<string, string>;
  subTasks: any[];
  qaFailures?: any;
  mediationDirectives?: any[];
}

/**
 * 分阶段生成选项
 */
export interface PhasedGenerationOptions {
  emit: (type: string, sender: string, content: string, metadata?: any) => void;
  agent: BaseAgent;
  onProgress?: (stage: GenerationStage, fileName: string, summary: string) => void;
}

/**
 * 分阶段生成结果
 */
export interface PhasedGenerationResult {
  code: string;
  fileStates: Record<string, FileGenerationState>;
  codeLogEntries: any[];
  projectBriefAdditions: string[];
}

/**
 * 执行分阶段代码生成
 */
export async function executePhasedGeneration(
  context: PhasedGenerationContext,
  config: PhasedGenerationConfig = DEFAULT_PHASED_CONFIG,
  options: PhasedGenerationOptions
): Promise<PhasedGenerationResult> {
  const {
    workspaceDir,
    language,
    projectBrief,
    apiContract,
    templateMetadata,
    filesContent,
    subTasks,
    qaFailures,
    mediationDirectives
  } = context;

  const { emit, agent, onProgress } = options;

  const fileStates: Record<string, FileGenerationState> = {};
  const codeLogEntries: any[] = [];
  const projectBriefAdditions: string[] = [];
  const currentRetry = 0; // 可以从外部传入

  for (const task of subTasks) {
    if (task.status === 'completed' && currentRetry === 0) continue;

    const fileState: FileGenerationState = {
      fileName: task.fileTarget,
      stage: GenerationStage.SCAFFOLD,
      errors: [],
      completed: false
    };

    // ========== 阶段 1: 骨架生成 ==========
    if (config.enableScaffoldStage) {
      emit('thinking', agent.getPersona().name, `[1/3] 生成骨架: ${task.fileTarget}`, { task });

      const scaffoldPrompt = getScaffoldPrompt({
        fileName: task.fileTarget,
        language,
        dependencies: task.dependencies || [],
        apiContract: apiContract?.endpoints
          ? JSON.stringify(apiContract.endpoints, null, 2)
          : undefined,
        templateExample: templateMetadata?.scaffoldExample
      });

      const scaffoldResp = await agent.chat(
        [{ role: 'user', content: scaffoldPrompt }],
        (ev) => emit(ev.type, ev.sender, '骨架生成中', ev),
        { mode: 'coding', brief: projectBrief }
      );

      const scaffoldCode = extractCodeBlock(extractText(scaffoldResp.content), language);

      // 验证骨架代码
      const validation = validateScaffoldCode(scaffoldCode, language);
      if (!validation.valid) {
        console.warn(`[Coder] 骨架验证失败: ${validation.issues.join(', ')}`);
        fileState.errors.push(...validation.issues);
        fileState.scaffoldCode = scaffoldCode;
        fileState.diagnostics = { scaffold: validation.issues.map(i => ({ line: 0, message: i })) };

        if (onProgress) {
          onProgress(GenerationStage.SCAFFOLD, task.fileTarget, generateStageSummary(GenerationStage.SCAFFOLD, task.fileTarget, false, { errors: validation.issues }));
        }

        // 继续下一个文件
        fileStates[task.fileTarget] = fileState;
        continue;
      }

      fileState.scaffoldCode = scaffoldCode;
      fileState.stage = GenerationStage.IMPLEMENTATION;

      if (onProgress) {
        onProgress(GenerationStage.SCAFFOLD, task.fileTarget, generateStageSummary(GenerationStage.SCAFFOLD, task.fileTarget, true));
      }

      console.log(`[Coder] ✓ 骨架生成成功: ${task.fileTarget}`);
    }

    // ========== 阶段 2: 业务实现 ==========
    if (config.enableImplementationStage && fileState.stage === GenerationStage.IMPLEMENTATION) {
      emit('thinking', agent.getPersona().name, `[2/3] 填充业务逻辑: ${task.fileTarget}`, { task });

      // 收集测试文件内容
      const testFiles = subTasks
        .filter(t => /test|spec/i.test(t.fileTarget))
        .map(t => ({
          name: t.fileTarget,
          content: filesContent[t.fileTarget] || ''
        }));

      const implPrompt = getImplementationPrompt({
        fileName: task.fileTarget,
        scaffoldCode: fileState.scaffoldCode!,
        taskDescription: task.description,
        apiContract: apiContract?.endpoints
          ? JSON.stringify(apiContract.endpoints, null, 2)
          : undefined,
        testFiles,
        language
      });

      const implResp = await agent.chat(
        [{ role: 'user', content: implPrompt }],
        (ev) => emit(ev.type, ev.sender, '业务实现中', ev),
        { mode: 'coding', brief: projectBrief }
      );

      const implCode = extractCodeBlock(extractText(implResp.content), language);

      // 验证实现代码
      const validation = validateImplementationCode(implCode, language);

      if (!validation.valid && validation.stats.todoCount > 3) {
        console.warn(`[Coder] 实现验证失败: ${validation.issues.join(', ')}`);
        fileState.errors.push(...validation.issues);

        // 回退到骨架阶段重试
        fileState.stage = GenerationStage.SCAFFOLD;

        if (onProgress) {
          onProgress(GenerationStage.IMPLEMENTATION, task.fileTarget, generateStageSummary(GenerationStage.IMPLEMENTATION, task.fileTarget, false, validation));
        }

        fileStates[task.fileTarget] = fileState;
        continue;
      }

      fileState.implementationCode = implCode;
      fileState.stage = GenerationStage.TEST_ALIGNMENT;

      if (onProgress) {
        onProgress(GenerationStage.IMPLEMENTATION, task.fileTarget, generateStageSummary(GenerationStage.IMPLEMENTATION, task.fileTarget, true, validation));
      }

      console.log(`[Coder] ✓ 业务实现完成: ${task.fileTarget} (${validation.stats.linesOfCode} 行, ${validation.stats.todoCount} TODO)`);
    }

    // ========== 阶段 3: 测试对齐 ==========
    const hasTestFiles = subTasks.some(t => /test|spec/i.test(t.fileTarget));
    const shouldAlignWithTests = config.enableTestAlignmentStage &&
                                fileState.stage === GenerationStage.TEST_ALIGNMENT &&
                                hasTestFiles;

    if (shouldAlignWithTests) {
      emit('thinking', agent.getPersona().name, `[3/3] 对齐测试: ${task.fileTarget}`, { task });

      // 提取测试文件内容
      const testFiles = subTasks
        .filter(t => /test|spec/i.test(t.fileTarget))
        .map(t => ({
          name: t.fileTarget,
          content: filesContent[t.fileTarget] || ''
        }));

      const alignPrompt = getTestAlignmentPrompt({
        fileName: task.fileTarget,
        implementationCode: fileState.implementationCode!,
        testFiles,
        testErrors: qaFailures?.testErrors,
        language
      });

      const alignResp = await agent.chat(
        [{ role: 'user', content: alignPrompt }],
        (ev) => emit(ev.type, ev.sender, '测试对齐中', ev),
        { mode: 'coding', brief: projectBrief }
      );

      const finalCode = extractCodeBlock(extractText(alignResp.content), language);

      fileState.finalCode = finalCode;
      fileState.completed = true;
      fileState.stage = GenerationStage.TEST_ALIGNMENT;

      if (onProgress) {
        onProgress(GenerationStage.TEST_ALIGNMENT, task.fileTarget, generateStageSummary(GenerationStage.TEST_ALIGNMENT, task.fileTarget, true));
      }

      console.log(`[Coder] ✓ 测试对齐完成: ${task.fileTarget}`);

      // 写入文件
      const filePath = path.join(workspaceDir, task.fileTarget);
      await fs.writeFile(filePath, finalCode, 'utf-8');

      codeLogEntries.push({
        round: currentRetry,
        file: task.fileTarget,
        taskTitle: task.description.slice(0, 80),
        status: 'written'
      });

      projectBriefAdditions.push(`[Coder] ${task.fileTarget}: 分阶段生成完成`);
    } else if (fileState.implementationCode) {
      // 没有测试文件或跳过测试对齐，直接使用实现代码
      const finalCode = fileState.implementationCode;

      fileState.completed = true;
      fileState.finalCode = finalCode;
      fileState.stage = GenerationStage.IMPLEMENTATION;

      // 写入文件
      const filePath = path.join(workspaceDir, task.fileTarget);
      await fs.writeFile(filePath, finalCode, 'utf-8');

      codeLogEntries.push({
        round: currentRetry,
        file: task.fileTarget,
        taskTitle: task.description.slice(0, 80),
        status: 'written'
      });

      console.log(`[Coder] ✓ 文件写入完成: ${task.fileTarget}`);
    }

    fileStates[task.fileTarget] = fileState;
  }

  // 构建最终代码对象
  const code: Record<string, string> = {};
  for (const [fileName, state] of Object.entries(fileStates)) {
    if (state.finalCode) {
      code[fileName] = state.finalCode;
    }
  }

  return {
    code: JSON.stringify(code),
    fileStates,
    codeLogEntries,
    projectBriefAdditions
  };
}

/**
 * 兼容模式：将现有单次生成转换为分阶段生成
 */
export async function executeLegacyGeneration(
  context: PhasedGenerationContext,
  options: PhasedGenerationOptions
): Promise<PhasedGenerationResult> {
  // 这里保持现有的单次生成逻辑不变
  // 只是包装成相同的接口返回

  const { workspaceDir, subTasks } = context;

  const fileStates: Record<string, FileGenerationState> = {};
  const codeLogEntries: any[] = [];
  const projectBriefAdditions: string[] = [];

  // 现有的实现逻辑在 graph.ts 的 coder 节点中
  // 这里只是占位符，实际使用时需要迁移现有逻辑

  return {
    code: '{}',
    fileStates,
    codeLogEntries,
    projectBriefAdditions
  };
}

/**
 * 工具函数：提取文本内容
 */
function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => typeof b === 'string' || b.type === 'text')
      .map((b: any) => typeof b === 'string' ? b : b.text)
      .join('\n');
  }
  return String(content);
}
