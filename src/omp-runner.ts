#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  SessionManager,
  Settings,
  createAgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { z } from "zod";
import { thinkingLevelSchema } from "./model.ts";

const runnerInputSchema = z.object({
  cwd: z.string().min(1),
  config: z.string().min(1),
  extension: z.string().min(1),
  message: z.string().min(1),
  model: z.string().min(1).optional(),
  thinking: thinkingLevelSchema.optional(),
  maxTimeMs: z.number().int().positive(),
});

export type OmpRunnerInput = z.infer<typeof runnerInputSchema>;

interface OmpRunnerDependencies {
  createSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<Pick<CreateAgentSessionResult, "session" | "extensionsResult">>;
  print: typeof runPrintMode;
  loadSettings: typeof Settings.loadIsolated;
  now: () => number;
}

const defaultDependencies: OmpRunnerDependencies = {
  createSession: createAgentSession,
  print: runPrintMode,
  loadSettings: Settings.loadIsolated,
  now: Date.now,
};

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`OMP runner requires ${name}`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`OMP runner requires a value for ${name}`);
  return value;
}

export function parseOmpRunnerArgs(args: string[]): OmpRunnerInput {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new Error("OMP runner requires -- followed by a message");
  }
  const optionArgs = args.slice(0, separator);
  const maxTimeMs = Number(requiredOption(optionArgs, "--max-time-ms"));
  return runnerInputSchema.parse({
    cwd: requiredOption(optionArgs, "--cwd"),
    config: requiredOption(optionArgs, "--config"),
    extension: requiredOption(optionArgs, "--extension"),
    model: optionalOption(optionArgs, "--model"),
    thinking: optionalOption(optionArgs, "--thinking"),
    maxTimeMs,
    message: args.slice(separator + 1).join(" "),
  });
}

export async function runOmpNative(
  rawInput: OmpRunnerInput,
  dependencies: OmpRunnerDependencies = defaultDependencies,
): Promise<void> {
  const input = runnerInputSchema.parse(rawInput);
  const cwd = resolve(input.cwd);
  const extension = resolve(input.extension);
  process.env.PI_NO_TITLE = "1";
  const settings = await dependencies.loadSettings({
    cwd,
    configFiles: [resolve(input.config)],
  });
  const result = await dependencies.createSession({
    cwd,
    settings,
    sessionManager: SessionManager.inMemory(cwd),
    ...(input.model ? { modelPattern: input.model } : {}),
    ...(input.thinking ? { thinkingLevel: input.thinking as ConfiguredThinkingLevel } : {}),
    deadline: dependencies.now() + input.maxTimeMs,
    additionalExtensionPaths: [extension],
    disableExtensionDiscovery: true,
    skills: [],
    rules: [],
    autoApprove: false,
  });

  const loadedPaths = result.extensionsResult.extensions
    .map((item) => item.resolvedPath)
    .filter((path) => !path.startsWith("<inline-"))
    .map((path) => resolve(path));
  if (
    result.extensionsResult.errors.length > 0 ||
    loadedPaths.length !== 1 ||
    loadedPaths[0] !== extension
  ) {
    await result.session.dispose();
    throw new Error(
      `OMP extension isolation failed: ${JSON.stringify({ loadedPaths, errors: result.extensionsResult.errors })}`,
    );
  }

  await dependencies.print(result.session, { mode: "text", initialMessage: input.message });
}

if (import.meta.main) {
  await runOmpNative(parseOmpRunnerArgs(process.argv.slice(2)));
}
