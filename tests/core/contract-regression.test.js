const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const { verifierNode } = require("../../src/core/nodes/verifier_node");
const {
  createTempWorkspace,
  removeTempWorkspace,
  createBaseState,
  createNoopEmit,
  createNoopStartSpan,
  createSnapshotRecorder,
} = require("./test-helpers");

test("route file that declares endpoints outside api contract is rejected", async () => {
  const workspace = await createTempWorkspace();
  const recorder = createSnapshotRecorder();
  const routeFile = "src/routes/userRoutes.ts";

  try {
    await fs.mkdir(`${workspace}/src/routes`, { recursive: true });
    await fs.writeFile(
      `${workspace}/package.json`,
      JSON.stringify({ name: "fixture", dependencies: { express: "^5.0.0" } }, null, 2),
      "utf-8"
    );
    await fs.writeFile(
      `${workspace}/src/routes/userRoutes.ts`,
      "import { Router } from 'express'; const router = Router(); router.post('/register', handler); export default router;",
      "utf-8"
    );

    const result = await verifierNode(
      createBaseState({
        spec: {
          language: "TypeScript",
          filesToCreate: [routeFile],
        },
        apiContract: {
          endpoints: [{ path: "/api/users/permissions", method: "POST", description: "update permissions" }],
        },
      }),
      {},
      workspace,
      createNoopEmit,
      createNoopStartSpan,
      recorder.save
    );

    assert.match(result.testResults || "", /contract|契约|未声明端点|路由/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
