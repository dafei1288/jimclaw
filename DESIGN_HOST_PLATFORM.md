# 基础设施服务层设计

## 问题

当前所有节点直接拼 shell 命令，零平台抽象。`spawn({ shell: true })` 在 Windows 上用 `cmd.exe`，
在 Linux/macOS 上用 `sh`。导致：

| 调用 | Windows (cmd.exe) | Linux (sh) | 结果 |
|------|---------|------|------|
| `curl -o /dev/null` | ❌ exit 23 (MSYS 路径转换) | ✅ | deploy 必败 |
| `nohup ... &` | ❌ cmd.exe 不认识 | ✅ | host 启动必败 |
| `kill $(cat pid)` | ❌ `$()` 语法错误 | ✅ | 进程管理必败 |
| `mkdir -p` | ⚠️ 偶尔可用 (mkdir /p) | ✅ | 不稳定 |
| `fuser -k` | ❌ 命令不存在 | ✅ | 端口释放必败 |
| `2>/dev/null` | ❌ stderr 重定向语法不同 | ✅ | 噪音日志 |
| `powershell -Command ...` | ✅ | ❌ 命令不存在 | 只能 Windows |

**核心矛盾**：deploy_node 有 `process.platform === "win32"` 分支，但只覆盖了"启动后台进程"一个操作。
其余 40+ 处 shell 调用全部假设 Linux 环境。

## 设计原则

1. **平台判断一次，到处使用** — 不在每个调用点写 `if (win32)`
2. **Node.js 原生优先** — 能用 `fs`/`http`/`child_process` 解决的不拼命令
3. **容器内命令不受影响** — `docker exec` 内部始终是 Linux，走原有路径
4. **渐进式迁移** — 先抽服务层，逐个节点替换，不搞大爆炸重写

## 架构

```
┌─────────────────────────────────────────────────────┐
│  节点 (deploy / infra / terminal / env_guard / ...)  │
│  调用 host 来做平台相关操作                            │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│  HostPlatform (src/infra/host_platform.ts)           │
│                                                      │
│  单例，启动时探测一次 OS 环境。所有平台相关逻辑收拢于此。 │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Shell       │  │ Process      │  │ Http        │ │
│  │ .exec()     │  │ .startBg()   │  │ .get()      │ │
│  │ .execSync() │  │ .kill()      │  │ .getStatusCode() │
│  └─────────────┘  │ .isRunning() │  └─────────────┘ │
│                    └──────────────┘                   │
│  ┌─────────────┐  ┌──────────────┐                   │
│  │ FileSystem  │  │ Network      │                   │
│  │ .ensureDir()│  │ .freePort()  │                   │
│  │ .read()     │  │ .killPort()  │                   │
│  │ .write()    │  └──────────────┘                   │
│  └─────────────┘                                     │
└──────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│  Node.js 原生 (fs / http / child_process / net)      │
│  或 ShellExecuteSkill (仅必要时)                      │
└──────────────────────────────────────────────────────┘
```

## API 设计

### `HostPlatform` — 所有方法的签名和跨平台行为

```typescript
// src/infra/host_platform.ts

interface HostPlatform {
  // ── 探测结果（启动时计算一次）──
  readonly os: "windows" | "linux" | "macos";
  readonly shell: "cmd" | "powershell" | "bash" | "sh";

  // ── Shell ──
  // 执行命令，返回 { stdout, stderr, exitCode }
  // 内部自动选择 shell 类型
  exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<ShellResult>;

  // ── HTTP ──
  // Node.js 原生 http.get，零外部依赖
  httpGet(url: string, timeoutMs?: number): Promise<{ statusCode: number | null; body: string; error?: string }>;
  // 只拿状态码，更轻量
  httpStatusCode(url: string, timeoutMs?: number): Promise<number | null>;

  // ── 进程管理 ──
  // 后台启动进程，返回 PID
  startBackground(opts: { command: string; cwd: string; stdoutLog: string; stderrLog: string; env?: Record<string,string> }): Promise<number>;
  // 用 PID 杀进程（Node.js process.kill，跨平台）
  killProcess(pid: number): Promise<boolean>;
  // 检查 PID 是否存活
  isProcessRunning(pid: number): boolean;
  // 杀掉占用某端口的进程
  killPortProcess(port: number): Promise<boolean>;

  // ── 文件系统（Node.js fs 封装）──
  // mkdir -p 的跨平台版本（用 fs.mkdir recursive）
  ensureDir(dirPath: string): Promise<void>;
  // 读文件
  readFile(filePath: string): Promise<string>;
  // 写文件（自动创建父目录）
  writeFile(filePath: string, content: string): Promise<void>;

  // ── 网络 ──
  // 检查端口是否被占用
  isPortInUse(port: number): Promise<boolean>;
}

interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}
```

### 跨平台行为表

| 方法 | Windows | Linux/macOS |
|------|---------|-------------|
| `exec()` | `spawn(cmd.exe, ["/d", "/s", "/c", command])` | `spawn("/bin/sh", ["-c", command])` |
| `startBackground()` | PowerShell `Start-Process` | `spawn(shell, ["-c", cmd], { detached, stdio })` |
| `killProcess(pid)` | `process.kill(pid)` | `process.kill(pid)` |
| `killPortProcess(port)` | PowerShell `Get-NetTCPConnection` | `exec("fuser -k PORT/tcp")` |
| `httpGet()` | `http.get()` | `http.get()` |
| `ensureDir()` | `fs.mkdir({ recursive })` | `fs.mkdir({ recursive })` |
| `isPortInUse()` | `net.createServer().listen()` | 同左 |

## 调用点迁移清单

### Phase 1: deploy_node.ts (最高优先级，直接影响成功率)

| # | 当前调用 | 迁移到 | 平台问题 |
|---|---------|--------|---------|
| 1 | `ShellExecuteSkill` + `docker rm` | `host.exec()` | `2>/dev/null` 语法 |
| 2 | PowerShell 后台启动 | `host.startBackground()` | 已有分支但冗余 |
| 3 | `nohup sh -c ... &` (Linux 分支) | `host.startBackground()` | ✅ 已处理 |
| 4 | `httpGet()` (刚写的内部函数) | `host.httpGet()` | 移入服务层 |
| 5 | PowerShell `Get-NetTCPConnection` | `host.exec()` | 已有分支 |
| 6 | `docker exec ... sh -c "cat /tmp/..."` | `host.exec()` | 容器内命令不变 |
| 7 | `mkdir -p .jimclaw` | `host.ensureDir()` | cmd.exe 不认 `-p` |
| 8 | `kill $(cat pid)` | `host.readFile()` + `host.killProcess()` | `$()` 语法 |

### Phase 2: infra_node.ts

| # | 当前调用 | 迁移到 | 平台问题 |
|---|---------|--------|---------|
| 1 | `ShellExecuteSkill` + `docker run` | `host.exec()` | 命令本身跨平台 |
| 2 | `ShellExecuteSkill` + `npm install` | `host.exec()` | 命令本身跨平台 |
| 3 | `ShellExecuteSkill` + `pip install` (容器内) | 不变 | 容器内 Linux |
| 4 | `ShellExecuteSkill` + `mvn` (容器内) | 不变 | 容器内 Linux |
| 5 | 宿主机 `npm install` | `host.exec()` | 命令本身跨平台 |
| 6 | `pkill -f` (杀旧进程) | `host.killPortProcess()` | ❌ Windows |
| 7 | `if [ -f pid ]; then kill` | `host.readFile()` + `host.killProcess()` | ❌ sh 语法 |

### Phase 3: env_guard_node.ts

| # | 当前调用 | 迁移到 | 平台问题 |
|---|---------|--------|---------|
| 1 | PowerShell 端口检查 | `host.isPortInUse()` | 已有分支 |
| 2 | `fuser -k` (Linux 分支) | `host.killPortProcess()` | 已有分支 |
| 3 | `ShellExecuteSkill` 释放端口 | `host.killPortProcess()` | 统一入口 |

### Phase 4: persistence_node.ts

| # | 当前调用 | 迁移到 | 平台问题 |
|---|---------|--------|---------|
| 1 | `process.kill(pid)` | `host.killProcess()` | 已跨平台 |
| 2 | `docker rm -f` | `host.exec()` | `2>/dev/null` |
| 3 | `execFile(ts-node)` (FP 回归) | `host.exec()` | 路径问题 |

### Phase 5: logic_utils.ts

| # | 当前调用 | 迁移到 | 平台问题 |
|---|---------|--------|---------|
| 1 | `fuser -k` 释放端口 | `host.killPortProcess()` | ❌ Windows |

### Phase 6: deploy_service.ts

| # | 当前调用 | 迁移到 | 平台问题 |
|---|---------|--------|---------|
| 1 | `ShellExecuteSkill` + docker | `host.exec()` | 命令本身跨平台 |
| 2 | `http.get()` (刚写的内联代码) | `host.httpGet()` | 移入服务层 |

## ShellExecuteSkill 的定位

迁移后 `ShellExecuteSkill` 仍然是 Agent (星河、清扬) 的工具——让 LLM 执行任意命令。
但节点内部的基础设施操作不再直接用它，改走 `HostPlatform`。

```
Agent 工具调用链:  Agent → Skill (ShellExecuteSkill) → spawn(shell)
节点内部调用链:    Node → HostPlatform → spawn(正确的 shell) 或 Node.js 原生 API
容器内调用链:      Node → execInContainer() → docker exec → sh -c (始终 Linux)
```

## 关键：exec() 的 shell 选择

`spawn({ shell: true })` 的问题在于它默认用 `cmd.exe`（Windows）或 `/bin/sh`（Linux），
但没有统一的参数格式。解决方案：

```typescript
function exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<ShellResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(
      isWin ? "cmd.exe" : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-c", command],
      { cwd: opts?.cwd }
    );
    // ... 统一的 stdout/stderr/exitCode/timeout 处理
  });
}
```

这样：
- Windows 上：`cmd.exe /d /s /c "mkdir workspace"` ✅
- Linux 上：`/bin/sh -c "mkdir workspace"` ✅
- 不再依赖 `shell: true` 的隐式行为

## 实施顺序

1. **创建 `src/infra/host_platform.ts`** — 核心抽象 + 全部方法实现
2. **创建 `src/infra/index.ts`** — 导出单例 `host`
3. **Phase 1: deploy_node** — 替换所有直接 shell 调用
4. **E2E 验证** — TS/Express 健康 + CRUD
5. **Phase 2-6: 逐个节点替换**
6. **删除 deploy_node 内部 `httpGet()`** — 已移入 host
7. **删除 `deploy_service.ts` 内联 HTTP 代码** — 同上
