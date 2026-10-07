# Decisions

Short, dated entries. Each one: the decision, the alternatives, and why.

## 2026-10-07 Phase 0 and 1

**D1. Dataset FX is USD 1 = INR 96, not 88.**
The requirements say 88. The owner set `DEFAULT_USD_INR=96` and asked the truth to match, so that a fresh install shows assumed USD conversions that agree with the answer key. The value is still only an assumption: the vendor (V5) never states a rate, so those lines are Assumed and the rate is editable.

**D2. Photo sourced prices (V4) are capped at Assumed, never Confirmed.**
Alternatives: trust the model's read confidence, or run a second read and compare. Reading small digits on an angled, blurred JPEG is the most likely way to get a confident wrong value, and the per box meaning comes from a footnote, not a column. A buyer should eyeball the crop before acting on these numbers. The cost is a less green grid for the cheapest vendor. That is the honest picture, and the evidence drawer makes checking one click.

**D3. Model extracts, code calculates.**
The model reads and structures. All unit conversion, FX, GST, totals, savings and award math runs in `/engine` (pure TypeScript with unit tests). A model can get a multiplication wrong; a tested function cannot, and the factors it used can be shown.

**D4. Local `/api` runs through a Vite middleware shim, not `vercel dev`.**
The owner does not want the Vercel CLI or project linking. `dev/api-shim.ts` loads the same handler files Vercel deploys and adapts Node's req and res to the subset of the Vercel API we use (`status`, `json`, `send`, `query`, `body`). Handlers import with `.js` suffixes and relative paths, so they run unchanged on Vercel.

**D5. Migrations are applied by a small Node `pg` script, not the Supabase CLI.**
`npm run db:migrate` applies `supabase/migrations/*.sql` in order and records them in `schema_migrations`. It is simple and has no global tools.

**D6. Read only role for the analyst SQL tool: `quotedesk_ro`.**
Created by migration 0004 with a random password generated at migrate time and written only to `.env.local`. The role has `default_transaction_read_only`, a 5 second statement timeout, and SELECT on the three views only. Base tables are not granted, and views run with their owner's rights. The migrate script verified through the session pooler that the role can read the views, is denied on base tables, and is denied writes. No fallback was needed. Rotate it with `npm run db:migrate -- --rotate-ro`.

**D7. The Supabase Data API is locked out.**
The browser never talks to Supabase, but Supabase exposes `public` tables to the anon key by default. Migration 0003 enables RLS with no policies on every table and revokes anon and authenticated grants. The server connects as the postgres role through the pooler.

**D8. node-postgres TLS: `sslmode` is stripped from the URL and TLS is set in code.**
node-postgres treats `sslmode=require` as full verification against a CA bundle we do not ship. `api/_lib/pgconfig.ts` keeps TLS on without CA pinning. Revisit if we ship the Supabase CA.

**D9. Uploads (phase 6 and later) will go to Supabase Storage signed URLs, not through a function.**
Vercel caps request bodies at about 4.5 MB and the spec allows 10 MB files.

**D10. The Storage bucket `documents` is private.** Seed files live under `seed/`. `truth.json` is never uploaded: it is the hidden answer key and stays in the repo for the eval harness only.

**D11. Vendor messages and documents are not inserted by `seed:db`.**
Only the RFx, lines, questions, vendors and global assumptions are. Replies enter through the "Simulate vendor replies" control, so the inbox timeline is real UI, not preloaded rows. `seed/out/messages.json` holds subjects, bodies, arrival days and attachment hashes for that control.

**D12. The dataset is byte for byte reproducible.**
Seed 2027. Excel and Word zips are normalized (fixed entry timestamps and core dates), PDFs use reportlab's invariant mode, and the eml has a fixed MIME boundary. Two consecutive runs produce identical files. LY annual spend: Rs 4,01,29,300 (4.01 crore).

**D13. Dataset realism choices.**
- Vendors write "Rs." rather than the rupee sign, as most Indian letterheads and printed rate cards still do. It also avoids missing glyphs in PDF core fonts.
- V1 uses its own item codes and a two level merged header, with columns in a different order from the RFx. Matching must work on descriptions, not codes.
- V1 hidden sheet "Old Rates FY25" holds stale, lower prices. Reading it as current would look like a saving, which makes it a good trap.
- V2's stated grand total is 1.80% above the true sum of its own lines, while every row amount is correct, as if a total formula went wrong.
- V3's GST certificate carries trade name "Deccan Board Mills" but legal name "Deccan Paperboard Industries Private Limited". This is a realistic mismatch: the trade name matches, the legal entity does not.
- V3 prose uses "each" only for countable units, so the dataset does not plant an unintended ambiguous unit.
- V4 email body carries the questionnaire answers. The ISO certificate shows expiry 31 Mar 2026; reply received 13 Apr 2026.
- V5 Q2 ("testing outsourced to an NABL lab") is recorded as partial, not as a fail. In house is not established either way, so the knockout is Pending, as the brief specifies.
- Certification body "Veritrust Assurance Services" is fictional and labelled as such on the certificate.

**D14. Fonts on the V4 photo come from the macOS system Arial, falling back to DejaVu, then to the Pillow default.**
The committed image is the reference artifact. Regenerating on another OS may change the pixels but not the truth.
