import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

/** A row with DuckDB values converted to plain JavaScript (bigint for BIGINT, Date for timestamps). */
export type Row = Record<string, unknown>;

/**
 * One open DuckDB file. `query` runs SQL and returns plain rows; `close` releases the
 * instance. Open read-only by default: the analysis side never writes a history file.
 */
export class HistoryDb {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    readonly path: string,
  ) {}

  static async open(path: string, options: { readOnly?: boolean } = {}): Promise<HistoryDb> {
    const readOnly = options.readOnly ?? true;
    const instance = await DuckDBInstance.create(
      path,
      readOnly ? { access_mode: "READ_ONLY" } : {},
    );
    const connection = await instance.connect();
    return new HistoryDb(instance, connection, path);
  }

  /** In-memory database, used by tests to validate SQL against the schema contract. */
  static async memory(): Promise<HistoryDb> {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    return new HistoryDb(instance, connection, ":memory:");
  }

  async run(sql: string, values?: unknown[]): Promise<void> {
    await this.connection.run(sql, values as never);
  }

  async query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, values as never);
    return reader.getRowObjectsJS() as T[];
  }

  async scalar<T = unknown>(sql: string, values?: unknown[]): Promise<T> {
    const rows = await this.query(sql, values);
    const first = rows[0];
    if (!first) {
      throw new Error(`no rows for: ${sql}`);
    }
    return Object.values(first)[0] as T;
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}

/** Render a converted value for the terminal: bigint and Date become readable text. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Coerce a DuckDB numeric (bigint, number or decimal object) to a JavaScript number. */
export function num(value: unknown): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && "toString" in value) {
    const parsed = Number.parseFloat(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
