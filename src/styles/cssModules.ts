/** Joins locally-scoped CSS Module class names without leaking falsy values. */
export type CssClassValue = string | false | null | undefined;

export function cx(...classes: CssClassValue[]): string {
  return classes.filter((value): value is string => Boolean(value)).join(" ");
}

/** Resolves a CSS Module key while retaining a stable fallback for diagnostics. */
export function cssClass(module: Readonly<Record<string, string>>, key: string): string {
  return module[key] ?? key;
}
