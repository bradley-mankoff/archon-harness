import { describe, expect, test } from "bun:test";
import type { ProcessRequest, ProcessResult } from "../src/contracts.ts";
import { executeBatch } from "../src/batch.ts";

function result(exitCode: number, stdout = ""): ProcessResult {
  return {
    stdout,
    stderr: "",
    exitCode,
    durationMs: 1,
    timedOut: false,
    truncated: false,
    rawBytes: Buffer.byteLength(stdout),
    returnedBytes: Buffer.byteLength(stdout),
  };
}

describe("command batching", () => {
  test("runs one dependency step concurrently before the next", async () => {
    const started: string[] = [];
    let releaseStepOne: (() => void) | undefined;
    const stepOneGate = new Promise<void>((resolve) => {
      releaseStepOne = resolve;
    });
    let stepOneStarted = 0;
    const runner = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        const command = request.args.at(-1) ?? "";
        started.push(command);
        if (command === "one" || command === "two") {
          stepOneStarted += 1;
          if (stepOneStarted === 2) releaseStepOne?.();
          await stepOneGate;
        }
        if (command === "three") expect(stepOneStarted).toBe(2);
        return result(0, command);
      },
    };
    const rtk = { rewrite: async (command: string) => ({ command, rewritten: false }) };

    const batch = await executeBatch(
      {
        commands: [
          { command: "one", step: 1, timeoutMs: 1_000 },
          { command: "two", step: 1, timeoutMs: 1_000 },
          { command: "three", step: 2, timeoutMs: 1_000 },
        ],
      },
      process.cwd(),
      { runner, rtk },
    );

    expect(batch.ok).toBeTrue();
    expect(started.slice(0, 2).sort()).toEqual(["one", "two"]);
    expect(started[2]).toBe("three");
    expect(batch.modelToolCalls).toBe(1);
  });

  test("preserves failure and skips later steps", async () => {
    const runner = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        return result(request.args.at(-1) === "fail" ? 7 : 0);
      },
    };
    const rtk = { rewrite: async (command: string) => ({ command, rewritten: false }) };
    const batch = await executeBatch(
      {
        commands: [
          { command: "fail", step: 1, timeoutMs: 1_000 },
          { command: "never", step: 2, timeoutMs: 1_000 },
        ],
      },
      process.cwd(),
      { runner, rtk },
    );

    expect(batch.ok).toBeFalse();
    expect(batch.commands[0]?.exitCode).toBe(7);
    expect(batch.commands[1]).toMatchObject({ skipped: true, exitCode: 125 });
  });
});
