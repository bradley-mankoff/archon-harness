#!/usr/bin/env bun
import { Command } from "commander";
import { installHarness } from "./install.ts";
import { doctor, postflight, preflight, runArchon, runProfileAgent } from "./runtime.ts";
import { agentMemoryAdapter } from "./adapters/agentmemory.ts";
import { gitNexusAdapter } from "./adapters/gitnexus.ts";
import { rtkAdapter } from "./adapters/rtk.ts";
import { smokeBatch } from "./batch.ts";
import { ensureAgentMemory } from "./services/agentmemory.ts";
import { runBenchmark } from "./benchmark.ts";
import { publicSlackConfig, readSlackConfig, runSlackBridge } from "./slack.ts";
import { runUi } from "./ui.ts";
import { harnessProfileSchema, type HarnessProfile } from "./profile.ts";

function profile(value: string): HarnessProfile {
  return harnessProfileSchema.parse(value);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function createProgram(): Command {
  const program = new Command()
    .name("archon-harness")
    .description("Archon-owned OMP-native and Pi-modular coding harness")
    .version("0.1.0");

  program
    .command("install")
    .description(
      "Install pinned Archon and register the OMP-native and Pi-modular harness profiles",
    )
    .option("--model <provider/model[:thinking]>", "model for both profiles")
    .option("--omp-model <provider/model[:thinking]>", "OMP-native model override")
    .option("--pi-model <provider/model[:thinking]>", "optional Pi-modular model")
    .option("--thinking <level>", "thinking level for both profiles")
    .option("--default-profile <profile>", "omp-native or pi-modular", "omp-native")
    .option("--force-download", "redownload and verify the Archon binary")
    .action(
      async (options: {
        model?: string;
        ompModel?: string;
        piModel?: string;
        thinking?: string;
        defaultProfile?: string;
        forceDownload?: boolean;
      }) => {
        printJson(await installHarness(options));
      },
    );

  program
    .command("chat")
    .description("Run the always-on Archon workflow")
    .argument("<message...>")
    .option("--cwd <path>", "target repository", process.cwd())
    .option("--profile <profile>", "omp-native or pi-modular")
    .action(async (message: string[], options: { cwd: string; profile?: string }) => {
      process.exitCode = await runArchon(
        message.join(" "),
        options.cwd,
        options.profile ? profile(options.profile) : undefined,
      );
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
    .description("Run the offline component effectiveness and token audit")
    .option("--cwd <path>", "target repository", process.cwd())
    .action(async (options: { cwd: string }) => {
      await ensureAgentMemory();
      const report = await runBenchmark(options.cwd);
      printJson(report);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("ui")
    .description("Start the loopback-only Archon Web interface")
    .option("--port <port>", "local server port", "3090")
    .option("--no-open", "do not open the browser automatically")
    .action(async (options: { port: string; open: boolean }) => {
      const port = Number(options.port);
      process.exitCode = await runUi(port, options.open);
    });

  const slack = program
    .command("slack")
    .description("Operate the allowlisted Slack Socket Mode bridge");
  slack
    .command("check")
    .description("Validate Slack environment and repository access without connecting")
    .action(async () => {
      printJson({ ok: true, config: publicSlackConfig(await readSlackConfig()) });
    });
  slack
    .command("start")
    .description("Connect the Slack Socket Mode bridge")
    .action(async () => {
      await runSlackBridge(await readSlackConfig());
    });

  const internal = program
    .command("internal", { hidden: true })
    .description("Workflow-only commands");
  internal
    .command("preflight")
    .requiredOption("--profile <profile>")
    .requiredOption("--cwd <path>")
    .action(async (options: { profile: string; cwd: string }) => {
      printJson(await preflight(profile(options.profile), options.cwd));
    });
  internal
    .command("agent")
    .requiredOption("--profile <profile>")
    .requiredOption("--cwd <path>")
    .requiredOption("--artifacts <path>")
    .requiredOption("--message <message>")
    .action(
      async (options: { profile: string; cwd: string; artifacts: string; message: string }) => {
        process.exitCode = await runProfileAgent(
          profile(options.profile),
          options.cwd,
          options.artifacts,
          options.message,
        );
      },
    );
  internal
    .command("postflight")
    .requiredOption("--profile <profile>")
    .requiredOption("--artifacts <path>")
    .action(async (options: { profile: string; artifacts: string }) => {
      printJson({ evidence: await postflight(profile(options.profile), options.artifacts) });
    });

  return program;
}

if (import.meta.main) {
  await createProgram().parseAsync(process.argv);
}
