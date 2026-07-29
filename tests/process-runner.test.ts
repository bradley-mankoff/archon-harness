import { describe, expect, test } from "bun:test";
import { ProcessRunner } from "../src/process-runner.ts";

describe("process runner", () => {
  test("preserves stdin, environment, output, and exit status", async () => {
    const result = await new ProcessRunner().run({
      executable: process.execPath,
      args: [
        "-e",
        'process.stdin.setEncoding("utf8"); let value = ""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => { process.stdout.write(process.env.PROBE + ":" + value); process.stderr.write("diagnostic"); process.exitCode = 7; });',
      ],
      cwd: process.cwd(),
      env: { PROBE: "ready" },
      stdin: "payload",
      timeoutMs: 5_000,
      maxOutputBytes: 2_000,
    });

    expect(result).toMatchObject({
      stdout: "ready:payload",
      stderr: "diagnostic",
      exitCode: 7,
      timedOut: false,
      truncated: false,
    });
  });

  test("terminates and reports a bounded timeout", async () => {
    const result = await new ProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
      maxOutputBytes: 2_000,
    });

    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
  });
});
