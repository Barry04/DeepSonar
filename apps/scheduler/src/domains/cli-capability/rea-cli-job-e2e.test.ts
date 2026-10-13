/**
 * #718 PR3: governed Job path for deepsonar-reverse without docker.
 * Skill discovery/pull (selector + content hash) → admit binary.rea.cli → Evidence
 * normalization → emit_fact proposal (Fact/Artifact) → Verify stays independent.
 * Live sandbox / OCI image is replaced by fixtures; contracts are the real ones.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLI_UNAVAILABLE_CODE,
  CliCapabilityResult,
  EmitFactDirectPayload,
  EmitFactPayload,
  EmitFindingPayload,
} from "@deepsonar/shared-types";
import { contentHashOf, listAvailableSkillsFromCatalog, pullSkillFromCatalog, scanSkillSourceRepo } from "../../skill-sources.js";
import { factProposalToArtifact } from "../artifacts/model.js";
import { buildCapabilityCatalog, describeCapability, searchCapabilities } from "../capability-pack/discovery.js";
import { evaluateFactFirstConfirmGate, isStructuredVerificationFact } from "../../verify-fact-gate.js";
import { isRuntimeProof } from "../../verify-evidence-chain.js";
import { admitCliCapabilities, admitCliCapability } from "./admit.js";
import { availableCliCapabilityIdsForImage, findCliCapability } from "./catalog.js";
import {
  REA_CLI_ARTIFACT_EXTENSION,
  REA_CLI_CAPABILITY_ID,
  buildReaCliCapabilityResult,
  buildReaCliFactProposal,
  planReaCliCleanup,
  type ReaCliObservationInput,
} from "./rea-cli-evidence.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const reverseRuntime = JSON.parse(readFileSync(path.join(repoRoot, "agent-harness/reverse-runtime.json"), "utf8")) as {
  project_opt_in: boolean;
  skill: { id: string; path: string; content_hash: string };
  managed: { npm: { "rea-agents": { version: string } } };
  toolsets: { reverse: { imageKey: string; job_resource_recommendation: { timeout_sec: number } } };
};
const sourceId = "f150e774-d237-57e4-847c-4800722f88ee";
const sampleSha = "a".repeat(64);
const imageDigest = `sha256:${"b".repeat(64)}`;

function skillSource() {
  // Fixture source: scan the in-repo skills/ tree exactly like a trusted source sync would.
  return { id: sourceId, last_commit_sha: "fixture-commit", catalog: scanSkillSourceRepo(path.join(repoRoot, "skills")) };
}

function observation(overrides: Partial<ReaCliObservationInput> = {}): ReaCliObservationInput {
  return {
    job_id: "job_e2e_718",
    workspace: "/workspace",
    argv: ["rea", "function", "/workspace/sample_elf", "main", "--provider", "ghidra", "--json"],
    exit_code: 0,
    stdout: JSON.stringify({ evidence_id: "ev_e2e", operation: "analyze_function", normalized_result: { pseudocode: "int main(){return 0;}" } }),
    stderr: "",
    max_output_bytes: findCliCapability(REA_CLI_CAPABILITY_ID)!.limits.max_output_bytes,
    evidence_ref: "/workspace/evidence/rea-function-main.json",
    ...overrides,
  };
}

const factContext = { operation: "function", sample_path: "/workspace/sample_elf", sample_sha256: sampleSha, image_digest: imageDigest };

test("skill discovery: deepsonar-rea-cli is listed with a pullable selector and pinned file hash", () => {
  const source = skillSource();
  const listed = listAvailableSkillsFromCatalog([source], { query: "rea" });
  const entry = listed.skills.find((skill) => skill.name === reverseRuntime.skill.id);
  assert.ok(entry, "deepsonar-rea-cli must be discoverable via list/search");
  assert.equal(entry.selector, `${sourceId}:deepsonar-rea-cli`);
  const module = source.catalog.find((item) => item.id === "deepsonar-rea-cli")!;
  assert.equal(entry.content_hash, contentHashOf([module]));

  const pulled = pullSkillFromCatalog([source], entry.selector, entry.content_hash);
  assert.equal(pulled.ok, true);
  if (!pulled.ok) return;
  const body = pulled.skill.files["SKILL.md"];
  assert.ok(body, "pulled skill must include SKILL.md");
  // reverse-runtime.json pins the SKILL.md bytes; the pulled body must be that exact file.
  assert.equal(`sha256:${createHash("sha256").update(body).digest("hex")}`, reverseRuntime.skill.content_hash);
  assert.match(body, /binary\.rea\.cli/);
  assert.match(body, /deepsonar-reverse/);
  assert.equal(pulled.skill.commit_sha, "fixture-commit");
});

test("skill pull fails closed on stale hash, broad selector, or unknown module", () => {
  const source = skillSource();
  const selector = `${sourceId}:deepsonar-rea-cli`;
  const stale = pullSkillFromCatalog([source], selector, "0".repeat(64));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error_code, "SKILL_HASH_MISMATCH");
  const broad = pullSkillFromCatalog([source], `${sourceId}:source:*`, "0".repeat(64));
  assert.equal(broad.ok, false);
  const missing = pullSkillFromCatalog([source], `${sourceId}:deepsonar-rea-mcp`, "0".repeat(64));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error_code, "SKILL_NOT_FOUND");
});

test("capability discovery: binary.rea.cli is searchable and describable next to the skill", () => {
  const records = buildCapabilityCatalog({
    sources: [{ ...skillSource(), trust_status: "trusted", enabled: true }],
  });
  const found = searchCapabilities(records, { query: "binary.rea.cli" });
  assert.ok(found.capabilities.some((item) => item.id === REA_CLI_CAPABILITY_ID));
  const described = describeCapability(records, { id: REA_CLI_CAPABILITY_ID });
  assert.equal(described.repair.length, 0);
  assert.deepEqual(described.cli_capability?.compatible_images, ["deepsonar-reverse"]);
  assert.ok(described.cli_capability?.manual_paths.includes(reverseRuntime.skill.path));
});

test("admission: binary.rea.cli freezes only on deepsonar-reverse and matches the runtime manifest", () => {
  assert.equal(reverseRuntime.project_opt_in, true);
  assert.equal(reverseRuntime.toolsets.reverse.imageKey, "deepsonar-reverse");
  assert.ok(availableCliCapabilityIdsForImage("deepsonar-reverse").includes(REA_CLI_CAPABILITY_ID));
  for (const imageKey of ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal", "deepsonar-mobile"]) {
    assert.equal(availableCliCapabilityIdsForImage(imageKey).includes(REA_CLI_CAPABILITY_ID), false, imageKey);
  }

  const manifest = findCliCapability(REA_CLI_CAPABILITY_ID)!;
  assert.equal(manifest.tool_version, reverseRuntime.managed.npm["rea-agents"].version);
  assert.equal(manifest.limits.timeout_ms, reverseRuntime.toolsets.reverse.job_resource_recommendation.timeout_sec * 1000);
  assert.equal(manifest.network, "disabled");

  const admitted = admitCliCapabilities({ ids: [REA_CLI_CAPABILITY_ID], imageKey: "deepsonar-reverse" });
  assert.equal(admitted.ok, true);
  if (admitted.ok) {
    assert.equal(admitted.pack.image_key, "deepsonar-reverse");
    assert.equal(admitted.frozen[0]?.id, REA_CLI_CAPABILITY_ID);
    assert.match(admitted.pack.pack_fingerprint, /^sha256:[a-f0-9]{64}$/);
  }

  const onMobile = admitCliCapabilities({ ids: [REA_CLI_CAPABILITY_ID], imageKey: "deepsonar-mobile" });
  assert.equal(onMobile.ok, false);
  if (!onMobile.ok) {
    assert.equal(onMobile.code, CLI_UNAVAILABLE_CODE);
    assert.equal(onMobile.reason, "incompatible_image");
    assert.equal(onMobile.failed_id, REA_CLI_CAPABILITY_ID);
  }

  const install = admitCliCapability({ capabilityId: REA_CLI_CAPABILITY_ID, imageKey: "deepsonar-reverse", installRequested: true });
  assert.equal(install.ok, false);
  if (!install.ok) assert.equal(install.reason, "install_forbidden");
});

test("evidence → fact: conclusive run becomes an unverified observation, never a verified claim", () => {
  const result = buildReaCliCapabilityResult(observation());
  assert.equal(result.inconclusive, false);
  const proposal = buildReaCliFactProposal(result, factContext);
  assert.equal(EmitFactDirectPayload.safeParse(proposal).success, true);
  assert.equal(EmitFactPayload.safeParse(proposal).success, true);
  assert.equal(proposal.verification, undefined, "REA facts must not attach Finding verification");

  const artifact = factProposalToArtifact(proposal);
  assert.equal(artifact.kind, "observation");
  assert.ok(artifact.claims.length > 0);
  assert.ok(artifact.claims.every((claim) => claim.status === "unknown"));
  assert.ok(artifact.claims.every((claim) => claim.subject?.type !== "finding"));
  assert.ok(artifact.evidence.every((item) => item.polarity === "unknown"));
  assert.equal(artifact.evidence[0]?.uri, result.evidence_ref);
  const ext = artifact.extensions[REA_CLI_ARTIFACT_EXTENSION] as Record<string, unknown>;
  assert.equal(ext.capability_id, REA_CLI_CAPABILITY_ID);
  assert.equal(ext.image_digest, imageDigest);
  assert.equal(ext.sample_sha256, sampleSha);
  assert.equal(ext.inconclusive, false);
  assert.doesNotMatch(JSON.stringify(proposal), /int main\(\)\{return 0;\}/, "raw stdout stays in retained evidence, not in the Fact");
});

test("evidence → fact: non-zero / truncated / partial JSON / timeout / cancel stay inconclusive end to end", () => {
  const cases: Array<[string, Partial<ReaCliObservationInput>, string]> = [
    ["non-zero", { exit_code: 1, stdout: JSON.stringify({ code: "UNKNOWN" }) }, "inconclusive"],
    ["truncated", { stdout: `{"pad":"${"x".repeat(2048)}"}`, max_output_bytes: 1024, stdout_truncated: true }, "truncated"],
    ["partial-json", { stdout: '{"evidence_id":"ev_partial","normalized_result":{' }, "inconclusive"],
    ["timeout", { exit_code: null, stdout: "", stderr: "deadline exceeded", timed_out: true }, "timeout"],
    ["cancel", { exit_code: 1, stdout: JSON.stringify({ code: "cancelled" }), cancelled: true }, "inconclusive"],
  ];
  for (const [label, overrides, reason] of cases) {
    const result = buildReaCliCapabilityResult(observation(overrides));
    assert.equal(result.inconclusive, true, label);
    assert.equal(result.unavailable_reason, reason, label);
    assert.equal(result.is_finding, false, label);
    const proposal = buildReaCliFactProposal(result, factContext);
    assert.match(proposal.description, /不得视为成功/, label);
    const artifact = factProposalToArtifact(proposal);
    assert.ok(artifact.claims.every((claim) => claim.status === "unknown"), label);
    assert.equal((artifact.extensions[REA_CLI_ARTIFACT_EXTENSION] as Record<string, unknown>).inconclusive, true, label);
    const plan = planReaCliCleanup({ workspace: result.workspace, evidencePaths: [result.evidence_ref], ephemeralPaths: ["/tmp/ghidra_proj_e2e"] });
    assert.deepEqual(plan.retain, [result.evidence_ref], `${label}: evidence retained before cleanup`);
    assert.deepEqual(plan.delete_ephemeral, ["/tmp/ghidra_proj_e2e"], label);
  }
});

test("raw CLI output cannot pose as a control event or a Finding", () => {
  const result = buildReaCliCapabilityResult(observation());
  assert.equal(EmitFactPayload.safeParse(result).success, false, "CliCapabilityResult is not an emit_fact payload");
  assert.equal(EmitFindingPayload.safeParse(result).success, false, "CliCapabilityResult is not an emit_finding payload");
  assert.equal(CliCapabilityResult.safeParse({ ...result, is_finding: true }).success, false);
  const proposal = buildReaCliFactProposal(result, factContext);
  assert.equal(EmitFactDirectPayload.safeParse({ ...proposal, verification_status: "verified" }).success, false);
  assert.throws(() => buildReaCliFactProposal({ ...result, capability_id: "fs.ripgrep" }, factContext), /binary\.rea\.cli/);
});

test("Verify independence: an REA observation Fact is neither structured verification nor runtime proof", () => {
  const result = buildReaCliCapabilityResult(observation());
  const proposal = buildReaCliFactProposal(result, factContext);
  const findingId = "99999999-9999-4999-8999-999999999999";
  // Shape the on-graph Fact as Verify would read it: no verification block → no outcome/expected/actual/revision.
  const fact = {
    node_id: "fact-rea-1",
    finding_id: null,
    job_id: result.job_id,
    job_type: "audit",
    job_status: "succeeded",
    outcome: proposal.verification?.outcome ?? null,
    subject_revision: proposal.verification?.subject_revision ?? null,
    expected: proposal.verification?.expected ?? null,
    actual: proposal.verification?.actual ?? null,
  };
  assert.equal(isStructuredVerificationFact(fact), false);
  const gate = evaluateFactFirstConfirmGate([fact], { findingId, subjectRevision: "rev-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.result, "insufficient");
  assert.deepEqual(gate.missing, ["structured_supporting_fact"]);
  // exit_code 0 + argv alone is not runtime proof (needs revision + steps + env/digest).
  assert.equal(isRuntimeProof({ exit_code: result.exit_code, artifact_refs: [{ uri: result.evidence_ref }] }), false);
});
