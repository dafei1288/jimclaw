/**
 * 通用工具函数库
 */

/**
 * 获取北京时间（东八区）字符串
 */
export function getBeijingTime(): string {
  const date = new Date();
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const beijingDate = new Date(utc + (3600000 * 8));
  
  const y = beijingDate.getFullYear();
  const m = String(beijingDate.getMonth() + 1).padStart(2, '0');
  const d = String(beijingDate.getDate()).padStart(2, '0');
  const hh = String(beijingDate.getHours()).padStart(2, '0');
  const mm = String(beijingDate.getMinutes()).padStart(2, '0');
  const ss = String(beijingDate.getSeconds()).padStart(2, '0');
  
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/**
 * 从 LLM 返回的多样化内容中提取纯文本
 */
export function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => typeof b === "string" || b.type === "text")
      .map((b: any) => typeof b === "string" ? b : b.text)
      .join("\n");
  }
  return String(content);
}

/**
 * 鲁棒的 JSON 解析器，支持提取 Markdown 中的 JSON 块
 */
function extractBalancedJsonBlock(text: string, openChar: "{" | "["): string | null {
  const closeChar = openChar === "{" ? "}" : "]";
  const start = text.indexOf(openChar);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function parseJsonFromResponse(content: string, defaultValue: any): any {
  const text = content.trim();
  const hasBrackets = /[\{\}\[\]]/.test(text);
  const likelyJson = hasBrackets && (/^\s*[\{\[]/.test(text) || /```json/.test(text));

  if (!likelyJson && text.length > 0 && text.length < 500) {
    return defaultValue;
  }

  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const result = JSON.parse(cleaned);
    if (typeof result === 'object' && result !== null) return result;
  } catch (e) {}

  const objectBlock = extractBalancedJsonBlock(cleaned, "{");
  if (objectBlock) {
    try { return JSON.parse(objectBlock); } catch {}
  }

  const arrayBlock = extractBalancedJsonBlock(cleaned, "[");
  if (arrayBlock) {
    try { return JSON.parse(arrayBlock); } catch {}
  }

  return defaultValue;
}

/**
 * 从 LLM 响应中提取代码块
 * @param raw LLM 原始响应
 */
export function extractCodeFromResponse(raw: string): { code: string; isValid: boolean; error?: string } {
  let code = "";

  // 1. 严格匹配标准 markdown 代码块 (优先级最高)
  // 查找所有 ```lang ... ``` 结构
  const codeBlocks = Array.from(raw.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/g));

  if (codeBlocks.length > 0) {
    // 策略：如果有多个代码块，取最长的那个（通常是主程序文件）
    const longest = codeBlocks.reduce((l, c) =>
      (c[1] ? c[1].length : 0) > (l[1] ? l[1].length : 0) ? c : l
    );
    code = (longest[1] || "").trim();
  } else {
    // 2. 如果没有代码块，尝试寻找大括号或中括号结构（可能是纯 JSON 或 数组）
    const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      code = jsonMatch[0].trim();
    } else {
      // 3. 禁止危险回退：如果找不到代码块或 JSON 结构，不再提取全文
      // 而是返回错误，让 Coder 重新输出符合规范的内容
      return { code: "", isValid: false, error: "未检测到合法的 Markdown 代码块 (```)。请确保将代码包裹在代码块中，且不要输出任何额外的汇报文字。" };
    }
  }

  // 4. 后置过滤：去掉可能残留在首尾的说明性文字
  // 移除之前那个导致失败的 ✅ 过滤，改为启发式清理，保留核心代码部分
  if (code.includes('```')) {
    code = code.replace(/```(?:\w+)?/g, '').replace(/```/g, '').trim();
  }

  let isValid = true;
  let error = "";

  if (code.length < 5) {
    isValid = false;
    error = `提取的代码太短 (${code.length} 字符)`;
  }

  return { code, isValid, error: isValid ? undefined : error };
}
