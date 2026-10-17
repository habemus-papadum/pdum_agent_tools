import { existsSync } from "node:fs";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { HistoryDb, Row } from "./db.ts";

/**
 * Tags live in their own DuckDB file so they survive a rebuild of the history file and a
 * move of the facts to MotherDuck. Subjects are the stable ids of the shared schema.
 */
export const TAGS_DDL = `CREATE TABLE IF NOT EXISTS tags (
  subject_kind VARCHAR, subject_id VARCHAR, key VARCHAR, value VARCHAR, author VARCHAR, created_at TIMESTAMP)`;

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

/** `codex.duckdb` keeps its tags in `codex.tags.duckdb` beside it unless told otherwise. */
export function defaultTagsPath(historyPath: string): string {
  return `${historyPath.replace(/\.duckdb$/, "")}.tags.duckdb`;
}

export class Annotations {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    readonly path: string,
  ) {}

  static async open(path: string): Promise<Annotations> {
    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();
    await connection.run(TAGS_DDL);
    return new Annotations(instance, connection, path);
  }

  async set(
    kind: SubjectKind,
    id: string,
    key: string,
    value: string | null,
    author: string | null,
  ): Promise<void> {
    await this.connection.run(
      "DELETE FROM tags WHERE subject_kind = ? AND subject_id = ? AND key = ?",
      [kind, id, key] as never,
    );
    await this.connection.run("INSERT INTO tags VALUES (?, ?, ?, ?, ?, now()::timestamp)", [
      kind,
      id,
      key,
      value,
      author,
    ] as never);
  }

  async remove(kind: SubjectKind, id: string, key: string): Promise<void> {
    await this.connection.run(
      "DELETE FROM tags WHERE subject_kind = ? AND subject_id = ? AND key = ?",
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
    const sql = `SELECT subject_kind, subject_id, key, value, author, created_at FROM tags
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
 * Attach the tags file to a read-only history connection as `tagsdb` when it exists, so SQL
 * can join `tagsdb.tags`. Returns whether anything was attached.
 */
export async function attachTags(db: HistoryDb, tagsPath: string): Promise<boolean> {
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
