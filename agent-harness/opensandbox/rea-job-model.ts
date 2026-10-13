/** Local deterministic Anthropic transport. Only planning is mocked, never tools. */
import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function startReaJobModel() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (request.url?.includes("count_tokens")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ input_tokens: 2000 }));
        return;
      }
      calls++;
      assert.ok(calls <= 50, "deterministic model request budget exhausted");
      const completedTool = (body.messages ?? []).some((message: any) => Array.isArray(message.content)
        && message.content.some((block: any) => block.type === "tool_result" && block.tool_use_id === "toolu_rea_e2e"));
      const content = completedTool
        ? [{ type: "text" as const, text: "REA test actor finished; authoritative outcome is in the Control API and Scheduler." }]
        : [{ type: "tool_use" as const, id: "toolu_rea_e2e", name: "Bash", input: {
          command: "python3 /workspace/rea-job-actor.py", timeout: 600000,
          description: "Run deterministic REA integration actor with real tools and governed Control API",
        } }];
      const stop = completedTool ? "end_turn" : "tool_use";
      const message = { id: "msg_rea_e2e", type: "message", role: "assistant", model: body.model,
        content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 100 } };
      if (!body.stream) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(message));
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      const event = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 2000, output_tokens: 0 } } });
      const block = content[0]!;
      if (block.type === "tool_use") {
        event("content_block_start", { index: 0, content_block: { ...block, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } });
      event("message_stop", {});
      response.end();
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { type: "api_error", message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
