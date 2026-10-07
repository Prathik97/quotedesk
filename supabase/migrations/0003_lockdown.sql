-- The browser never talks to Supabase. Lock the Data API out of every table and
-- view: RLS on with no policies, and no grants for anon or authenticated.
-- The server uses the postgres role through the pooler, which bypasses RLS.

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
