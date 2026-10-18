import { existsSync } from "node:fs";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createInstance, type HistoryDb, isMotherDuck, type Row } from "./db.ts";

/**
 * Tags live in their own DuckDB file beside a local history file, so they survive a rebuild of
 * the facts. On MotherDuck they live in the history database itself, in schema `tagsdb`, so
 * every `tagsdb.tags` reference works in both layouts. Subjects are the stable ids of the
 * shared schema.
 */
export type TagsLayout = "file" | "schema";

/** Where tags live for a tags target: a sibling file, or the `tagsdb` schema of a MotherDuck database. */
export function tagsLayout(tagsPath: string): TagsLayout {
  return isMotherDuck(tagsPath) ? "schema" : "file";
}

/** Qualified name of the tags table in each layout. */
export const TAGS_TABLE: Record<TagsLayout, string> = { file: "tags", schema: "tagsdb.tags" };

/** `CREATE TABLE IF NOT EXISTS` for the tags table under the given qualified name. */
export function tagsDdl(table = TAGS_TABLE.file): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  subject_kind VARCHAR, subject_id VARCHAR, key VARCHAR, value VARCHAR, author VARCHAR, created_at TIMESTAMP)`;
}

export const TAGS_DDL = tagsDdl();

export type SubjectKind = "thread" | "turn" | "item" | "source";
export const SUBJECT_KINDS: SubjectKind[] = ["thread", "turn", "item", "source"];

export interface Tag {
  subjectKind: SubjectKind;
  subjectId: string;
  key: string;
  value: string | null;
  author: string | null;
  createdAt: Date | null;
}

/**
 * `codex.duckdb` keeps its tags in `codex.tags.duckdb` beside it unless told otherwise; a
 * MotherDuck database (`md:<database>`) keeps them inside itself.
 */
export function defaultTagsPath(historyPath: string): string {
  if (isMotherDuck(historyPath)) {
    return historyPath;
  }
  return `${historyPath.replace(/\.duckdb$/, "")}.tags.duckdb`;
}

export class Annotations {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    readonly path: string,
    /** Qualified table every statement targets: `tags` in a tags file, `tagsdb.tags` in a shared database. */
    readonly table: string,
  ) {}

  /**
   * Open a tags store read-write, creating the table when missing. The layout follows the
   * target (`md:` means schema mode) unless `options.layout` says otherwise, which lets a local
   * file stand in for a MotherDuck database in tests.
   */
  static async open(path: string, options: { layout?: TagsLayout } = {}): Promise<Annotations> {
    const layout = options.layout ?? tagsLayout(path);
    const table = TAGS_TABLE[layout];
    const instance = await createInstance(path);
    const connection = await instance.connect();
    if (layout === "schema") {
      await connection.run("CREATE SCHEMA IF NOT EXISTS tagsdb");
    }
    await connection.run(tagsDdl(table));
    return new Annotations(instance, connection, path, table);
  }

  async set(
    kind: SubjectKind,
    id: string,
    key: string,
    value: string | null,
    author: string | null,
  ): Promise<void> {
    await this.remove(kind, id, key);
    await this.connection.run(
      `INSERT INTO ${this.table} VALUES (?, ?, ?, ?, ?, now()::timestamp)`,
      [kind, id, key, value, author] as never,
    );
  }

  async remove(kind: SubjectKind, id: string, key: string): Promise<void> {
    await this.connection.run(
      `DELETE FROM ${this.table} WHERE subject_kind = ? AND subject_id = ? AND key = ?`,
      [kind, id, key] as never,
    );
  }

  async list(filter: { kind?: SubjectKind; id?: string; key?: string } = {}): Promise<Tag[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.kind) {
      where.push("subject_kind = ?");
      values.push(filter.kind);
    }
    if (filter.id) {
      where.push("subject_id = ?");
      values.push(filter.id);
    }
    if (filter.key) {
      where.push("key = ?");
      values.push(filter.key);
    }
    const sql = `SELECT subject_kind, subject_id, key, value, author, created_at FROM ${this.table}
                 ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, subject_id, key`;
    const reader = await this.connection.runAndReadAll(sql, values as never);
    return (reader.getRowObjectsJS() as Row[]).map((row) => ({
      subjectKind: String(row.subject_kind) as SubjectKind,
      subjectId: String(row.subject_id),
      key: String(row.key),
      value: (row.value as string | null) ?? null,
      author: (row.author as string | null) ?? null,
      createdAt: (row.created_at as Date | null) ?? null,
    }));
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}

/**
 * Make `tagsdb.tags` resolvable on a history connection, so SQL can join it, and return whether
 * it does. A tags file is attached read-only as catalog `tagsdb` when it exists. A MotherDuck
 * target attaches nothing: the tags are the `tagsdb` schema of the open database, and this
 * only reports whether that table exists. Nothing is created either way.
 */
export async function attachTags(db: HistoryDb, tagsPath: string): Promise<boolean> {
  if (tagsLayout(tagsPath) === "schema") {
    const count = await db.scalar<bigint>(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'tagsdb' AND table_name = 'tags'",
    );
    return Number(count) > 0;
  }
  if (!existsSync(tagsPath)) {
    return false;
  }
  await db.run(`ATTACH '${tagsPath.replace(/'/g, "''")}' AS tagsdb (READ_ONLY)`);
  return true;
}

/** Tags of one subject as `key=value` strings, for terminal output. */
export async function tagsOf(db: HistoryDb, kind: SubjectKind, id: string): Promise<string[]> {
  const rows = await db.query<{ key: string; value: string | null }>(
    "SELECT key, value FROM tagsdb.tags WHERE subject_kind = ? AND subject_id = ? ORDER BY key",
    [kind, id],
  );
  return rows.map((row) => (row.value === null ? row.key : `${row.key}=${row.value}`));
}

/** Parse `key=value` or bare `key` command-line arguments. */
export function parseTagArguments(args: string[]): { key: string; value: string | null }[] {
  return args.map((arg) => {
    const index = arg.indexOf("=");
    return index === -1
      ? { key: arg, value: null }
      : { key: arg.slice(0, index), value: arg.slice(index + 1) };
  });
}
