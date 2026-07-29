import { spawn } from "node:child_process";
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
    const processHandle = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (!processHandle.stdout || !processHandle.stderr) {
      throw new Error("Process runner failed to create output pipes");
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    processHandle.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    processHandle.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    if (request.stdin !== undefined) processHandle.stdin?.end(request.stdin);

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      processHandle.kill("SIGTERM");
      killTimer = setTimeout(() => processHandle.kill("SIGKILL"), 1_000);
    }, request.timeoutMs);

    const exitCode = await new Promise<number>((resolve, reject) => {
      processHandle.once("error", reject);
      processHandle.once("close", (code) => resolve(code ?? (timedOut ? 124 : 1)));
    }).finally(() => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    });
    const stdout = Buffer.concat(stdoutChunks).toString();
    const stderr = Buffer.concat(stderrChunks).toString();

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
      exitCode: timedOut ? 124 : exitCode,
      durationMs: Math.round(performance.now() - started),
      timedOut,
      truncated: limitedStdout.truncated || limitedStderr.truncated,
      rawBytes,
      returnedBytes,
    };
  }
}

export const processRunner = new ProcessRunner();
