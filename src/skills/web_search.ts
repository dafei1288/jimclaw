import { z } from "zod";
import { Skill } from "../core/skill";

/**
 * Web 搜索技能：使用 DuckDuckGo 获取网络信息
 *
 * 注意：这是一个轻量级的免费搜索方案，适合获取即时信息。
 * 对于更复杂的需求，可以考虑升级到 Tavily、SerpAPI 等付费服务。
 */
export const WebSearchSkill = new Skill({
  name: "web_search",
  description: "在网络上搜索信息，用于查找最新文档、错误解决方案、技术规范等。返回搜索结果的摘要和链接。",
  schema: z.object({
    query: z.string().describe("搜索关键词或问题（建议使用英文以获得更好结果）"),
    maxResults: z.number().optional().default(5).describe("返回的最大结果数量"),
  }),
  run: async ({ query, maxResults }) => {
    try {
      console.log(`[WebSearch] 搜索: ${query}`);

      // 使用 DuckDuckGo Instant Answer API（免费，无需 API key）
      // 注意：这个 API 主要用于即时答案，对于复杂搜索可能不够理想
      const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=0`;

      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; JimClaw/1.0)'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as Record<string, any>;

      // DuckDuckGo 返回格式解析
      const results: string[] = [];

      // AbstractTopic（即时答案）
      if (data.Abstract) {
        results.push(`【摘要】${data.Abstract}`);
        if (data.AbstractSource) {
          results.push(`来源: ${data.AbstractURL}`);
        }
      }

      // AbstractText（简短答案）
      if (data.AbstractText && data.AbstractText !== data.Abstract) {
        results.push(`【简答】${data.AbstractText}`);
      }

      // Heading（主题标题）
      if (data.Heading) {
        results.push(`【主题】${data.Heading}`);
      }

      // RelatedTopics（相关主题）
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        const topics = data.RelatedTopics
          .slice(0, maxResults)
          .map((topic: any) => {
            if (topic.Text && topic.FirstURL) {
              return `• ${topic.Text} → ${topic.FirstURL}`;
            }
            return null;
          })
          .filter(Boolean);

        if (topics.length > 0) {
          results.push(`\n【相关结果】\n${topics.join('\n')}`);
        }
      }

      // Results（搜索结果）
      if (data.Results && Array.isArray(data.Results)) {
        const searchResults = data.Results
          .slice(0, maxResults)
          .map((r: any) => `• ${r.Text} → ${r.FirstURL}`)
          .join('\n');
        if (searchResults) {
          results.push(`\n【搜索结果】\n${searchResults}`);
        }
      }

      // Answer（类型答案）
      if (data.Answer) {
        results.push(`\n【答案】${data.Answer}`);
      }

      // AnswerType（答案类型）
      if (data.AnswerType) {
        results.push(`类型: ${data.AnswerType}`);
      }

      // Definition（定义）
      if (data.Definition) {
        results.push(`\n【定义】${data.Definition}`);
        if (data.DefinitionSource) {
          results.push(`来源: ${data.DefinitionURL}`);
        }
      }

      if (results.length === 0) {
        return `未找到相关结果。建议：\n1. 使用更具体的搜索词\n2. 使用英文关键词（如 'Express.js routing example'）\n3. 尝试不同的表达方式`;
      }

      return results.join('\n');
    } catch (error: any) {
      // 网络错误时的降级处理
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return `搜索服务暂时不可用。建议：\n1. 检查网络连接\n2. 稍后重试\n3. 基于已有知识进行推断`;
      }
      return `搜索失败: ${error.message}`;
    }
  },
});
