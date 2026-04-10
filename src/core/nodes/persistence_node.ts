import { JimClawState } from "../graph_types";
import { ShellExecuteSkill } from "../../skills/shell_exec";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

/**
 * Persistence 节点：负责资源清理和最终状态持久化
 */
export async function persistenceNode(
  state: JimClawState,
  agents: any,
  WORKSPACE: string,
  emit: any,
  startSpan: any,
  saveBoulder: any
) {
  if (state.executionBackend === "host") {
    const pidPath = path.join(WORKSPACE, ".jimclaw", "server.pid");
    if (state.deploymentStatus?.status === "running") {
      console.log(`[Persistence] 服务已部署，保留宿主机进程`);
    } else {
      const pidText = await fs.readFile(pidPath, "utf-8").catch(() => "");
      const pid = Number(String(pidText).trim());
      if (pid > 0) {
        try {
          process.kill(pid);
        } catch {}
      }
    }
  }
  if (state.containerId) {
    // 如果部署成功且服务正在运行，则不要删除容器
    if (state.deploymentStatus?.status === 'running') {
      console.log(`[Persistence] 服务已部署，保留容器: ${state.containerId}`);
    } else {
      await ShellExecuteSkill.config.run({ command: `docker rm -f ${state.containerId} 2>/dev/null || true` });
    }
  }
  // 只有当上游（QA/deploy）已确认成功、或服务确实在运行时才标记 isDone=true
  // 否则保留上游的 isDone 值（可能是 false），避免伪成功
  const wasDeployed = state.deploymentStatus?.status === "running";
  const isDone = wasDeployed ? true : (state.isDone ?? false);
  if (!isDone) {
    console.log(`[Persistence] 任务未成功完成（deploy=${state.deploymentStatus?.status || "无"}），标记 isDone=false`);
  }
  const result = { isDone };
  await saveBoulder({ ...state, ...result }, "persistence");

  // ── FP 回归检测：每次运行结束自动检查所有已知 failure patterns ──
  try {
    const execFileAsync = promisify(execFile);
    const scriptPath = path.resolve(process.cwd(), "scripts", "fp_regression_check.ts");
    const tsNode = path.resolve(process.cwd(), "node_modules", ".bin", "ts-node");
    const { stdout, stderr } = await execFileAsync(tsNode, [scriptPath, WORKSPACE], {
      timeout: 30000,
      cwd: process.cwd(),
    }).catch(() => ({ stdout: "", stderr: "" }));
    if (stdout) {
      // 输出关键结果
      const lines = stdout.split("\n").filter(l => /❌|✅.*FP-|总计|通过|失败/.test(l));
      for (const line of lines) {
        console.log(`[FP-Check] ${line.trim()}`);
      }
    }
  } catch (e: any) {
    // fp_regression_check 失败不应阻塞 persistence
    console.log(`[FP-Check] 回归检测异常（不阻塞）: ${e.message}`);
  }

  return result;
}
