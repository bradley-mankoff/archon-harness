#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("0.82.1\n");
  process.exit(0);
}

if (!args.includes("-p")) throw new Error("fake Pi requires print mode");
if (args.includes("--")) throw new Error("fake Pi does not accept a prompt separator");
if (!args.includes("--offline")) throw new Error("fake Pi requires offline startup");

const optionsWithValues = new Set(["--extension", "--model", "--thinking"]);
const positional: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (!arg) continue;
  if (optionsWithValues.has(arg)) {
    index += 1;
  } else if (!arg.startsWith("-")) {
    positional.push(arg);
  }
}
if (positional.length !== 1) throw new Error("fake Pi requires one positional prompt");

const extensionPaths = args.flatMap((arg, index) =>
  arg === "--extension" && args[index + 1] ? [args[index + 1] as string] : [],
);
const neutralRoot = await mkdtemp(join(tmpdir(), "archon-harness-fake-pi-"));

try {
  const loaded = await discoverAndLoadExtensions(
    extensionPaths,
    process.cwd(),
    join(neutralRoot, "agent"),
  );
  if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));

  const tools = [
    ...new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])),
  ].sort();
  const expectedTools = [
    "code_scout",
    "command_batch",
    "memory_search",
    "read",
    "replace",
    "undo_last_replace",
  ];
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    throw new Error(`fake Pi received unexpected tools: ${JSON.stringify(tools)}`);
  }

  const harness = loaded.extensions.find((extension) =>
    extension.path.endsWith("/src/extension/pi.ts"),
  );
  if (!harness) throw new Error("fake Pi did not load the harness extension");
  const extension = harness;

  async function emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
    const handlers = extension.handlers.get(event);
    if (handlers?.length !== 1) throw new Error(`fake Pi expected one ${event} handler`);
    return handlers[0]?.(payload, { cwd: process.cwd() });
  }

  await emit("session_start", { type: "session_start", reason: "new" });
  const result = await emit("before_agent_start", {
    type: "before_agent_start",
    prompt: positional[0],
    images: [],
    systemPrompt: "fixture system prompt",
  });
  const parsed = z.object({ systemPrompt: z.string() }).parse(result);
  if (!parsed.systemPrompt.includes("Lead with the result")) {
    throw new Error("fake Pi did not receive the concise final policy");
  }
  await emit("session_shutdown", { type: "session_shutdown" });

  process.stderr.write("Working...\n");
  process.stdout.write("no-model Pi lifecycle completed\n");
} finally {
  await rm(neutralRoot, { recursive: true, force: true });
}
