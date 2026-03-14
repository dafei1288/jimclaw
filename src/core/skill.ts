import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Skill 定义
 * 借鉴 Claude Code，Skill 是一个带有 Schema 校验的可执行逻辑
 */
export interface SkillContext {
  workspaceDir?: string;
}

export interface SkillConfig<T extends z.ZodObject<any>> {
  name: string;
  description: string;
  schema: T;
  run: (input: z.infer<T>, context?: SkillContext) => Promise<string>;
}

export class Skill<T extends z.ZodObject<any>> {
  constructor(public config: SkillConfig<T>) {}

  /**
   * 将 Skill 转换为 LangChain 可用的 Tool
   */
  toTool(context?: SkillContext): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: this.config.name,
      description: this.config.description,
      schema: this.config.schema,
      func: async (input) => {
        try {
          return await this.config.run(input, context);
        } catch (error: any) {
          return `Error executing skill ${this.config.name}: ${error.message}`;
        }
      },
    });
  }
}
