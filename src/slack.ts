import { appendFile, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { App, LogLevel } from "@slack/bolt";
import { z } from "zod";
import { dataRoot } from "./paths.ts";
import { redactText } from "./redaction.ts";
import { runArchonCaptured, type ArchonExecutionResult } from "./runtime.ts";

const slackEnvironmentSchema = z.object({
  SLACK_APP_TOKEN: z.string().regex(/^xapp-/),
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-/),
  ARCHON_SLACK_USER_ID: z.string().regex(/^[UW][A-Z0-9]+$/),
  ARCHON_SLACK_CHANNEL_ID: z.string().regex(/^[CDG][A-Z0-9]+$/),
  ARCHON_SLACK_CWD: z.string().refine(isAbsolute, "ARCHON_SLACK_CWD must be absolute"),
});

export interface SlackBridgeConfig {
  appToken: string;
  botToken: string;
  allowedUserId: string;
  allowedChannelId: string;
  cwd: string;
}

export interface SlackMessage {
  user?: string;
  channel: string;
  text?: string;
  ts: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}

export interface SlackMessageResult {
  ignored: boolean;
  messages?: string[];
  threadTs?: string;
}

export async function readSlackConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SlackBridgeConfig> {
  const parsed = slackEnvironmentSchema.parse(environment);
  return {
    appToken: parsed.SLACK_APP_TOKEN,
    botToken: parsed.SLACK_BOT_TOKEN,
    allowedUserId: parsed.ARCHON_SLACK_USER_ID,
    allowedChannelId: parsed.ARCHON_SLACK_CHANNEL_ID,
    cwd: await realpath(parsed.ARCHON_SLACK_CWD),
  };
}

function stripLeadingMention(value: string): string {
  return value.replace(/^\s*<@[A-Z0-9]+>\s*/, "").trim();
}

export function splitSlackMessage(value: string, limit = 39_000): string[] {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const splitAt = newline > limit * 0.5 ? newline : limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function createSlackMessageHandler(
  config: SlackBridgeConfig,
  run: (message: string, cwd: string) => Promise<ArchonExecutionResult> = runArchonCaptured,
) {
  let queue: Promise<unknown> = Promise.resolve();
  return async (message: SlackMessage): Promise<SlackMessageResult> => {
    const prompt = stripLeadingMention(message.text ?? "");
    if (
      message.botId ||
      message.subtype ||
      !prompt ||
      message.user !== config.allowedUserId ||
      message.channel !== config.allowedChannelId
    ) {
      return { ignored: true };
    }
    const task = queue.then(() => run(prompt, config.cwd));
    queue = task.catch(() => undefined);
    const result = await task;
    if (result.exitCode !== 0 || !result.response) {
      return {
        ignored: false,
        messages: [`Archon failed (exit ${result.exitCode}). Log: ${result.logs.stderr}`],
        threadTs: message.threadTs ?? message.ts,
      };
    }
    return {
      ignored: false,
      messages: splitSlackMessage(result.response),
      threadTs: message.threadTs ?? message.ts,
    };
  };
}

export function publicSlackConfig(config: SlackBridgeConfig) {
  return {
    userId: config.allowedUserId,
    channelId: config.allowedChannelId,
    cwd: config.cwd,
    socketMode: true,
  };
}

export async function runSlackBridge(config: SlackBridgeConfig): Promise<void> {
  const logPath = join(dataRoot(), "logs", "slack-bridge.log");
  await mkdir(dirname(logPath), { recursive: true });
  const logError = async (error: unknown) => {
    await appendFile(logPath, `${new Date().toISOString()} ${redactText(String(error))}\n`, "utf8");
  };
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });
  const handle = createSlackMessageHandler(config);
  app.event("message", async ({ event, say }) => {
    const candidate = event as unknown as Record<string, unknown>;
    const result = await handle({
      user: typeof candidate.user === "string" ? candidate.user : undefined,
      channel: String(candidate.channel ?? ""),
      text: typeof candidate.text === "string" ? candidate.text : undefined,
      ts: String(candidate.ts ?? ""),
      threadTs: typeof candidate.thread_ts === "string" ? candidate.thread_ts : undefined,
      subtype: typeof candidate.subtype === "string" ? candidate.subtype : undefined,
      botId: typeof candidate.bot_id === "string" ? candidate.bot_id : undefined,
    });
    for (const text of result.messages ?? []) {
      await say({ text, thread_ts: result.threadTs });
    }
  });
  app.error(async (error) => {
    await logError(error);
  });
  await app.start();
  process.stdout.write(`Slack bridge connected for ${config.allowedChannelId}.\n`);
}
