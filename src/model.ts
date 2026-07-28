import { z } from "zod";

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

export const modelSelectionSchema = z.object({
  model: z.string().min(3),
  thinking: thinkingLevelSchema.optional(),
});

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export function parseModelSelection(value: string): ModelSelection {
  if (value !== value.trim() || /\s/.test(value)) {
    throw new Error("Model must not contain leading, trailing, or embedded whitespace");
  }
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("Model must use provider/model[:thinking] syntax");
  }

  const provider = value.slice(0, separator);
  let model = value.slice(separator + 1);
  let thinking: ModelSelection["thinking"];
  const effortSeparator = model.lastIndexOf(":");
  if (effortSeparator >= 0) {
    const parsedThinking = thinkingLevelSchema.safeParse(model.slice(effortSeparator + 1));
    if (parsedThinking.success) {
      thinking = parsedThinking.data;
      model = model.slice(0, effortSeparator);
    }
  }
  if (!model || provider.includes(":") || model.endsWith(":")) {
    throw new Error("Model must use provider/model[:thinking] without an empty model segment");
  }
  return { model: `${provider}/${model}`, ...(thinking ? { thinking } : {}) };
}

export function applyThinkingOverride(selection: ModelSelection, value?: string): ModelSelection {
  if (!value) return selection;
  const thinking = thinkingLevelSchema.parse(value);
  if (selection.thinking && selection.thinking !== thinking) {
    throw new Error(
      `Conflicting thinking levels: model suffix is ${selection.thinking}, --thinking is ${thinking}`,
    );
  }
  return { ...selection, thinking };
}
