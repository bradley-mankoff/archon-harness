import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentMemoryAdapter } from "../adapters/agentmemory.ts";
import { recordAudit } from "../audit.ts";
import {
  automaticStructuralContext,
  codeScoutParamsSchema,
  commandBatchParamsSchema,
  concisePolicy,
  memorySearchParamsSchema,
  runCodeScout,
  runCommandBatch,
  text,
  toolText,
} from "./shared.ts";

export default async function piHarnessExtension(pi: ExtensionAPI): Promise<void> {
  const policy = await concisePolicy();
  const sessionId = `archon-harness-${crypto.randomUUID()}`;
  let cwd = process.cwd();
  let structuralContext = "";
  let recalledContext = "";
  let memoryStarted = false;

  pi.registerTool({
    name: "command_batch",
    label: "Command batch",
    description:
      "Run up to 20 shell commands in dependency steps. Commands in one step run concurrently; RTK compacts supported noisy output.",
    parameters: Type.Object({
      commands: Type.Array(
        Type.Object({
          command: Type.String({ minLength: 1 }),
          step: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 900_000, default: 30_000 })),
        }),
        { minItems: 1, maxItems: 20 },
      ),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      commandBatchParamsSchema.parse(rawParams);
      return runCommandBatch(rawParams, ctx.cwd, true);
    },
  });

  pi.registerTool({
    name: "code_scout",
    label: "Code scout",
    description:
      "Use for repository-wide relationships, call chains, architecture, or blast-radius analysis.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("query"), Type.Literal("context"), Type.Literal("impact")]),
      target: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      codeScoutParamsSchema.parse(rawParams);
      return runCodeScout(rawParams, ctx.cwd);
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory search",
    description: "Recall bounded cross-session project memory from agentmemory.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = memorySearchParamsSchema.parse(rawParams);
      const output = await agentMemoryAdapter.search(
        params.query,
        params.limit,
        ctx.cwd,
        sessionId,
      );
      await recordAudit("agentmemory", "memory_search_executed", {
        bytes: Buffer.byteLength(output),
      });
      return toolText(output, { bytes: Buffer.byteLength(output) });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    recalledContext = await agentMemoryAdapter.start(sessionId, cwd);
    memoryStarted = true;
    await recordAudit("pi", "session_started", {
      tools: ["command_batch", "code_scout", "memory_search"],
    });
    await recordAudit("hashline", "runtime_verified", {
      implementation: "pi-hashline-edit-pro",
    });
    await recordAudit("batching", "tool_registered", { rtk: true });
    await recordAudit("agentmemory", "session_started", {
      contextBytes: Buffer.byteLength(recalledContext),
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await agentMemoryAdapter.observe(sessionId, cwd, "prompt_submit", { prompt: event.prompt });
    structuralContext ||= await automaticStructuralContext(event.prompt, ctx.cwd);
    await recordAudit("concise", "policy_injected", { bytes: Buffer.byteLength(policy) });
    const memory = recalledContext.trim()
      ? `\n\n# Recalled project memory\n${recalledContext.slice(0, 8_000)}`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${policy}\n\n# Automatic structural context\n${structuralContext}${memory}`,
    };
  });

  pi.on("tool_result", async (event) => {
    const output = event.content
      .map((item) => (item.type === "text" ? item.text : "[image]"))
      .join("\n");
    await agentMemoryAdapter.observe(
      sessionId,
      cwd,
      event.isError ? "post_tool_failure" : "post_tool_use",
      {
        tool_name: event.toolName,
        tool_input: event.input,
        tool_output: text(output).slice(0, 20_000),
      },
    );
  });

  pi.on("session_shutdown", async () => {
    if (!memoryStarted) return;
    await agentMemoryAdapter.observe(sessionId, cwd, "stop", { reason: "session_shutdown" });
    await agentMemoryAdapter.end(sessionId);
  });
}
