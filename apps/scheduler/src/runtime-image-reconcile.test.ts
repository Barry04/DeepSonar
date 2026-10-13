import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRuntimeImagesOnNodes } from "./runtime-image-reconcile.js";
import { resetRuntimeImagePullTask } from "./runtime-images.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REF = `ghcr.io/example/base@${DIGEST}`;

test("reconcile reports local missing digests and marks remote inspect unsupported", async () => {
  resetRuntimeImagePullTask();
  const result = await reconcileRuntimeImagesOnNodes({
    repair: false,
    loadNeeds: () => [{
      image_key: "deepsonar-base",
      image_ref: IMAGE_REF,
      digest: DIGEST,
      version_id: "ver-1",
      reasons: ["job_frozen"],
    }],
    inspect: async () => ({ exists: false }),
    listRemoteNodeIds: () => ["worker-a"],
  });
  const local = result.nodes.find((node) => node.node_kind === "local");
  assert.ok(local);
  assert.equal(local?.missing.length, 1);
  assert.equal(local?.items[0]?.local_present, false);
  assert.equal(local?.items[0]?.reasons.includes("job_frozen"), true);
  assert.equal(result.nodes.find((node) => node.node_id === "worker-a")?.inspect, "unsupported");
  assert.equal(result.repair_task, null);
  resetRuntimeImagePullTask();
});

test("reconcile repair starts targeted pull for missing digests only", async () => {
  resetRuntimeImagePullTask();
  const result = await reconcileRuntimeImagesOnNodes({
    repair: true,
    loadNeeds: () => [{
      image_key: "deepsonar-base",
      image_ref: IMAGE_REF,
      digest: DIGEST,
      version_id: "ver-1",
      reasons: ["latest", "job_frozen"],
    }],
    inspect: async () => ({ exists: false }),
  });
  assert.ok(result.repair_task);
  assert.equal(result.repair_task?.purpose, "admin_targeted");
  assert.equal(result.repair_task?.total, 1);
  assert.equal(result.repair_task?.items[0]?.image_ref, IMAGE_REF);
  assert.equal(result.repair_task?.items[0]?.target_digest, DIGEST);
  resetRuntimeImagePullTask();
});

test("reconcile does not pull when local already matches digest", async () => {
  resetRuntimeImagePullTask();
  const result = await reconcileRuntimeImagesOnNodes({
    repair: true,
    loadNeeds: () => [{
      image_key: "deepsonar-base",
      image_ref: IMAGE_REF,
      digest: DIGEST,
      version_id: "ver-1",
      reasons: ["latest"],
    }],
    inspect: async (ref) => {
      if (ref === IMAGE_REF || ref === DIGEST) {
        return { exists: true, repo_digests: [IMAGE_REF], image_id: DIGEST };
      }
      return { exists: false };
    },
  });
  assert.equal(result.repair_task, null);
  assert.equal(result.nodes[0]?.missing.length, 0);
  assert.equal(result.nodes[0]?.items[0]?.local_present, true);
  resetRuntimeImagePullTask();
});
