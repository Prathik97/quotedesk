-- Whether a questionnaire answer was stated by the vendor or inferred by the reader.
-- Inferred answers never decide a knockout on their own.
alter table questionnaire_answers add column basis text not null default 'explicit' check (basis in ('explicit', 'inferred'));
