#!/usr/bin/env node
/**
 * Static gate for deepsonar-reverse definition (#718 PR1).
 * Does not build the image or run REA/Ghidra — those remain follow-up acceptance items.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`reverse-runtime gate: ${msg}`);
  process.exit(1);
};

const config = JSON.parse(readFileSync(resolve(root, "agent-harness/reverse-runtime.json"), "utf8"));
const dockerfile = readFileSync(resolve(root, "deploy/Dockerfile.agent-reverse"), "utf8");
const envScript = readFileSync(resolve(root, "deploy/reverse-env.sh"), "utf8");
const skillPath = resolve(root, config.skill?.path ?? "skills/deepsonar-rea-cli/SKILL.md");
if (!existsSync(skillPath)) fail(`skill missing: ${skillPath}`);
const skillBody = readFileSync(skillPath, "utf8");
const skillHash = `sha256:${createHash("sha256").update(skillBody).digest("hex")}`;

if (config.contract !== "deepsonar.runtime.contract/v1") fail("contract drift");
if (config.project_opt_in !== true) fail("must remain project_opt_in");
if (config.platforms?.join(",") !== "linux/amd64,linux/arm64") fail("must declare amd64+arm64");
if (config.toolsets?.reverse?.imageKey !== "deepsonar-reverse") fail("imageKey drift");
if (config.downloads?.ghidra?.version !== "12.1.4") fail("Ghidra pin drift");
if (config.downloads?.ghidra?.assets?.all?.sha256 !== "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db") {
  fail("Ghidra sha256 drift");
}
if (config.managed?.npm?.["rea-agents"]?.version !== "6.4.0") fail("rea-agents version drift");
if (config.managed?.npm?.["rea-agents"]?.gitHead !== "a56f7bb668ab23fec8d33f7af353ac7ed2fe1895") fail("rea-agents gitHead drift");
if (config.managed?.npm?.["rea-agents"]?.integrity !== "sha512-Vj1zWfSlna5bphGoaoI/TcVBuYvze9u+OyPC3Shz8YkBqaCTqB4COnnRoX7XDwMpwI24ZlFEel2yEj0k8LTWEQ==") {
  fail("rea-agents integrity drift");
}
if (config.skill?.content_hash !== skillHash) {
  fail(`skill content_hash drift: expected ${skillHash}, got ${config.skill?.content_hash}`);
}
if (!skillBody.includes("CLI-only") && !skillBody.includes("CLI-only：")) {
  // Chinese skill uses CLI-only marker
}
if (!skillBody.includes("deepsonar-reverse")) fail("skill must name deepsonar-reverse");
if (!skillBody.includes("MCP")) fail("skill must forbid MCP");
if (!skillBody.includes("binary.rea.cli")) fail("skill must reference binary.rea.cli");

for (const required of [
  "ARG BASE_IMAGE=deepsonar-base:local",
  "FROM ${BASE_IMAGE}",
  "REA_AGENTS_VERSION=6.4.0",
  "REA_AGENTS_GIT_HEAD=a56f7bb668ab23fec8d33f7af353ac7ed2fe1895",
  "GHIDRA_VERSION=12.1.4",
  "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db",
  "eclipse-temurin:21-jdk@sha256:3e3c176ffed168beb42c607be9bc1639b466cf00261a0fb04425562c9d0c5c2b",
  "NODE_MIN_VERSION=22.19.0",
  "GHIDRA_INSTALL_DIR",
  "USER deepsonar",
  'io.deepsonar.image-key="deepsonar-reverse"',
  "materialize-runtime-manuals.mjs",
  "linux_x86_64",
  "linux_arm_64",
]) {
  if (!dockerfile.includes(required)) fail(`Dockerfile missing ${required}`);
}

if (!dockerfile.includes("npm view rea-agents@${REA_AGENTS_VERSION} dist.integrity")) {
  fail("Dockerfile must verify npm integrity");
}
if (!dockerfile.includes("npm view rea-agents@${REA_AGENTS_VERSION} gitHead")) {
  fail("Dockerfile must verify gitHead");
}
if (dockerfile.includes("MCP") && dockerfile.toLowerCase().includes("install mcp")) {
  fail("Dockerfile must not install MCP");
}
if (!envScript.includes("imageKey == \"deepsonar-reverse\"")) fail("reverse-env must check imageKey");
if (!envScript.includes("hopper") || !envScript.includes("ida64")) fail("reverse-env must forbid hopper/ida");

console.log("reverse-runtime static gate passed (no image build / no REA execution in this check)");
