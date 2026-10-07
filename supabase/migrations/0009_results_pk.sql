-- Result ids are short and per session (r1, r2, ...), so the key is the pair.
alter table analyst_results drop constraint analyst_results_pkey;
alter table analyst_results add primary key (session_id, id);
