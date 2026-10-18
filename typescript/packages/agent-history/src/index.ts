/** The published package name, handy for smoke tests. */
export const name = "@habemus-papadum/agent-history";

export {
  Annotations,
  attachTags,
  defaultTagsPath,
  parseTagArguments,
  SUBJECT_KINDS,
  type SubjectKind,
  TAGS_DDL,
  TAGS_TABLE,
  type Tag,
  type TagsLayout,
  tagsDdl,
  tagsLayout,
  tagsOf,
} from "./annotations.ts";
export { CHECKS, type Check, type CheckResult, runChecks } from "./checks.ts";
export { cell, HistoryDb, isMotherDuck, num, type Row } from "./db.ts";
export {
  blobExcerpt,
  formatDuration,
  formatTokens,
  formatUsd,
  type ItemView,
  listSessions,
  loadBlobs,
  loadSession,
  type RenderOptions,
  renderSession,
  renderSessionList,
  resolveThread,
  type SessionSummary,
  type SessionView,
  type TurnView,
} from "./forensics.ts";
export {
  LITELLM_URL,
  type LiteLlmEntry,
  type ModelRates,
  type PriceSnapshot,
  priceSnapshot,
  pricesCte,
  priceUsage,
  pricingVersion,
  ratesFor,
  refreshSnapshot,
  resolveModel,
  trimTable,
  UNPRICED_MODELS,
  USD_EXPRESSION,
  type Usage,
} from "./pricing.ts";
export {
  QUESTIONS,
  type Question,
  type QuestionOptions,
  type QuestionResult,
  runQuestions,
} from "./questions.ts";
export { columns, ddl, type SchemaContract, schema } from "./schema.ts";
export { renderTable } from "./table.ts";
