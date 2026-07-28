import { describe, expect, test } from "bun:test";
import { tokenSavings } from "../src/benchmark.ts";

describe("token measurements", () => {
  test("reports tokenizer-derived savings without negative claims", () => {
    expect(tokenSavings("alpha beta gamma delta", "alpha delta")).toMatchObject({
      baselineTokens: 4,
      optimizedTokens: 2,
      savedTokens: 2,
      savedPercent: 50,
    });
    expect(tokenSavings("short", "a deliberately longer replacement").savedTokens).toBe(0);
  });
});
