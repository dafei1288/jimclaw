import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Skill 定义
 * 借鉴 Claude Code，Skill 是一个带有 Schema 校验的可执行逻辑
 */
export interface SkillConfig<T extends z.ZodObject<any>> {
  name: string;
  description: string;
  schema: T;
  run: (input: z.infer<T>) => Promise<string>;
}

export class Skill<T extends z.ZodObject<any>> {
  constructor(public config: SkillConfig<T>) {}

  /**
   * 将 Skill 转换为 LangChain 可用的 Tool
   */
  toTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: this.config.name,
      description: this.config.description,
      schema: this.config.schema,
      func: async (input) => {
        try {
          return await this.config.run(input);
        } catch (error: any) {
          return `Error executing skill ${this.config.name}: ${error.message}`;
        }
      },
    });
  }
}
