import assert from "node:assert/strict";
import test from "node:test";
import { runRealAgent } from "./runtime-agent.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { RuntimeHost, RuntimeProcess, RuntimeProcessChunk } from "./runtime-host.js";

const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session.jsonl";
class PiProcess implements RuntimeProcess {
  stdinClosed = false;
  commands: Record<string, unknown>[] = [];
  queue: RuntimeProcessChunk[] = [];
  wake?: () => void;
  ended = false;
  constructor(private readonly input: (record: Record<string, unknown>, process: PiProcess) => void) {}
  emit(record: Record<string, unknown>) {
    this.queue.push({ type: "stdout", chunk: `${JSON.stringify(record)}\n` });
    this.wake?.();
  }
  async write(data: string) {
    const record = JSON.parse(data);
    this.commands.push(record);
    this.input(record, this);
  }
  async closeStdin() { this.stdinClosed = true; this.ended = true; this.wake?.(); }
  async kill() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    while (!this.ended || this.queue.length) {
      const record = this.queue.shift();
      if (record) yield record;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    yield { type: "exit", exitCode: 0 };
  }
}
function state(process: PiProcess, command: Record<string, unknown>, id = "session-1") {
  process.emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: id, sessionFile } });
}
function turn(process: PiProcess, command: Record<string, unknown>, error?: string) {
  process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  process.emit({ type: "agent_start" });
  process.emit({ type: "message_end", message: error
    ? { role: "assistant", stopReason: "error", errorMessage: error }
    : { role: "assistant", content: [{ type: "text", text: "done" }] } });
  process.emit({ type: "agent_end" });
  process.emit({ type: "agent_settled", aborted: false });
}
function host(factory: (index: number) => PiProcess, nonempty = true) {
  const processes: PiProcess[] = [];
  const runtime: RuntimeHost = {
    run: async (command) => ({ exitCode: command.startsWith("test -s") && !nonempty ? 1 : 0, stdout: "", stderr: "" }),
    runAsync: async () => { const process = factory(processes.length); processes.push(process); return process; },
    uploadFile: async () => {},
    readWorkspaceFile: async () => Buffer.from(""),
    writeHumanInboxFile: async () => {},
  };
  return { runtime, processes };
}

test("production Pi runner starts idle completion nudges with prompt once per turn", async () => {
  let prompts = 0;
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") { prompts++; turn(process, record); }
    else throw new Error(`idle command cannot start loop: ${String(record.type)}`);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => prompts >= 2 });
  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.equal(prompts, 2);
  assert.deepEqual(fake.processes[0]!.commands.map((record) => record.type), ["get_state", "prompt", "prompt"]);
});

test("production Pi runner resets failed attempt and verifies resumed identity before prompt", async () => {
  const fake = host((index) => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record, index === 0 ? "HTTP 503 upstream unavailable" : undefined);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.equal(result.text, "done");
  assert.equal(fake.processes.length, 2);
  assert.deepEqual(fake.processes[1]!.commands.map((record) => record.type), ["get_state", "prompt"]);
});

test("production Pi runner fails closed when restart changes the actual session identity", async () => {
  const fake = host((index) => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record, index === 0 ? "session-1" : "session-replaced");
    else if (record.type === "prompt") turn(process, record, "HTTP 503 upstream unavailable");
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.match(result.error ?? "", /CONTEXT_RESUME_SESSION_IDENTITY_MISMATCH/);
  assert.deepEqual(fake.processes[1]!.commands.map((record) => record.type), ["get_state"]);
});

test("production Pi runner refuses to resume a missing or empty session file", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record, "HTTP 503 upstream unavailable");
  }), false);
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.match(result.error ?? "", /AGENT_CLI_RESUME_FAILED/);
  assert.equal(fake.processes.length, 1);
});

for (const ack of [false, true]) {
  test(`Pi RPC bounds ${ack ? "start" : "ack"} wait without replaying input`, async () => {
    const process = new PiProcess(() => {});
    const driver = new PiRpcDriver(process, () => {}, undefined, 15);
    await driver.initialize("initial");
    const query = process.commands[0]!;
    await driver.observe({ type: "response", id: query.id, command: "get_state", success: true, data: { sessionId: "session-1", sessionFile } });
    if (ack) await driver.observe({ type: "response", id: process.commands[1]!.id, command: "prompt", success: true, data: { disposition: "started" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(driver.error?.message ?? "", /PI_RPC_(ACK|START)_TIMEOUT/);
    assert.equal(process.ended, true);
    assert.equal(process.commands.length, 2);
  });
}

test("production Pi readiness can deliver an already waiting human message", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record);
  }));
  const result = await runRealAgent(fake.runtime, {
    provider: "pi", env: {}, input: "initial",
    onRunReady: async ({ sendMessage }) => { await sendMessage("waiting human message"); },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(fake.processes[0]!.commands.map((record) => record.type), ["get_state", "prompt", "prompt"]);
});

test("Pi settlement cannot hide a missing input acknowledgement", async () => {
  const process = new PiProcess(() => {});
  const driver = new PiRpcDriver(process, () => {});
  try {
    await driver.initialize("initial");
    await driver.observe({ type: "response", id: process.commands[0]!.id, command: "get_state", success: true, data: { sessionId: "session-1", sessionFile } });
    await driver.observe({ type: "agent_start" });
    assert.equal(await driver.observe({ type: "agent_settled" }), false);
    assert.match(driver.finishError()?.message ?? "", /PI_RPC_INPUT_UNACKNOWLEDGED/);
  } finally { driver.dispose(); }
});
