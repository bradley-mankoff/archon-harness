import { z } from "zod";

export const processRequestSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().max(900_000).default(30_000),
  maxOutputBytes: z.number().int().positive().max(10_000_000).default(200_000),
});

export type ProcessRequest = z.infer<typeof processRequestSchema>;

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  rawBytes: number;
  returnedBytes: number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface SavingsMeasurement {
  name: string;
  baselineTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  savedPercent: number;
  fidelity: boolean;
  intent: string;
}

export interface HarnessAdapter {
  readonly name: string;
  doctor(): Promise<CheckResult>;
  smoke(cwd: string): Promise<CheckResult>;
}
