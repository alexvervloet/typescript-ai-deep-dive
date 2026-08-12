/**
 * tsai/fmt.ts: readable terminal output, from scratch.
 *
 * The Python dives in this series use `rich`, which prints tables, panels and
 * colored text out of the box. Node has no equivalent in its standard library
 * and no single obvious package: you would reach for `chalk` plus `cli-table3`,
 * or `ink` if you wanted a whole React renderer in your terminal.
 *
 * For a repo whose house style is "no frameworks," the honest move is to write
 * the sixty lines. That is genuinely all it takes for colors and a fixed-width
 * table, and it keeps the dependency list down to the SDKs, Zod and a tokenizer.
 *
 * One real difference from Python worth noticing: `str.ljust(10)` is standard
 * library there; `String.prototype.padEnd(10)` is standard library here. The
 * formatting gap between the two languages is much smaller than the ecosystem
 * gap. What Python gives you that Node does not is the *presentation* layer, not
 * the primitives.
 */

const USE_COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];

function paint(text: string, code: string): string {
  return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const bold = (s: string) => paint(s, "1");
export const dim = (s: string) => paint(s, "2");
export const red = (s: string) => paint(s, "31");
export const green = (s: string) => paint(s, "32");
export const yellow = (s: string) => paint(s, "33");
export const blue = (s: string) => paint(s, "34");
export const cyan = (s: string) => paint(s, "36");

export const ok = (s: string) => `  ${green("+")} ${s}`;
export const warn = (s: string) => `  ${yellow("!")} ${s}`;
export const fail = (s: string) => `  ${red("x")} ${s}`;

/** A section heading with a rule under it. */
export function heading(text: string): string {
  return `\n${bold(text)}\n${dim("-".repeat(text.length))}`;
}

/** A horizontal rule. */
export function rule(width = 68): string {
  return dim("-".repeat(width));
}

export type Column = { header: string; align?: "left" | "right" };

/**
 * A fixed-width table. Rows are plain strings, already formatted.
 *
 * Deliberately simple: no wrapping, no colors inside cells (the width math
 * would have to strip escape codes, which is the first thing every terminal
 * table library ends up doing).
 */
export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (text: string, i: number) => {
    const width = widths[i] ?? 0;
    return columns[i]?.align === "right" ? text.padStart(width) : text.padEnd(width);
  };
  const line = (cells: string[]) => cells.map((c, i) => pad(c, i)).join("  ").trimEnd();

  return [
    bold(line(columns.map((c) => c.header))),
    dim(widths.map((w) => "-".repeat(w)).join("  ")),
    ...rows.map((r) => line(r)),
  ].join("\n");
}

/** Milliseconds, rounded the way a human reads them. */
export function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

/** Python's `f"{x:,}"`. JavaScript spells it with a locale. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}
