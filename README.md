# QuoteDesk

Turns five messy vendor replies (Excel, PDF, Word, a phone photo, an email) into one normalized, evidence backed comparison, then lets a buyer interrogate it in plain language all the way to an award. The model reads documents; deterministic code does every calculation.

Status: phases 1 to 4 of 8 (dataset, extraction and evaluation, normalization engine, comparison workspace with evidence and review). See `REQUIREMENTS.md`, `DECISIONS.md`, `LEFT_OUT.md`.

## Setup
Node 22, Python 3.

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install -r seed/requirements.txt
cp .env.example .env.local   # fill in values
npm run seed:gen             # generate the dataset into seed/out
npm run db:migrate           # apply migrations, create the read only role
npm run seed:db              # load the saved RFx and upload files to Storage
npm run dev                  # app and /api on http://localhost:5173
```

Checks: `npm run typecheck`, `npm test` (no test calls the real API).

## Extraction and evaluation
```bash
npm run api:ping                       # one tiny call to verify the API key
npm run extract:all -- --dry-run       # cost estimate, no API calls
npm run extract:all -- --only V4       # one vendor or file name fragment; uses the dev cache
npm run eval -- --dry-run              # cost estimate for a full eval
npm run eval -- --fresh                # full eval with real calls; writes eval/EVAL_REPORT.md
npm run eval -- --score-only           # score what is stored, no calls
```
Every model call passes a hard session budget guard (Rs 300) and the dev cache. Cache hits are labelled and cost nothing. See `eval/EVAL_REPORT.md` for the latest results and known limitations.

## Comparison workspace (phases 3 and 4)
```bash
npm run dev          # grid, evidence drawer, review queue at http://localhost:5173
npm run recompute    # deterministic recompute of every stored line, no model calls (prints 0 changed when stored results match the engine)
```
Everything in the app reads stored results from the database. Screenshots are in `docs/screenshots`.
