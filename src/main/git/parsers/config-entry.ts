export function parseConfigEntry(entry: string, implicitValue: string): [string, string] {
  const newline = entry.indexOf("\n");
  return newline < 0 ? [entry, implicitValue] : [entry.slice(0, newline), entry.slice(newline + 1)];
}
