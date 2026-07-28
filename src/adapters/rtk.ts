import type { CheckResult, HarnessAdapter } from "../contracts.ts";
import { processRunner } from "../process-runner.ts";

export interface RewriteResult {
  command: string;
  rewritten: boolean;
}

export class RtkAdapter implements HarnessAdapter {
  readonly name = "rtk";

  constructor(private readonly runner: Pick<typeof processRunner, "run"> = processRunner) {}

  async rewrite(command: string, cwd: string): Promise<RewriteResult> {
    if (command.trimStart().startsWith("rtk ")) return { command, rewritten: false };
    const result = await this.runner.run({
      executable: "rtk",
      args: ["rewrite", command],
      cwd,
      env: {},
      timeoutMs: 2_000,
      maxOutputBytes: 20_000,
    });
    const candidate = result.stdout.trim();
    if ((result.exitCode === 0 || result.exitCode === 3) && candidate) {
      return { command: candidate, rewritten: candidate !== command };
    }
    return { command, rewritten: false };
  }

  async doctor(): Promise<CheckResult> {
    const result = await this.runner.run({
      executable: "rtk",
      args: ["--version"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
      maxOutputBytes: 2_000,
    });
    return {
      name: this.name,
      ok: result.exitCode === 0 && /rtk 0\.42\.3/.test(result.stdout),
      detail: result.stdout.trim() || result.stderr.trim(),
    };
  }

  async smoke(cwd: string): Promise<CheckResult> {
    const rewritten = await this.rewrite("git status", cwd);
    return {
      name: this.name,
      ok: rewritten.rewritten && rewritten.command.startsWith("rtk git status"),
      detail: rewritten.command,
      evidence: { input: "git status", rewritten: rewritten.rewritten },
    };
  }
}

export const rtkAdapter = new RtkAdapter();
