import { describe, expect, test } from "bun:test";
import { liveOnlyMeasurements, tokenSavings } from "../src/benchmark.ts";

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

  test("reports the installed OMP thinking level instead of a historical default", () => {
    const thinking = liveOnlyMeasurements("high").find(
      (measurement) => measurement.component === "omp-thinking",
    );

    expect(thinking?.evidence.configuredLevel).toBe("high");
  });
});
