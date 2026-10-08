-- Try your file: results of one visitor file read by the real pipeline against the saved FY27 RFx lines.
-- ISOLATED: nothing here is read by the comparison, the analyst or any view. The row holds the shown result
-- only (no file bytes), expires after two hours, and Reset demo deletes every row.
create table sandbox_results (
  id uuid primary key,
  browser_id text not null,
  filename text not null,
  size_bytes int not null,
  result jsonb not null,
  cost_inr numeric not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);
create index sandbox_results_browser on sandbox_results (browser_id, created_at desc);
create index sandbox_results_expiry on sandbox_results (expires_at);
alter table sandbox_results enable row level security;
revoke all on sandbox_results from anon, authenticated;
