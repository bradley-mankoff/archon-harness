import { describe, expect, test } from "bun:test";
import { createSlackMessageHandler, splitSlackMessage } from "../src/slack.ts";

const config = {
  appToken: "xapp-test",
  botToken: "xoxb-test",
  allowedUserId: "U123",
  allowedChannelId: "D123",
  cwd: "/tmp/project",
};

describe("Slack bridge", () => {
  test("ignores every user and channel outside the allowlist", async () => {
    let calls = 0;
    const handler = createSlackMessageHandler(config, async () => {
      calls += 1;
      throw new Error("must not run");
    });

    expect(await handler({ user: "U999", channel: "D123", text: "hello", ts: "1" })).toEqual({
      ignored: true,
    });
    expect(await handler({ user: "U123", channel: "D999", text: "hello", ts: "2" })).toEqual({
      ignored: true,
    });
    expect(calls).toBe(0);
  });

  test("routes an allowed message through Archon and keeps the thread", async () => {
    const prompts: string[] = [];
    const handler = createSlackMessageHandler(config, async (prompt, cwd) => {
      prompts.push(`${cwd}:${prompt}`);
      return {
        exitCode: 0,
        response: "final answer",
        logs: { stdout: "stdout.log", stderr: "stderr.log", omp: "omp.log" },
      };
    });

    expect(
      await handler({
        user: "U123",
        channel: "D123",
        text: "<@UAPP> inspect this",
        ts: "100",
        threadTs: "99",
      }),
    ).toEqual({ ignored: false, messages: ["final answer"], threadTs: "99" });
    expect(prompts).toEqual(["/tmp/project:inspect this"]);
  });

  test("splits responses below Slack's message limit", () => {
    expect(splitSlackMessage("a".repeat(90), 40).map((part) => part.length)).toEqual([40, 40, 10]);
  });
});
