import { z } from "zod";
import type { CheckResult, HarnessAdapter } from "../contracts.ts";
import { redactRecord, redactText, redactUnknown } from "../redaction.ts";

const sessionStartResponseSchema = z.object({
  session: z.object({ id: z.string(), status: z.string() }),
  context: z.string(),
});

const searchResponseSchema = z.object({
  lessons: z.array(z.unknown()),
  mode: z.literal("compact"),
  results: z.array(
    z
      .object({
        obsId: z.string().min(1),
        sessionId: z.string().min(1),
      })
      .passthrough(),
  ),
});

type SearchResponse = z.infer<typeof searchResponseSchema>;

export class AgentMemoryAdapter implements HarnessAdapter {
  readonly name = "agentmemory";

  constructor(
    private readonly baseUrl = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.AGENTMEMORY_SECRET) {
      headers.authorization = `Bearer ${process.env.AGENTMEMORY_SECRET}`;
    }
    return headers;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(redactRecord(body)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`agentmemory ${path}: HTTP ${response.status}`);
    return response.json();
  }

  async start(sessionId: string, cwd: string): Promise<string> {
    const result = sessionStartResponseSchema.parse(
      await this.post("/agentmemory/session/start", {
        sessionId,
        project: cwd,
        cwd,
        agentId: "archon-harness",
      }),
    );
    return result.context;
  }

  async observe(
    sessionId: string,
    cwd: string,
    hookType: "prompt_submit" | "post_tool_use" | "post_tool_failure" | "stop",
    data: unknown,
  ): Promise<void> {
    await this.post("/agentmemory/observe", {
      hookType,
      sessionId,
      project: cwd,
      cwd,
      timestamp: new Date().toISOString(),
      data: redactUnknown(data),
    });
  }

  private async smartSearch(
    query: string,
    limit = 5,
    project?: string,
    sessionId?: string,
  ): Promise<SearchResponse> {
    return searchResponseSchema.parse(
      await this.post("/agentmemory/smart-search", {
        query: redactText(query).slice(0, 2_000),
        limit: Math.min(Math.max(limit, 1), 10),
        project,
        sessionId,
        source: "archon-harness",
      }),
    );
  }

  async search(query: string, limit = 5, project?: string, sessionId?: string): Promise<string> {
    const result = await this.smartSearch(query, limit, project, sessionId);
    return JSON.stringify(result).slice(0, 8_000);
  }

  async end(sessionId: string): Promise<void> {
    await this.post("/agentmemory/session/end", { sessionId });
  }

  async doctor(): Promise<CheckResult> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/agentmemory/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = await response.text();
      return { name: this.name, ok: response.ok, detail: body.slice(0, 500) };
    } catch (error) {
      return { name: this.name, ok: false, detail: String(error) };
    }
  }

  async smoke(cwd: string): Promise<CheckResult> {
    const sessionId = `archon-harness-smoke-${crypto.randomUUID()}`;
    try {
      await this.start(sessionId, cwd);
      await this.observe(sessionId, cwd, "post_tool_use", {
        tool_name: "archon-harness-smoke",
        tool_input: { marker: "basalt-orchid-731" },
        tool_output: "Archon harness memory smoke marker: basalt-orchid-731.",
      });
      const recalled = await this.smartSearch("basalt orchid 731", 5, cwd, sessionId);
      await this.end(sessionId);
      const output = JSON.stringify(recalled);
      return {
        name: this.name,
        ok:
          recalled.results.some((result) => result.sessionId === sessionId) &&
          Buffer.byteLength(output) <= 8_000,
        detail: `Save/recall round trip returned ${Buffer.byteLength(output)} bounded bytes.`,
        evidence: { recallBytes: Buffer.byteLength(output), limitBytes: 8_000 },
      };
    } catch (error) {
      return { name: this.name, ok: false, detail: String(error) };
    }
  }
}

export const agentMemoryAdapter = new AgentMemoryAdapter();
