export function diffSearchPattern(query: string, global = false) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), global ? "giu" : "iu");
}

export function diffSearchMatches(text: string, query: string) {
  if (!query) return [];
  const pattern = diffSearchPattern(query, true);
  return Array.from(text.matchAll(pattern), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}
