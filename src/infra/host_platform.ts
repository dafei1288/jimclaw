/**
 * HostPlatform — 基础设施服务层
 *
 * 封装所有平台相关的操作，让节点代码不关心 "Windows 还是 Linux"。
 *
 * 设计原则：
 * 1. Node.js 原生优先 — 能用 fs/http/child_process 解决的不拼命令
 * 2. 平台判断一次 — 构造时探测，之后只读属性
 * 3. 容器内命令不经过这里 — docker exec 内部始终是 Linux
 */

import * as fs from "fs/promises";
import * as http from "http";
import * as net from "net";
import { spawn, SpawnOptions } from "child_process";

// ── 类型 ──

export type HostOS = "windows" | "linux" | "macos";
export type HostShell = "cmd" | "powershell" | "bash" | "sh";

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface HttpResult {
  statusCode: number | null;
  body: string;
  error?: string;
}

// ── 实现 ──

class HostPlatformImpl {
  readonly os: HostOS;
  readonly shell: HostShell;

  constructor() {
    switch (process.platform) {
      case "win32":
        this.os = "windows";
        this.shell = "cmd";
        break;
      case "darwin":
        this.os = "macos";
        this.shell = "bash";
        break;
      default:
        this.os = "linux";
        this.shell = "bash";
        break;
    }
  }

  // ════════════════════════════════════════════════
  // Shell
  // ════════════════════════════════════════════════

  /**
   * 执行 shell 命令，自动选择正确的 shell。
   * Windows: cmd.exe /d /s /c <command>
   * Linux/macOS: /bin/sh -c <command>
   */
  exec(command: string, opts?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<ShellResult> {
    return new Promise((resolve) => {
      const isWin = this.os === "windows";
      const spawnOpts: SpawnOptions = {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
      };

      let child: ReturnType<typeof spawn>;
      try {
        if (isWin) {
          child = spawn("cmd.exe", ["/d", "/s", "/c", command], spawnOpts);
        } else {
          child = spawn("/bin/sh", ["-c", command], spawnOpts);
        }
      } catch (err: any) {
        resolve({
          ok: false,
          stdout: "",
          stderr: err.message || String(err),
          exitCode: null,
          timedOut: false,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (opts?.timeout) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          resolve({
            ok: false,
            stdout,
            stderr,
            exitCode: null,
            timedOut: true,
          });
        }, opts.timeout);
      }

      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          exitCode: code,
          timedOut: false,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          ok: false,
          stdout,
          stderr: stderr + err.message,
          exitCode: null,
          timedOut: false,
        });
      });
    });
  }

  /**
   * 同步执行，返回 stdout。用于简单场景。
   */
  execSync(command: string, opts?: { cwd?: string; timeout?: number }): string {
    const { execSync: nodeExecSync } = require("child_process");
    const isWin = this.os === "windows";
    const execCmd = isWin ? `cmd.exe /d /s /c "${command.replace(/"/g, '\\"')}"` : command;
    return String(nodeExecSync(execCmd, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }) || "").trim();
  }

  // ════════════════════════════════════════════════
  // HTTP (Node.js 原生)
  // ════════════════════════════════════════════════

  /**
   * HTTP GET — 不依赖 curl，纯 Node.js http 模块
   */
  httpGet(url: string, timeoutMs = 3000): Promise<HttpResult> {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || null, body });
        });
      });
      req.on("error", (err) => {
        resolve({ statusCode: null, body: "", error: err.message });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve({ statusCode: null, body: "", error: "timeout" });
      });
    });
  }

  /**
   * 只拿 HTTP 状态码，不消费 body
   */
  httpStatusCode(url: string, timeoutMs = 3000): Promise<number | null> {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume(); // 丢弃 body
        resolve(res.statusCode || null);
      });
      req.on("error", () => resolve(null));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    });
  }

  // ════════════════════════════════════════════════
  // 进程管理
  // ════════════════════════════════════════════════

  /**
   * 后台启动进程，返回 PID
   *
   * Windows: PowerShell Start-Process
   * Linux/macOS: spawn detached
   */
  async startBackground(opts: {
    command: string;
    cwd: string;
    stdoutLog: string;
    stderrLog: string;
    env?: Record<string, string>;
  }): Promise<number> {
    await this.ensureDir(require("path").dirname(opts.stdoutLog));

    if (this.os === "windows") {
      return this._startBackgroundWindows(opts);
    } else {
      return this._startBackgroundUnix(opts);
    }
  }

  private async _startBackgroundWindows(opts: {
    command: string; cwd: string; stdoutLog: string; stderrLog: string; env?: Record<string, string>;
  }): Promise<number> {
    const escapedCmd = opts.command.replace(/'/g, "''");
    const escapedWorkspace = opts.cwd.replace(/'/g, "''");
    const envVars = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `$env:${k}='${v}'`).join("; ")
      : "";

    const ps = [
      "powershell",
      "-NoProfile",
      "-Command",
      [
        `"`,
        `$pidPath='${opts.stdoutLog.replace(/\.log$/, ".pid").replace(/\\/g, "\\\\")}'`,
        `$stdoutLogPath='${opts.stdoutLog.replace(/\\/g, "\\\\")}'`,
        `$stderrLogPath='${opts.stderrLog.replace(/\\/g, "\\\\")}'`,
        `New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($pidPath)) | Out-Null`,
        envVars ? `${envVars}; ` : "",
        `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','${escapedCmd}' -WorkingDirectory '${escapedWorkspace}' -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath -PassThru`,
        `Set-Content -Path $pidPath -Value $p.Id`,
        `Write-Output $p.Id`,
        `"`,
      ].join(" "),
    ].join(" ");

    const result = await this.exec(ps, { timeout: 10000 });
    const pid = parseInt(result.stdout.trim(), 10);
    if (isNaN(pid) || pid <= 0) {
      throw new Error(`后台启动失败: stdout=${result.stdout} stderr=${result.stderr}`);
    }
    return pid;
  }

  private async _startBackgroundUnix(opts: {
    command: string; cwd: string; stdoutLog: string; stderrLog: string; env?: Record<string, string>;
  }): Promise<number> {
    const pidFile = opts.stdoutLog.replace(/\.log$/, ".pid");
    const envPrefix = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}='${v}'`).join(" ")
      : "";

    const cmd = [
      `mkdir -p ${require("path").dirname(pidFile)}`,
      `rm -f ${pidFile}`,
      `${envPrefix} nohup sh -c ${JSON.stringify(opts.command)} >${opts.stdoutLog} 2>${opts.stderrLog} & echo $! >${pidFile}`,
      `sleep 0.1 && cat ${pidFile}`,
    ].join(" && ");

    const result = await this.exec(cmd, { cwd: opts.cwd, timeout: 10000 });
    const pid = parseInt(result.stdout.trim().split("\n").pop() || "", 10);
    if (isNaN(pid) || pid <= 0) {
      throw new Error(`后台启动失败: stdout=${result.stdout} stderr=${result.stderr}`);
    }
    return pid;
  }

  /**
   * 用 PID 杀进程
   */
  async killProcess(pid: number): Promise<boolean> {
    try {
      process.kill(pid);
      return true;
    } catch {
      // 进程可能已退出
      try {
        if (this.os === "windows") {
          await this.exec(`taskkill /PID ${pid} /F`, { timeout: 5000 });
        } else {
          await this.exec(`kill -9 ${pid}`, { timeout: 5000 });
        }
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 检查 PID 是否存活
   */
  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0); // 信号 0 = 只检查，不杀
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 杀掉占用某端口的进程
   */
  async killPortProcess(port: number): Promise<boolean> {
    if (this.os === "windows") {
      const result = await this.exec(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`,
        { timeout: 10000 },
      );
      return result.ok;
    } else {
      const result = await this.exec(
        `fuser -k ${port}/tcp 2>/dev/null || lsof -ti:${port} | xargs kill -9 2>/dev/null || true`,
        { timeout: 10000 },
      );
      return true; // fuser -k 返回非零也正常（端口未被占用）
    }
  }

  // ════════════════════════════════════════════════
  // 文件系统 (Node.js fs 封装)
  // ════════════════════════════════════════════════

  /**
   * 递归创建目录 (mkdir -p 的跨平台版本)
   */
  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  /**
   * 读文件
   */
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  /**
   * 写文件（自动创建父目录）
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    await this.ensureDir(require("path").dirname(filePath));
    await fs.writeFile(filePath, content, "utf-8");
  }

  /**
   * 检查文件是否存在
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ════════════════════════════════════════════════
  // 网络
  // ════════════════════════════════════════════════

  /**
   * 检查端口是否被占用 — 纯 Node.js net 模块
   */
  isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          resolve(true);
        } else {
          resolve(false);
        }
      });
      server.once("listening", () => {
        server.close();
        resolve(false);
      });
      server.listen(port, "127.0.0.1");
    });
  }
}

// ── 单例导出 ──
export const host = new HostPlatformImpl();
