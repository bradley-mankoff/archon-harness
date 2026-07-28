#!/usr/bin/env bun
import { Command } from "commander";
import { installHarness } from "./install.ts";
import { doctor, postflight, preflight, runArchon } from "./runtime.ts";
import { agentMemoryAdapter } from "./adapters/agentmemory.ts";
import { gitNexusAdapter } from "./adapters/gitnexus.ts";
import { rtkAdapter } from "./adapters/rtk.ts";
import { smokeBatch } from "./batch.ts";
import { ensureAgentMemory } from "./services/agentmemory.ts";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function createProgram(): Command {
  const program = new Command()
    .name("archon-harness")
    .description("Archon-owned, OMP-powered efficient coding harness")
    .version("0.1.0");

  program
    .command("install")
    .description(
      "Install the pinned Archon binary and register the harness workflow and OMP extension",
    )
    .option("--model <provider/model[:thinking]>", "OMP model override")
    .option("--thinking <level>", "OMP thinking: off|minimal|low|medium|high|xhigh|max|auto")
    .option("--force-download", "redownload and verify the Archon binary")
    .action(async (options: { model?: string; thinking?: string; forceDownload?: boolean }) => {
      printJson(await installHarness(options));
    });

  program
    .command("chat")
    .description("Run the always-on Archon workflow")
    .argument("<message...>")
    .option("--cwd <path>", "target repository", process.cwd())
    .action(async (message: string[], options: { cwd: string }) => {
      process.exitCode = await runArchon(message.join(" "), options.cwd);
    });

  program
    .command("doctor")
    .description("Check installed harness dependencies without changing state")
    .option("--cwd <path>", "target repository", process.cwd())
    .action(async (options: { cwd: string }) => {
      const results = await doctor(options.cwd);
      printJson({ ok: results.every((result) => result.ok), results });
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    });

  program
    .command("smoke")
    .description("Run local adapter smoke checks")
    .option("--cwd <path>", "target repository", process.cwd())
    .action(async (options: { cwd: string }) => {
      await ensureAgentMemory();
      const results = await Promise.all([
        smokeBatch(options.cwd),
        rtkAdapter.smoke(options.cwd),
        gitNexusAdapter.smoke(options.cwd),
        agentMemoryAdapter.smoke(options.cwd),
      ]);
      printJson({ ok: results.every((result) => result.ok), results });
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    });

  program
    .command("benchmark")
    .description("Measure RTK output reduction while preserving command status")
    .option("--cwd <path>", "target repository", process.cwd())
    .action(async (options: { cwd: string }) => {
      const input = "git status --short";
      const rewritten = await rtkAdapter.rewrite(input, options.cwd);
      printJson({
        input,
        optimized: rewritten.command,
        rewritten: rewritten.rewritten,
        fidelityBoundary: "same command intent; runtime exit code is preserved by command_batch",
      });
      if (!rewritten.rewritten) process.exitCode = 1;
    });

  const internal = program
    .command("internal", { hidden: true })
    .description("Workflow-only commands");
  internal
    .command("preflight")
    .requiredOption("--cwd <path>")
    .requiredOption("--artifacts <path>")
    .action(async (options: { cwd: string; artifacts: string }) => {
      printJson(await preflight(options.cwd));
    });
  internal
    .command("postflight")
    .requiredOption("--artifacts <path>")
    .action(async (options: { artifacts: string }) => {
      printJson({ evidence: await postflight(options.artifacts) });
    });

  return program;
}

if (import.meta.main) {
  await createProgram().parseAsync(process.argv);
}
