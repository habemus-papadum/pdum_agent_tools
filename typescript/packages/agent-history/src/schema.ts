import contract from "../schema/agent-history.schema.json" with { type: "json" };

/** The schema contract exported by the Python package (`pdum-history schema --json`). */
export interface SchemaContract {
  version: number;
  tables: Record<string, [string, string][]>;
  views: Record<string, string>;
}

export const schema: SchemaContract = contract as unknown as SchemaContract;

/** CREATE statements that reproduce the contract, for tests and for empty analysis databases. */
export function ddl(): string[] {
  const statements: string[] = [];
  for (const [table, columns] of Object.entries(schema.tables)) {
    const rendered = columns.map(([name, type]) => `${name} ${type}`).join(", ");
    statements.push(`CREATE TABLE IF NOT EXISTS ${table} (${rendered})`);
  }
  for (const [view, body] of Object.entries(schema.views)) {
    statements.push(`CREATE OR REPLACE VIEW ${view} AS ${body}`);
  }
  return statements;
}

/** Column names of one table in contract order. */
export function columns(table: string): string[] {
  const found = schema.tables[table];
  if (!found) {
    throw new Error(`unknown table ${table}`);
  }
  return found.map(([name]) => name);
}
