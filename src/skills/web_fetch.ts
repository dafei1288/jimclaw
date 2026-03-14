import { z } from "zod";
import { Skill } from "../core/skill";

/**
 * Web 获取技能：获取网页内容并提取主要文本
 *
 * 支持多种内容格式：
 * - JSON 数据（自动格式化）
 * - HTML 页面（提取主要文本）
 * - 纯文本（直接返回）
 */
export const WebFetchSkill = new Skill({
  name: "web_fetch",
  description: "获取指定 URL 的网页内容，自动提取主要文本并去除广告、导航等噪音。支持 HTML、JSON、纯文本等格式。",
  schema: z.object({
    url: z.string().url().describe("要获取的网页 URL（必须是完整的 URL，包含 https:// 或 http://）"),
    format: z.enum(["auto", "json", "text", "html"]).optional().default("auto").describe("返回格式：auto=自动检测，json=JSON 格式化，text=纯文本，html=保留 HTML 结构"),
  }),
  run: async ({ url, format }) => {
    try {
      console.log(`[WebFetch] 获取: ${url}`);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; JimClaw/1.0; +https://github.com/jimclaw)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        },
        // 10 秒超时
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let content = await response.text();

      // 自动检测格式
      if (format === 'auto') {
        if (contentType.includes('json')) {
          format = 'json';
        } else if (contentType.includes('html')) {
          format = 'text'; // HTML 提取为文本
        } else {
          format = 'text';
        }
      }

      // JSON 格式化
      if (format === 'json') {
        try {
          const jsonData = JSON.parse(content);
          return JSON.stringify(jsonData, null, 2);
        } catch {
          // 如果解析失败，返回原始内容
          return content;
        }
      }

      // HTML 提取主要文本
      if (contentType.includes('html') && format === 'text') {
        content = extractMainContent(content, url);
      }

      // 限制返回长度（避免过长）
      const maxLength = 10000;
      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + `\n\n... (内容已截断，共 ${content.length} 字符)`;
      }

      return content;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return `请求超时（10秒）。可能原因：\n1. 网站响应慢\n2. 网络不稳定\n3. URL 不正确`;
      }
      if (error.code === 'ENOTFOUND') {
        return `无法找到该网站。请检查：\n1. URL 是否正确\n2. 网站是否可以访问\n3. 是否需要使用代理`;
      }
      return `获取网页失败: ${error.message}`;
    }
  },
});

/**
 * 从 HTML 中提取主要内容
 * 简单的启发式算法：移除 script、style、nav 等标签，保留主要内容
 */
function extractMainContent(html: string, url: string): string {
  // 移除 script 标签（包含多行内容）
  html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '');

  // 移除 style 标签（包含多行内容）
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '');

  // 移除 nav、header、footer、aside 等标签（包含多行内容）
  html = html.replace(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi, '');
  html = html.replace(/<header\b[^>]*>([\s\S]*?)<\/header>/gi, '');
  html = html.replace(/<footer\b[^>]*>([\s\S]*?)<\/footer>/gi, '');
  html = html.replace(/<aside\b[^>]*>([\s\S]*?)<\/aside>/gi, '');
  html = html.replace(/<menu\b[^>]*>([\s\S]*?)<\/menu>/gi, '');

  // 移除注释（包含多行内容）
  html = html.replace(/<!--([\s\S]*?)-->/gi, '');

  // 提取 body 或 main 内容
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  let content = mainMatch ? mainMatch[1] : (bodyMatch ? bodyMatch[1] : html);

  // 移除所有 HTML 标签
  content = content.replace(/<[^>]+>/g, '');

  // 解码 HTML 实体
  content = content
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  // 清理多余的空白
  content = content
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  // 添加来源说明
  const source = new URL(url).hostname;
  return `【来源: ${source}】\n\n${content}`;
}
