import { startExecutorSidecarServer } from "./sidecar_server";

startExecutorSidecarServer()
  .then(({ host, port }) => {
    console.log(`[Executor Sidecar] listening on http://${host}:${port}`);
  })
  .catch((error) => {
    console.error("[Executor Sidecar] failed to start:", error);
    process.exitCode = 1;
  });
