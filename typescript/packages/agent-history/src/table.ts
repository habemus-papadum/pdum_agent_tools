import { cell } from "./db.ts";

/** Render rows as a plain monospace table; numbers are right-aligned. */
export function renderTable(
  columns: string[],
  rows: Record<string, unknown>[],
  maxWidth = 60,
): string {
  const text = rows.map((row) => columns.map((column) => truncate(cell(row[column]), maxWidth)));
  const numeric = columns.map((column) =>
    rows.every(
      (row) => row[column] === null || row[column] === undefined || isNumeric(row[column]),
    ),
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...text.map((row) => row[index]?.length ?? 0)),
  );
  const line = (values: string[]) =>
    values
      .map((value, index) =>
        numeric[index] ? value.padStart(widths[index]) : value.padEnd(widths[index]),
      )
      .join("  ");
  const lines = [line(columns), widths.map((width) => "-".repeat(width)).join("  ")];
  for (const row of text) {
    lines.push(line(row));
  }
  return lines.join("\n");
}

function isNumeric(value: unknown): boolean {
  return typeof value === "number" || typeof value === "bigint";
}

function truncate(value: string, maxWidth: number): string {
  return value.length > maxWidth ? `${value.slice(0, maxWidth - 1)}…` : value;
}
