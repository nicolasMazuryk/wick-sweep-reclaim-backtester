// Shared formatting of report numbers and Markdown tables (report.md, CLI
// summaries, grid §11). A non-finite number or a JSON `null` (Spec §7.1:
// NaN is written as null) prints as 'n/a', so a report rendered from live
// objects and one rendered from the parsed JSON are identical.

export function num(x: number | null | undefined, digits = 3): string {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : 'n/a';
}

export function pct(x: number | null | undefined, digits = 1): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${(100 * x).toFixed(digits)} %` : 'n/a';
}

export function ci(c: readonly [number | null, number | null] | null | undefined, digits = 3): string {
  return c === null || c === undefined ? '[n/a, n/a]' : `[${num(c[0], digits)}, ${num(c[1], digits)}]`;
}

// Finite number or null (for values read back from report JSON).
export function finite(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// GitHub-flavoured Markdown table; `|` in a cell is escaped.
export function mdTable(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map(() => '---|').join('')}`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

// Plain-text table with padded columns (CLI stdout).
export function textTable(rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((cells) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
}
