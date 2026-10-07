// Allowlist check for the analyst SQL tool. This is the first of three layers; the other two
// are the read only database role (SELECT on a few views, nothing else) and a read only
// transaction with a 5 second timeout. The check exists for early, friendly errors and as
// defence in depth, not as the only barrier.

export const ALLOWED_RELATIONS = [
  'comparison_view',
  'vendor_summary_view',
  'award_input_view',
  'rfx_lines_view',
  'vendor_terms_view',
  'open_issues_view',
  'assumptions_view',
] as const;

export const ROW_LIMIT = 200;

export class SqlRejected extends Error {}

const FORBIDDEN_WORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'grant', 'revoke', 'truncate', 'copy', 'call', 'do', 'execute', 'prepare',
  'set', 'reset', 'show', 'listen', 'notify', 'vacuum', 'analyze', 'lock', 'merge', 'comment', 'refresh', 'into', 'begin', 'commit', 'rollback',
];
const FORBIDDEN_PATTERNS: [RegExp, string][] = [
  [/\bpg_[a-z_]*/i, 'pg_ functions and catalogs'],
  [/\b(set_config|current_setting|dblink[a-z_]*|lo_[a-z_]+|txid_[a-z_]+|version|current_user|session_user|current_database|current_schema|inet_[a-z_]+)\s*\(/i, 'system functions'],
  [/\binformation_schema\b/i, 'information_schema'],
  [/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i, 'row locking'],
];

/** Blank out string literals and quoted identifiers so keywords inside them do not trip the check. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

export function validateSelect(input: string): string {
  let sql = input.trim();
  if (sql.length === 0) throw new SqlRejected('The query is empty.');
  if (sql.length > 4000) throw new SqlRejected('The query is too long. Keep it under 4000 characters.');
  if (/--|\/\*|\*\//.test(sql)) throw new SqlRejected('Comments are not allowed in queries.');
  if (/\$[a-z_0-9]*\$/i.test(sql)) throw new SqlRejected('Dollar quoting is not allowed.');
  sql = sql.replace(/;\s*$/, '');
  const plain = stripLiterals(sql);
  if (plain.includes(';')) throw new SqlRejected('Only one statement is allowed.');
  if (!/^\s*(select|with)\b/i.test(plain)) throw new SqlRejected('Only SELECT queries are allowed.');
  const words = plain.toLowerCase().match(/[a-z_][a-z_0-9]*/g) ?? [];
  for (const w of words) {
    if (FORBIDDEN_WORDS.includes(w)) throw new SqlRejected(`"${w}" is not allowed. Queries are read only.`);
  }
  for (const [re, what] of FORBIDDEN_PATTERNS) {
    if (re.test(plain)) throw new SqlRejected(`${what} are not allowed.`);
  }
  // Every relation named after FROM or JOIN must be an allowed view or a CTE defined in the query.
  const ctes = new Set([...plain.matchAll(/\b([a-z_][a-z_0-9]*)\s+as\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase()));
  for (const m of plain.matchAll(/\b(?:from|join)\s+([a-z_][a-z_0-9.]*)/gi)) {
    const rel = (m[1] ?? '').toLowerCase().replace(/^public\./, '');
    if (rel === 'lateral' || rel === 'unnest' || rel === 'generate_series' || rel === 'jsonb_array_elements' || rel === 'jsonb_each' || rel === 'jsonb_array_elements_text') continue;
    if (ctes.has(rel)) continue;
    if (!(ALLOWED_RELATIONS as readonly string[]).includes(rel)) {
      throw new SqlRejected(`"${m[1]}" is not available. You can query: ${ALLOWED_RELATIONS.join(', ')}.`);
    }
  }
  return sql;
}

/** The statement actually run: the validated query as a subselect with a hard row limit (one extra row detects truncation). */
export function limited(sql: string): string {
  return `select * from (${sql}) as analyst_q limit ${ROW_LIMIT + 1}`;
}
