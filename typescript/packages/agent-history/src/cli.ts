import { userInfo } from "node:os";
import { Command } from "commander";
import {
  Annotations,
  attachTags,
  defaultTagsPath,
  parseTagArguments,
  SUBJECT_KINDS,
  type SubjectKind,
  tagsOf,
} from "./annotations.ts";
import { runChecks } from "./checks.ts";
import { HistoryDb } from "./db.ts";
import {
  listSessions,
  loadBlobs,
  loadSession,
  renderSession,
  renderSessionList,
  resolveThread,
} from "./forensics.ts";
import { priceSnapshot, pricingVersion, ratesFor, refreshSnapshot } from "./pricing.ts";
import { runQuestions } from "./questions.ts";
import { schema } from "./schema.ts";
import { renderTable } from "./table.ts";

const bigintSafe = (_key: string, value: unknown) =>
  typeof value === "bigint" ? Number(value) : value;

function subjectKind(value: string): SubjectKind {
  if ((SUBJECT_KINDS as string[]).includes(value)) {
    return value as SubjectKind;
  }
  throw new Error(`subject kind must be one of ${SUBJECT_KINDS.join(", ")}`);
}

const program = new Command()
  .name("agent-history")
  .description(
    "Checks, questions, forensics and tags over DuckDB files written by pdum-history, or the same tables on MotherDuck (md:<database>). History tables are only ever read; tags live in a sibling file, or in the tagsdb schema of a MotherDuck database.",
  );

program
  .command("check")
  .description("Print the invariants: numbers that should be zero, and numbers worth a glance.")
  .argument("<db>", "DuckDB file written by pdum-history, or md:<database>")
  .option("--json", "print JSON instead of a table")
  .action(async (path: string, options: { json?: boolean }) => {
    const db = await HistoryDb.open(path);
    try {
      const results = await runChecks(db);
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(
          renderTable(
            ["check", "kind", "value", "ok", "title"],
            results.map((r) => ({
              check: r.id,
              kind: r.kind,
              value: r.error ? `error: ${r.error}` : r.value,
              ok: r.ok ? "ok" : "FAIL",
              title: r.title,
            })),
            110,
          ),
        );
        console.log(
          `schema version ${schema.version}; ${results.filter((r) => !r.ok).length} failing`,
        );
      }
      process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
    } finally {
      db.close();
    }
  });

program
  .command("questions")
  .description("Run the analysis question set with cold and warm latency.")
  .argument("<db>", "DuckDB file written by pdum-history, or md:<database>")
  .option("--json", "print JSON instead of tables")
  .option("--show", "print the result rows of every question")
  .option("--term <text>", "full-text search term for Q5", "duckdb")
  .option("--tz <zone>", "time zone for the local-hour histogram", "UTC")
  .option("--only <ids>", "comma-separated question ids")
  .action(
    async (
      path: string,
      options: { json?: boolean; show?: boolean; term: string; tz: string; only?: string },
    ) => {
      const db = await HistoryDb.open(path);
      try {
        const wanted = options.only?.split(",").map((id) => id.trim());
        const results = await runQuestions(db, { term: options.term, timeZone: options.tz });
        const selected = wanted ? results.filter((r) => wanted.includes(r.id)) : results;
        if (options.json) {
          console.log(JSON.stringify(selected, bigintSafe, 2));
          return;
        }
        console.log(
          renderTable(
            ["id", "cold ms", "warm ms", "rows", "title"],
            selected.map((r) => ({
              id: r.id,
              "cold ms": r.coldMs === null ? "error" : Math.round(r.coldMs * 10) / 10,
              "warm ms": r.warmMs === null ? "" : Math.round(r.warmMs * 10) / 10,
              rows: r.rows,
              title: r.error ? `${r.title} — ${r.error}` : r.title,
            })),
            120,
          ),
        );
        console.log(`prices: ${pricingVersion}`);
        if (options.show) {
          for (const r of selected) {
            if (r.error || r.result.length === 0) {
              continue;
            }
            console.log(`\n${r.id} ${r.title}`);
            console.log(renderTable(r.columns, r.result));
          }
        }
      } finally {
        db.close();
      }
    },
  );

program
  .command("sessions")
  .description("List recent sessions with turns, responses, tokens and a list-price estimate.")
  .argument("<db>", "DuckDB file written by pdum-history, or md:<database>")
  .option("--limit <n>", "number of sessions", "20")
  .option("--children", "include sub-agent threads")
  .option("--like <text>", "filter by title, working directory, repository or id")
  .option("--tag <key[=value]>", "only threads carrying this tag")
  .option(
    "--lineage <thread>",
    "only the lineage of this thread (id or unique prefix), sub-agents included",
  )
  .option("--tags <path>", "tags file; defaults to <db>.tags.duckdb, or <db> itself for md:")
  .option("--json", "print JSON instead of a table")
  .action(
    async (
      path: string,
      options: {
        limit: string;
        children?: boolean;
        like?: string;
        tag?: string;
        lineage?: string;
        tags?: string;
        json?: boolean;
      },
    ) => {
      const db = await HistoryDb.open(path);
      try {
        let lineage: string | undefined;
        if (options.lineage) {
          const member = await resolveThread(db, options.lineage);
          const [row] = await db.query<{ lineage_id: string | null }>(
            "SELECT lineage_id FROM threads WHERE thread_id = ?",
            [member],
          );
          lineage = row?.lineage_id ?? member;
        }
        const attached = await attachTags(db, options.tags ?? defaultTagsPath(path));
        let tag: { key: string; value: string | null } | undefined;
        if (options.tag) {
          if (!attached) {
            throw new Error("no tags yet; use `agent-history tag` first");
          }
          tag = parseTagArguments([options.tag])[0];
        }
        const sessions = await listSessions(db, {
          limit: Number.parseInt(options.limit, 10) || 20,
          includeChildren: options.children || lineage !== undefined,
          like: options.like,
          tag,
          lineage,
        });
        console.log(
          options.json ? JSON.stringify(sessions, bigintSafe, 2) : renderSessionList(sessions),
        );
        if (!options.json) {
          console.log(`prices: ${pricingVersion}`);
        }
      } finally {
        db.close();
      }
    },
  );

program
  .command("show")
  .description("Print one session as turns and items; a unique id prefix is enough.")
  .argument("<db>", "DuckDB file written by pdum-history, or md:<database>")
  .argument("<thread>", "thread id or unique prefix")
  .option("--turn <n>", "only this turn number")
  .option("--blobs", "include excerpts of tool output and diffs")
  .option("--no-thinking", "hide reasoning items")
  .option("--width <n>", "characters of text per item line", "110")
  .option("--tags <path>", "tags file; defaults to <db>.tags.duckdb, or <db> itself for md:")
  .option("--json", "print the loaded session as JSON")
  .action(
    async (
      path: string,
      prefix: string,
      options: {
        turn?: string;
        blobs?: boolean;
        thinking: boolean;
        width: string;
        tags?: string;
        json?: boolean;
      },
    ) => {
      const db = await HistoryDb.open(path);
      try {
        const threadId = await resolveThread(db, prefix);
        const view = await loadSession(db, threadId);
        if (await attachTags(db, options.tags ?? defaultTagsPath(path))) {
          view.tags = await tagsOf(db, "thread", threadId);
        }
        if (options.json) {
          console.log(JSON.stringify(view, bigintSafe, 2));
          return;
        }
        const blobs = options.blobs ? await loadBlobs(db, threadId) : undefined;
        console.log(
          renderSession(view, {
            turn: options.turn ? Number.parseInt(options.turn, 10) : undefined,
            hideThinking: !options.thinking,
            maxText: Number.parseInt(options.width, 10) || 110,
            blobs,
          }),
        );
      } finally {
        db.close();
      }
    },
  );

program
  .command("tag")
  .description("Set tags on a thread, turn, item or source; `key=value` or a bare `key`.")
  .argument("<db>", "history file or md:<database> the tags belong to")
  .argument("<kind>", `one of ${SUBJECT_KINDS.join(", ")}`)
  .argument("<id>", "subject id, or a unique thread id prefix")
  .argument("<tags...>", "key=value pairs")
  .option("--tags <path>", "tags file; defaults to <db>.tags.duckdb, or <db> itself for md:")
  .option("--author <name>", "who set the tag", userInfo().username)
  .option("--remove", "remove these keys instead of setting them")
  .action(
    async (
      path: string,
      kindArg: string,
      id: string,
      tagArgs: string[],
      options: { tags?: string; author: string; remove?: boolean },
    ) => {
      const kind = subjectKind(kindArg);
      let subject = id;
      if (kind === "thread") {
        const db = await HistoryDb.open(path);
        try {
          subject = await resolveThread(db, id);
        } finally {
          db.close();
        }
      }
      const store = await Annotations.open(options.tags ?? defaultTagsPath(path));
      try {
        for (const { key, value } of parseTagArguments(tagArgs)) {
          if (options.remove) {
            await store.remove(kind, subject, key);
          } else {
            await store.set(kind, subject, key, value, options.author);
          }
        }
        const current = await store.list({ kind, id: subject });
        console.log(
          `${kind} ${subject}: ${current.map((t) => (t.value === null ? t.key : `${t.key}=${t.value}`)).join("  ") || "(no tags)"}`,
        );
      } finally {
        store.close();
      }
    },
  );

program
  .command("tags")
  .description("List tags, optionally filtered by kind, id or key.")
  .argument("<db>", "history file or md:<database> the tags belong to")
  .option("--kind <kind>", `one of ${SUBJECT_KINDS.join(", ")}`)
  .option("--id <id>", "subject id")
  .option("--key <key>", "tag key")
  .option("--tags <path>", "tags file; defaults to <db>.tags.duckdb, or <db> itself for md:")
  .option("--json", "print JSON instead of a table")
  .action(
    async (
      path: string,
      options: { kind?: string; id?: string; key?: string; tags?: string; json?: boolean },
    ) => {
      const store = await Annotations.open(options.tags ?? defaultTagsPath(path));
      try {
        const rows = await store.list({
          kind: options.kind ? subjectKind(options.kind) : undefined,
          id: options.id,
          key: options.key,
        });
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else if (rows.length === 0) {
          console.log("(no tags)");
        } else {
          console.log(
            renderTable(
              ["kind", "subject", "key", "value", "author", "created"],
              rows.map((t) => ({
                kind: t.subjectKind,
                subject: t.subjectId,
                key: t.key,
                value: t.value,
                author: t.author,
                created: t.createdAt,
              })),
            ),
          );
        }
      } finally {
        store.close();
      }
    },
  );

const prices = program
  .command("prices")
  .description("The LiteLLM price snapshot this package prices with.");

prices
  .command("show")
  .description("Print the per-million rates resolved for a model id.")
  .argument("<model>", "model id as a transcript records it")
  .action((model: string) => {
    const rates = ratesFor(model);
    if (!rates) {
      console.log(`${model}: no entry in ${pricingVersion}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ...rates, pricing: pricingVersion }, null, 2));
  });

prices
  .command("refresh")
  .description("Download the LiteLLM table and rewrite the trimmed snapshot shipped in src/.")
  .option(
    "--out <path>",
    "snapshot file to write",
    new URL("./litellm-snapshot.json", import.meta.url).pathname,
  )
  .action(async (options: { out: string }) => {
    const snapshot = await refreshSnapshot(options.out);
    console.log(
      `${Object.keys(snapshot.entries).length} entries fetched ${snapshot.fetched_at} into ${options.out} (was ${priceSnapshot.fetched_at})`,
    );
  });

program
  .command("sql")
  .description("Run one SQL statement against a history file and print the rows.")
  .argument("<db>", "DuckDB file written by pdum-history, or md:<database>")
  .argument("<sql>", "statement to run")
  .option("--tags <path>", "also attach this tags file as tagsdb")
  .option("--json", "print JSON instead of a table")
  .action(async (path: string, sql: string, options: { tags?: string; json?: boolean }) => {
    const db = await HistoryDb.open(path);
    try {
      await attachTags(db, options.tags ?? defaultTagsPath(path));
      const rows = await db.query(sql);
      if (options.json) {
        console.log(JSON.stringify(rows, bigintSafe, 2));
      } else if (rows.length === 0) {
        console.log("(no rows)");
      } else {
        console.log(renderTable(Object.keys(rows[0] ?? {}), rows));
      }
    } finally {
      db.close();
    }
  });

program
  .command("schema")
  .description("Print the schema contract this package was built against.")
  .action(() => {
    for (const [table, columns] of Object.entries(schema.tables)) {
      console.log(`${table}: ${columns.map(([name, type]) => `${name} ${type}`).join(", ")}`);
    }
    for (const view of Object.keys(schema.views)) {
      console.log(`view ${view}`);
    }
    console.log(`schema version ${schema.version}; prices ${pricingVersion}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
