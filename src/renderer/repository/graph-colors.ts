// The theme tokens follow the OKLCH hue circle in eight equal steps.
const colors = Array.from({ length: 8 }, (_, index) => `var(--graph-lane-${index})`);

export const DEFAULT_BRANCH_COLOR = -1;

export const graphColor = (index: number) =>
  index === DEFAULT_BRANCH_COLOR ? "var(--accent)" : colors[index]!;

export function allocateGraphColor(
  lanes: readonly (number | undefined)[],
  lane: number,
  recent: number[],
): number {
  const counts = colors.map(() => 0);
  let left: number | undefined;
  let right: number | undefined;
  for (const [index, color] of lanes.entries()) {
    if (color === undefined || color === DEFAULT_BRANCH_COLOR) continue;
    counts[color] = counts[color]! + 1;
    if (index < lane) left = color;
    if (index > lane) right ??= color;
  }

  const minimum = Math.min(...counts);
  const candidates = counts.map((_, index) => index).filter((index) => counts[index] === minimum);
  const neighbors = [left, right].filter((color) => color !== undefined);
  if (!neighbors.length && recent.length) neighbors.push(recent[recent.length - 1]!);

  const separation = (index: number) =>
    Math.min(
      ...neighbors.map((neighbor) => {
        const steps = Math.abs(index - neighbor);
        return Math.min(steps, colors.length - steps);
      }),
    );

  const distinct = candidates.filter((color) => !neighbors.includes(color));
  const available = distinct.length ? distinct : candidates;
  const fresh = available.filter((color) => !recent.includes(color));
  const choices = fresh.length
    ? fresh
    : available.sort((a, b) => recent.indexOf(a) - recent.indexOf(b));
  const best = choices.reduce((previous, color) =>
    separation(color) > separation(previous) ? color : previous,
  );

  const previous = recent.indexOf(best);
  if (previous >= 0) recent.splice(previous, 1);
  recent.push(best);
  if (recent.length >= colors.length) recent.shift();
  return best;
}
