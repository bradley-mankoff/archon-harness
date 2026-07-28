const SECRET_KEY = /(api[-_]?key|token|secret|password|cookie|authorization|credential)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+\S+)/gi;

export function redactText(value: string): string {
  return value.replace(SECRET_VALUE, "[redacted]");
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (SECRET_KEY.test(key)) return [key, "[redacted]"];
      return [key, redactUnknown(item)];
    }),
  );
}
