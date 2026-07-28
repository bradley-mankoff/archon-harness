import { processRequestSchema, type ProcessRequest, type ProcessResult } from "./contracts.ts";

function limitUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return { text: value, truncated: false };
  const headBytes = Math.floor(maxBytes * 0.6);
  const tailBytes = maxBytes - headBytes;
  const buffer = Buffer.from(value);
  const omitted = bytes - maxBytes;
  return {
    text: `${buffer.subarray(0, headBytes).toString()}\n...[${omitted} bytes omitted]...\n${buffer.subarray(bytes - tailBytes).toString()}`,
    truncated: true,
  };
}

export class ProcessRunner {
  async run(rawRequest: ProcessRequest): Promise<ProcessResult> {
    const request = processRequestSchema.parse(rawRequest);
    const started = performance.now();
    const processHandle = Bun.spawn([request.executable, ...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      processHandle.kill("SIGTERM");
    }, request.timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]).finally(() => clearTimeout(timeout));

    const rawBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const stdoutBudget = Math.max(1, Math.floor(request.maxOutputBytes * 0.7));
    const stderrBudget = Math.max(1, request.maxOutputBytes - stdoutBudget);
    const limitedStdout = limitUtf8(stdout, stdoutBudget);
    const limitedStderr = limitUtf8(stderr, stderrBudget);
    const returnedBytes =
      Buffer.byteLength(limitedStdout.text) + Buffer.byteLength(limitedStderr.text);

    return {
      stdout: limitedStdout.text,
      stderr: limitedStderr.text,
      exitCode: timedOut && exitCode === 0 ? 124 : exitCode,
      durationMs: Math.round(performance.now() - started),
      timedOut,
      truncated: limitedStdout.truncated || limitedStderr.truncated,
      rawBytes,
      returnedBytes,
    };
  }
}

export const processRunner = new ProcessRunner();
