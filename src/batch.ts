import { z } from "zod";
import type { CheckResult } from "./contracts.ts";
import { processRunner } from "./process-runner.ts";
import { rtkAdapter } from "./adapters/rtk.ts";

export const batchRequestSchema = z.object({
  commands: z
    .array(
      z.object({
        command: z.string().min(1),
        step: z.number().int().positive().default(1),
        timeoutMs: z.number().int().positive().max(900_000).default(30_000),
      }),
    )
    .min(1)
    .max(20),
});

export type BatchRequest = z.infer<typeof batchRequestSchema>;

export interface BatchCommandResult {
  command: string;
  executedCommand: string;
  step: number;
  rewrittenByRtk: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  skipped: boolean;
}

export interface BatchResult {
  ok: boolean;
  modelToolCalls: 1;
  commands: BatchCommandResult[];
}

function shellExecutable(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

function shellArgs(command: string): string[] {
  return process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
}

export async function executeBatch(
  raw: BatchRequest,
  cwd: string,
  dependencies: {
    runner: Pick<typeof processRunner, "run">;
    rtk: Pick<typeof rtkAdapter, "rewrite">;
  } = {
    runner: processRunner,
    rtk: rtkAdapter,
  },
  useRtk = true,
): Promise<BatchResult> {
  const request = batchRequestSchema.parse(raw);
  const steps = [...new Set(request.commands.map((command) => command.step))].sort((a, b) => a - b);
  const results: BatchCommandResult[] = [];
  let failed = false;

  for (const step of steps) {
    const commands = request.commands.filter((command) => command.step === step);
    if (failed) {
      results.push(
        ...commands.map((command) => ({
          command: command.command,
          executedCommand: "",
          step,
          rewrittenByRtk: false,
          stdout: "",
          stderr: "Skipped because an earlier step failed.",
          exitCode: 125,
          durationMs: 0,
          skipped: true,
        })),
      );
      continue;
    }

    const stepResults = await Promise.all(
      commands.map(async (command): Promise<BatchCommandResult> => {
        const rewrite = useRtk
          ? await dependencies.rtk.rewrite(command.command, cwd)
          : { command: command.command, rewritten: false };
        const execution = await dependencies.runner.run({
          executable: shellExecutable(),
          args: shellArgs(rewrite.command),
          cwd,
          env: {},
          timeoutMs: command.timeoutMs,
          maxOutputBytes: 80_000,
        });
        return {
          command: command.command,
          executedCommand: rewrite.command,
          step,
          rewrittenByRtk: rewrite.rewritten,
          stdout: execution.stdout,
          stderr: execution.stderr,
          exitCode: execution.exitCode,
          durationMs: execution.durationMs,
          skipped: false,
        };
      }),
    );
    results.push(...stepResults);
    failed = stepResults.some((result) => result.exitCode !== 0);
  }

  return { ok: !failed, modelToolCalls: 1, commands: results };
}

export async function smokeBatch(cwd: string, useRtk = true): Promise<CheckResult> {
  const result = await executeBatch(
    {
      commands: [
        { command: "printf alpha", step: 1, timeoutMs: 5_000 },
        { command: "printf beta", step: 1, timeoutMs: 5_000 },
        { command: "printf gamma", step: 2, timeoutMs: 5_000 },
      ],
    },
    cwd,
    undefined,
    useRtk,
  );
  return {
    name: "tura-style-command-batch",
    ok:
      result.ok &&
      result.commands
        .map((command) => command.stdout)
        .join("")
        .includes("alphabetagamma"),
    detail: `3 commands, 2 dependency steps, ${result.modelToolCalls} model tool call`,
    evidence: { commands: 3, dependencySteps: 2, modelToolCalls: result.modelToolCalls },
  };
}
