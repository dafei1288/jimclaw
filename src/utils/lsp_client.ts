import * as cp from "child_process";
import * as rpc from "vscode-jsonrpc/node";
import {
  InitializeParams,
  InitializeResult,
  PublishDiagnosticsParams,
  DidOpenTextDocumentParams,
  Diagnostic,
} from "vscode-languageserver-protocol";
import * as fs from "fs";
import * as path from "path";

export class LSPClient {
  private connection: rpc.MessageConnection;
  private process: cp.ChildProcess;
  private diagnosticsMap: Map<string, Diagnostic[]> = new Map();
  private pendingDiagnostics: Map<string, (d: Diagnostic[]) => void> = new Map();
  private openedFiles: Set<string> = new Set();

  constructor(serverCommand: string, serverArgs: string[], rootPath: string) {
    this.process = cp.spawn(serverCommand, serverArgs, {
      cwd: rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.process.stdout!),
      new rpc.StreamMessageWriter(this.process.stdin!)
    );

    this.connection.listen();

    this.connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
      const filePath = path.resolve(params.uri.replace("file://", ""));
      this.diagnosticsMap.set(filePath, params.diagnostics);
      
      const resolver = this.pendingDiagnostics.get(filePath);
      // 如果我们收到了诊断（即使是空的，但在某些场景下我们可能想等非空的）
      // TS Server 往往先发一个空的，再发一个真实的
      if (resolver) {
        if (params.diagnostics.length > 0) {
           resolver(params.diagnostics);
           this.pendingDiagnostics.delete(filePath);
        }
      }
    });
  }

  async initialize(rootPath: string): Promise<InitializeResult> {
    return await this.connection.sendRequest("initialize", {
      processId: process.pid,
      rootPath: rootPath,
      rootUri: `file://${rootPath}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
        },
      },
    });
  }

  async diagnoseFile(filePath: string, content: string, languageId: string): Promise<Diagnostic[]> {
    const fullPath = path.resolve(filePath);
    const uri = `file://${fullPath}`;

    const promise = new Promise<Diagnostic[]>((resolve) => {
      this.pendingDiagnostics.set(fullPath, resolve);
      // 增加超时到 10秒，因为 TS Server 初始化和分析大项目可能较慢
      setTimeout(() => {
        if (this.pendingDiagnostics.has(fullPath)) {
          resolve(this.diagnosticsMap.get(fullPath) || []);
          this.pendingDiagnostics.delete(fullPath);
        }
      }, 10000);
    });

    if (!this.openedFiles.has(fullPath)) {
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      this.openedFiles.add(fullPath);
    } else {
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      });
    }

    return promise;
  }

  async stop() {
    this.process.kill();
  }
}

export class LSPManager {
  private static tsClient: LSPClient | null = null;
  static async getTSClient(): Promise<LSPClient> {
    if (!this.tsClient) {
      const root = process.cwd();
      this.tsClient = new LSPClient("npx", ["typescript-language-server", "--stdio"], root);
      await this.tsClient.initialize(root);
    }
    return this.tsClient;
  }
}
