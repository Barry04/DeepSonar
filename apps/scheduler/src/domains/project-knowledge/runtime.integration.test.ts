import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";
import { freezeProjectKnowledgeCatalog, projectSkillSelector } from "./catalog-snapshot.js";
import { freezeJobSkillCatalog } from "../../job-skill-catalog.js";
import { writeKnowledgeBlob, registerKnowledgeBlob } from "./blobs.js";
import { createKnowledgeRuntime } from "./runtime.js";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { PlatformRuntimeHandlerError } from "../platform-api/registry.js";

test("runtime discovery filters grants, pull creates stable usage, and repeat after revoke fails closed", async () => {
  const bytes = new Map<string, Buffer>();
  setSharedAssetBlobStoreForTests({
    kind: "fs", put: async (key, content) => { bytes.set(key, Buffer.from(content)); },
    exists: async (key) => bytes.has(key), get: async (key) => bytes.get(key)!,
    materializeLocal: async () => { throw new Error("unused"); },
  } satisfies BlobStore);
  try {
    await withKnowledgeDatabase(async (db) => {
      const owner = await seedKnowledgeJob(db), consumer = await seedKnowledgeJob(db);
      const item = randomUUID(), version = randomUUID();
      const body = { kind: "skill", logical_key: "bounded", title: "Authorized Skill", keywords: ["fixture"], files: { "SKILL.md": "Read only assigned inputs" } };
      const blob = await writeKnowledgeBlob(db, body);
      await registerKnowledgeBlob(db, blob.hash, blob.bytes);
      await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title) VALUES(${item},${owner.projectId},'skill','bounded','Authorized Skill')`;
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${version},${owner.projectId},${item},1,${blob.hash},${owner.jobId},${owner.attemptId},'[]',${blob.hash})`;
      await db`UPDATE project_knowledge_items SET active_version_id=${version},status='active' WHERE id=${item}`;
      const [grant] = await db`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
        VALUES(${owner.projectId},${item},${version},${consumer.projectId},'fixture') RETURNING id`;
      const catalog = await freezeProjectKnowledgeCatalog(db, consumer.projectId);
      const frozen = await freezeJobSkillCatalog(db as never, consumer.projectId);
      await db`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["search_skills", "pull_skill"], project_knowledge_catalog: catalog, job_skill_catalog: frozen } as never)} WHERE id=${consumer.jobId}`;
      const runtime = createKnowledgeRuntime({ db, governanceHash: blob.hash });
      const context = { jobId: consumer.jobId, projectId: consumer.projectId, canvasId: consumer.canvasId, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() };
      const list = await runtime({ ...context, operationId: "search_skills", input: { query: "authorized" } });
      assert.equal(list!.total, 1);
      const input = { selector: projectSkillSelector(catalog.entries[0]!), expected_content_hash: blob.hash };
      const first = await runtime({ ...context, operationId: "pull_skill", input });
      const second = await runtime({ ...context, operationId: "pull_skill", input });
      assert.equal(first!.usage_ref, second!.usage_ref);
      assert.equal((await db`SELECT COUNT(*)::int AS n FROM project_knowledge_usages WHERE job_id=${consumer.jobId}`)[0].n, 1);
      await db`UPDATE project_knowledge_grants SET revoked_at=now() WHERE id=${grant.id}`;
      assert.equal((await runtime({ ...context, operationId: "search_skills", input: { query: "authorized" } }))!.total, 0);
      await assert.rejects(runtime({ ...context, operationId: "pull_skill", input }),
        (error) => error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "KNOWLEDGE_REVOKED");
    });
  } finally { setSharedAssetBlobStoreForTests(null); }
});
