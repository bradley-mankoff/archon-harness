import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_EDIT_MODE } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { agentMemoryAdapter } from "../adapters/agentmemory.ts";
import { gitNexusAdapter } from "../adapters/gitnexus.ts";
import { recordAudit } from "../audit.ts";
import { executeBatch } from "../batch.ts";
import { harnessRoot } from "../paths.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const commandBatchParamsSchema = z.object({
  commands: z.array(
    z.object({
      command: z.string().min(1),
      step: z.number().int().positive().default(1),
      timeoutMs: z.number().int().positive().max(900_000).default(30_000),
    }),
  ),
});

const codeScoutParamsSchema = z.object({
  kind: z.enum(["query", "context", "impact"]),
  target: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
});

const memorySearchParamsSchema = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
});

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toolText(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

export default async function archonHarnessExtension(pi: ExtensionAPI): Promise<void> {
  const { Type } = pi.typebox;
  const policy = await readFile(join(harnessRoot(), "prompts", "caveman-full.md"), "utf8");
  const sessionId = `archon-harness-${crypto.randomUUID()}`;
  let cwd = process.cwd();
  let recalledContext = "";
  let memoryStarted = false;

  pi.registerTool({
    name: "command_batch",
    label: "Command batch",
    description:
      "Run up to 20 shell commands in dependency steps; commands in one step run concurrently and RTK compacts supported output.",
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
    approval: "exec",
    loadMode: "essential",
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = commandBatchParamsSchema.parse(rawParams);
      const result = await executeBatch(params, ctx.cwd);
      await recordAudit("batching", "model_tool_executed", {
        commands: result.commands.length,
        ok: result.ok,
      });
      return toolText(JSON.stringify(result), { ok: result.ok, commands: result.commands.length });
    },
  });

  pi.registerTool({
    name: "code_scout",
    label: "Code scout",
    description:
      "Return bounded GitNexus structural query, symbol context, or impact analysis for the current indexed repository.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("query"), Type.Literal("context"), Type.Literal("impact")]),
      target: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
    }),
    approval: "read",
    loadMode: "essential",
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = codeScoutParamsSchema.parse(rawParams);
      const output = await gitNexusAdapter.scout(params, ctx.cwd);
      await recordAudit("gitnexus", "model_tool_executed", {
        kind: params.kind,
        bytes: Buffer.byteLength(output),
      });
      return toolText(output, { kind: params.kind, bytes: Buffer.byteLength(output) });
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
    approval: "read",
    loadMode: "essential",
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
    await recordAudit("omp", "extension_session_started", {
      tools: ["command_batch", "code_scout", "memory_search"],
    });
    await recordAudit("agentmemory", "session_started", {
      contextBytes: Buffer.byteLength(recalledContext),
    });
    if (DEFAULT_EDIT_MODE !== "hashline") {
      throw new Error(`OMP default edit mode changed to ${DEFAULT_EDIT_MODE}`);
    }
    await recordAudit("hashline", "extension_default_verified", { mode: DEFAULT_EDIT_MODE });
  });

  pi.on("before_agent_start", async (event) => {
    await agentMemoryAdapter.observe(sessionId, cwd, "prompt_submit", { prompt: event.prompt });
    await recordAudit("caveman", "policy_injected", { bytes: Buffer.byteLength(policy) });
    const memory = recalledContext.trim()
      ? `\n\n# Recalled project memory\n${recalledContext.slice(0, 8_000)}`
      : "";
    return { systemPrompt: [...event.systemPrompt, policy + memory] };
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
