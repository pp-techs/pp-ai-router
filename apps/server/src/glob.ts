/** Matches `*` wildcards only (any run of characters, including `/`). Everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}
