import * as fs from "fs/promises";
import * as path from "path";

/**
 * 审计日志工具：将系统的所有行为持久化到文件
 */
export class AuditLogger {
  static async log(workspaceDir: string | undefined, senderName: string, content: string) {
    if (!workspaceDir) return;
    try {
      const auditDir = path.join(workspaceDir, "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const logFile = path.join(auditDir, `${senderName}.md`);
      const timestamp = new Date().toLocaleString('zh-CN');
      await fs.appendFile(logFile, `\n\n--- [${timestamp}] ---\n${content}\n`);
    } catch (e) {
      console.error(`[AuditLogger] 写入失败: ${e}`);
    }
  }
}
