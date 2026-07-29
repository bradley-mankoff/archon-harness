import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { gitNexusAdapter } from "../adapters/gitnexus.ts";
import { recordAudit } from "../audit.ts";
import { executeBatch } from "../batch.ts";
import { harnessRoot } from "../paths.ts";

export const commandBatchParamsSchema = z.object({
  commands: z.array(
    z.object({
      command: z.string().min(1),
      step: z.number().int().positive().default(1),
      timeoutMs: z.number().int().positive().max(900_000).default(30_000),
    }),
  ),
});

export const codeScoutParamsSchema = z.object({
  kind: z.enum(["query", "context", "impact"]),
  target: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
});

export const memorySearchParamsSchema = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
});

export function toolText(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function runCommandBatch(
  rawParams: unknown,
  cwd: string,
  useRtk: boolean,
): Promise<ReturnType<typeof toolText>> {
  const params = commandBatchParamsSchema.parse(rawParams);
  const result = await executeBatch(params, cwd, undefined, useRtk);
  await recordAudit("batching", "model_tool_executed", {
    commands: result.commands.length,
    ok: result.ok,
    useRtk,
  });
  return toolText(JSON.stringify(result), { ok: result.ok, commands: result.commands.length });
}

export async function runCodeScout(
  rawParams: unknown,
  cwd: string,
): Promise<ReturnType<typeof toolText>> {
  const params = codeScoutParamsSchema.parse(rawParams);
  const output = await gitNexusAdapter.scout(params, cwd);
  await recordAudit("gitnexus", "model_tool_executed", {
    kind: params.kind,
    bytes: Buffer.byteLength(output),
  });
  return toolText(output, { kind: params.kind, bytes: Buffer.byteLength(output) });
}

export async function automaticStructuralContext(prompt: string, cwd: string): Promise<string> {
  const query =
    prompt.trim().slice(0, 2_000) || "repository architecture and likely change surface";
  const output = await gitNexusAdapter.scout({ kind: "query", target: query, limit: 3 }, cwd);
  await recordAudit("gitnexus", "context_injected", {
    queryBytes: Buffer.byteLength(query),
    outputBytes: Buffer.byteLength(output),
  });
  return output;
}

export async function concisePolicy(): Promise<string> {
  return readFile(join(harnessRoot(), "prompts", "concise-final.md"), "utf8");
}
