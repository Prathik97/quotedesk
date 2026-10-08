// The label "Stored results from a live run on <date>, <n> live calls" describes ONLY the extraction calls behind the
// stored comparison: model calls whose document is one of the five vendors' documents. A Try your file read, a
// capture script or a test run logs an extract call too, but its document id is not in `documents`, so it is never
// counted, and a recompute makes no model call at all. Every route that prints the label uses this one definition.
const WHERE = `not u.cache_hit and u.stage = 'extract' and u.route not like '%sandbox%' and exists (select 1 from documents d where d.id = u.document_id)`;

/** A scalar subquery giving {mx, n}, for embedding in a larger select. */
export const STORED_RUN_USAGE_SQL = `(select jsonb_build_object('mx', max(u.created_at), 'n', count(*)) from usage_log u where ${WHERE})`;

/** A whole query giving one row with mx and n. */
export const STORED_RUN_ROW_SQL = `select max(u.created_at) as mx, count(*) as n from usage_log u where ${WHERE}`;
