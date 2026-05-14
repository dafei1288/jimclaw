import * as path from "path";

function quoteShellArg(value: string): string {
  const raw = String(value || "");
  if (process.platform === "win32") {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function buildDockerBindMountArg(workspace: string, target = "/app"): string {
  const source = path.resolve(workspace);
  return `--mount ${quoteShellArg(`type=bind,source=${source},target=${target}`)}`;
}

function buildDockerCacheVolumeArgs(language: string): string[] {
  const lang = String(language || "").toLowerCase();
  return [
    lang.includes("python") ? "-v jimclaw_pip_cache:/root/.cache/pip" : "",
    lang.includes("go") ? "-v jimclaw_go_cache:/go/pkg/mod" : "",
    lang.includes("java") ? "-v jimclaw_maven_cache:/root/.m2" : "",
    lang.includes("rust") ? "-v jimclaw_cargo_cache:/usr/local/cargo/registry" : "",
  ].filter(Boolean);
}

export function buildDockerRunCommand(args: {
  containerName: string;
  hostPort: number | string;
  containerPort: number | string;
  workspace: string;
  language: string;
  image: string;
}): string {
  return [
    "docker run -d",
    `--name ${args.containerName}`,
    `-p ${args.hostPort}:${args.containerPort}`,
    buildDockerBindMountArg(args.workspace),
    ...buildDockerCacheVolumeArgs(args.language),
    "-w /app",
    args.image,
    "tail -f /dev/null",
  ].join(" ");
}
