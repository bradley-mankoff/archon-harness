import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_EDIT_MODE } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { recordAudit } from "../audit.ts";
import {
  automaticStructuralContext,
  codeScoutParamsSchema,
  commandBatchParamsSchema,
  concisePolicy,
  runCodeScout,
  runCommandBatch,
} from "./shared.ts";

export default async function ompHarnessExtension(pi: ExtensionAPI): Promise<void> {
  const { Type } = pi.typebox;
  const policy = await concisePolicy();
  let structuralContext = "";

  pi.registerTool({
    name: "command_batch",
    label: "Command batch",
    description:
      "Run up to 20 shell commands in dependency steps. Commands in one step run concurrently; later steps stop after failure.",
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
      commandBatchParamsSchema.parse(rawParams);
      return runCommandBatch(rawParams, ctx.cwd, false);
    },
  });

  pi.registerTool({
    name: "code_scout",
    label: "Code scout",
    description:
      "Use for repository-wide relationships, call chains, architecture, or blast-radius analysis. Ordinary exact search stays with OMP.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("query"), Type.Literal("context"), Type.Literal("impact")]),
      target: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
    }),
    approval: "read",
    loadMode: "essential",
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      codeScoutParamsSchema.parse(rawParams);
      return runCodeScout(rawParams, ctx.cwd);
    },
  });

  pi.on("session_start", async () => {
    if (DEFAULT_EDIT_MODE !== "hashline") {
      throw new Error(`OMP default edit mode changed to ${DEFAULT_EDIT_MODE}`);
    }
    await recordAudit("omp", "session_started", {
      tools: ["command_batch", "code_scout"],
      memory: "off",
    });
    await recordAudit("hashline", "runtime_verified", { implementation: "omp-native" });
    await recordAudit("batching", "tool_registered", { rtk: false });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    structuralContext ||= await automaticStructuralContext(event.prompt, ctx.cwd);
    await recordAudit("concise", "policy_injected", { bytes: Buffer.byteLength(policy) });
    return {
      systemPrompt: [
        ...event.systemPrompt,
        `${policy}\n\n# Automatic structural context\n${structuralContext}`,
      ],
    };
  });
}
