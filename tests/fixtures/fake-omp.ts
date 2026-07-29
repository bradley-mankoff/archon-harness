#!/usr/bin/env bun
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";

if (process.env.HARNESS_FAKE_PI === "1") {
  const child = Bun.spawn(
    ["node", new URL("./fake-pi.ts", import.meta.url).pathname, ...process.argv.slice(2)],
    { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await child.exited);
}

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("17.1.6\n");
  process.exit(0);
}

function option(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`fake OMP requires ${name}`);
  return value;
}

if (!args.includes("-p")) throw new Error("fake OMP requires print mode");
if (!args.includes("--")) throw new Error("fake OMP requires a prompt separator");

const cwd = option("--cwd");
const extensionPath = option("--extension");
const loaded = await loadExtensions([extensionPath], cwd);
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const loadedExtension = loaded.extensions[0];
if (!loadedExtension) throw new Error("fake OMP did not load the harness extension");
const extension = loadedExtension;

const expectedTools = ["code_scout", "command_batch"];
if (JSON.stringify([...extension.tools.keys()].sort()) !== JSON.stringify(expectedTools)) {
  throw new Error("fake OMP did not receive all harness tools");
}

async function emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
  const handlers = extension.handlers.get(event);
  if (handlers?.length !== 1) throw new Error(`fake OMP expected one ${event} handler`);
  return handlers[0]?.(payload, { cwd });
}

await emit("session_start", { type: "session_start" });
const promptIndex = args.indexOf("--") + 1;
const result = await emit("before_agent_start", {
  type: "before_agent_start",
  prompt: args.slice(promptIndex).join(" "),
  systemPrompt: ["fixture system prompt"],
});
const parsed = z.object({ systemPrompt: z.array(z.string()) }).parse(result);
if (!parsed.systemPrompt.some((item) => item.includes("Lead with the result"))) {
  throw new Error("fake OMP did not receive the concise final policy");
}

process.stderr.write("Working...\n");
process.stdout.write("no-model OMP lifecycle completed\n");
