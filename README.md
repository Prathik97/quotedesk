# QuoteDesk

QuoteDesk turns five messy vendor replies (an Excel sheet, a PDF, a Word file, a phone photo and an email) into one normalized, evidence backed comparison, then lets a buyer question it in plain language all the way to an award and a decision pack. The model reads documents. Deterministic code does every calculation. Every extracted number carries its evidence (file, cell or line, and the quoted text), and a number that is missing is shown as Not quoted, never as zero.

The app has these pages: Comparison (grid, evidence drawer, review queue, questionnaire, attachments, source view), Analyst (chat that calls the same award engine), Decision (scenario, sensitivity, memo and appendix), RFx (co-pilot that drafts a new RFx), Outbox and Inbox (simulated email, nothing is sent), Try your file (read one file of your own, isolated from the comparison) and Evaluation.

Deployment settings and the Vercel checklist are in [DEPLOY.md](DEPLOY.md).

## Run it locally

Node 22 is required (`.nvmrc` says 22, `package.json` pins `22.x`). Python 3 is used only to generate the dataset.

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install -r seed/requirements.txt
cp .env.example .env.local   # fill in the values, never commit this file
npm run seed:gen             # generate the dataset into seed/out
npm run db:migrate           # apply supabase/migrations, create the read only role
npm run seed:db              # load the saved RFx and upload the files to Storage
npm run dev                  # app and /api on http://localhost:5173
```

### Environment variables (names only)

Server side only. None starts with `VITE_`, so none can reach the browser bundle.

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Model access (server only) |
| `MODEL_EXTRACT`, `MODEL_ANALYST`, `MODEL_FAST` | Model ids for extraction, the analyst and cheap calls |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Signed Storage reads for the source view |
| `SUPABASE_DB_URL`, `SUPABASE_DB_READONLY_URL` | Postgres connections, the second one for the read only analyst SQL role |
| `DAILY_SPEND_CAP_INR`, `PER_IP_HOURLY_CALLS` | Spend and rate caps for live model calls (`0` switches them off) |
| `DEFAULT_USD_INR`, `DEFAULT_GST_PCT` | Default assumptions for FX and GST |
| `DEMO_ADMIN_TOKEN`, `IP_HASH_SALT`, `SESSION_BUDGET_INR`, `QD_BUDGET_SESSION` | Optional, see DEPLOY.md |

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `preview` | Vite dev server with the API shim, production build (typecheck, bundle the API function, Vite build), preview |
| `npm run typecheck` / `npm test` | `tsc --noEmit` and the Vitest suite (no test can reach the real API) |
| `npm run seed:gen` / `db:migrate` / `seed:db` | Generate the dataset, apply migrations, load the seed |
| `npm run extract:all` | Run the extraction pipeline on the dataset (`--dry-run` estimates cost) |
| `npm run eval` | Score extraction against the answer key (see below) |
| `npm run recompute` | Recompute every stored line from raw fields with no model call. It prints how many cells moved and should print 0 |
| `npm run verify:decision`, `verify:seeded`, `verify:sandbox`, `verify:spend` | Independent checks of the decision pack, the seeded tables, the Try your file derivation and the spend guard |
| `npm run decision:memo` | Build a decision pack from the database with the template note, no model call |
| `npm run check:bundle`, `serve:prod`, `demo:reset` | Secret scan of the client bundle, serve the production build, restore the demo state |

To replay a saved model reply through the current derivation with no model call and no database: `npx tsx scripts/replay-sandbox.ts` (replies live in `eval/fixtures`).

## Architecture

A React and Vite single page app talks to one bundled serverless API function (`api/[[...path]].ts`, built by esbuild into `.build/handler.mjs`) that serves every `/api/<name>` route from `api/_lib/routes`. Postgres on Supabase holds the saved RFx, vendor documents, extractions, quote lines, review items and usage logs; documents sit in a private Storage bucket. Extraction (`api/_lib/extract`) classifies each document, asks the model for a strict JSON reading with evidence (vendor text is untrusted data in a delimited block, never instructions), validates it with zod and then hands it to the pure functions in `engine/`, which convert units and currency, assign Confirmed, Assumed, Needs review or Conflict, simulate awards and build the sensitivity tables. The same `deriveLines` function serves the stored pipeline, the recompute and Try your file, so a number cannot differ between them. Every model call passes one wrapper that applies the dev cache, the session budget guard, the daily spend cap and the per address hourly limit.

## Evaluation and the pre push check

```bash
npm run eval -- --dry-run     # cost estimate, no calls
npm run eval -- --score-only  # score what is stored, no calls
npm run eval -- --fresh       # full eval with live calls (costs real money, see eval/EVAL_REPORT.md)
npm run check:function        # run on Node 22 before every push
```

`check:function` builds, loads the built API function in plain Node, calls the main routes in no model mode (all caps forced to 0) and fails on any non 200 answer, naming the layer. Results and the evaluation's known limits are in [eval/EVAL_REPORT.md](eval/EVAL_REPORT.md) and [eval/KNOWN_LIMITATIONS.md](eval/KNOWN_LIMITATIONS.md).

## Known limitations

- The evaluation is not a held out test: prompts and rules were tuned on the 15 dataset documents. Three further files (a Metro Kraft spreadsheet, a Trident email and a pasted WhatsApp chat) were read once through Try your file and then used to fix engine rules, so they are no longer held out either. See `DECISIONS.md`.
- Model output varies between runs, so one run is one sample.
- Photo sourced prices are never Confirmed; a person must check the crop.
- Certificates are read for facts only; a forged certificate would not be detected.
- Prices that depend on a slab or dispatch condition are shown as Assumed with the alternate price. A board grade that differs from the RFx line goes to Needs review with the vendor's own surcharge text and no adjusted price. A price the vendor says includes GST is divided by the vendor's stated rate (the assumed rate only when none is stated), conflicting tax statements cap the line at Assumed, and a box whose size fits another RFx line of the same ply better is flagged, not re-mapped.
- The demo is a shared database: Reset demo clears everyone's drafts and Try your file results. No email is sent.
- The first real run of the streaming co-pilot and of large uploads on Vercel is the final test of the deployment; see DEPLOY.md.
- Everything deliberately not built is listed in `LEFT_OUT.md`.
