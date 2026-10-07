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

## 2026-10-07 Phase 2: extraction and evaluation

**D15. Excel is parsed with exceljs, not SheetJS.** The npm `xlsx` package (0.18.5) has known prototype pollution and ReDoS issues on untrusted files, and evaluators may upload their own. exceljs reads hidden sheet state and merged regions, which is all FR-4.2 needs. `npm audit` shows 5 moderate transitive findings (mammoth's CLI argument parser, a `uuid` buffer option); neither code path is reachable from ours.

**D16. Model per stage.** Classification uses `MODEL_FAST` (Haiku 4.5). Quote extraction and certificate facts use `MODEL_EXTRACT` (Sonnet 5.5) with thinking turned off (`thinking: {type: "between_tools"}`): the job is transcription, and thinking tokens are billed as output on a tight budget. Opus was not needed; the photo read 30 of 30 prices exactly.

**D17. JSON by instruction, validated by zod, one repair call.** Alternative: the API's structured outputs. Rejected for now so the spec's repair path is real and the schema can be lenient where harmless (numeric strings, omitted defaults). SDK retries are set to 0; the only retry anywhere is the single repair.

**D18. Cost guard is code, not goodwill.** Every model call goes through `callModel`: dev cache lookup, then a hard session cap (Rs 300, the env can lower it but never raise it), reserving the worst case (all input at the cache write rate, output at max_tokens) including calls in flight, then the call, then a usage_log row and a printed cost line. The budget session id lives in `.qd-session` (gitignored) so spend accumulates across every script. Cache hits cost 0, are logged with `cache_hit = true`, and are labelled `[CACHE HIT]` in output and in the eval report header. Truncated replies are never cached. Unit tests inject a fake client; constructing the real client under Vitest throws.

**D19. Email bodies are documents.** A reply's body can carry prices or answers (V4's questionnaire answers are only in its email). Each message body becomes a `text/plain` document unless the reply already includes the email as an `.eml`. That makes 15 documents, not 13: 11 vendor files plus 4 bodies. Cover notes are classified `other` and skipped after one cheap classification call.

**D20. Extraction contract changes from section 5.2.** (a) `document.group_statements`: one statement that prices or inherits several RFx lines ("cartons and everything else same as last year") is written once and expanded by code into per-line rows sharing the same evidence; a specific line price wins over the blanket. (b) The model omits null, empty and default keys; zod restores defaults. (c) A line's `read_confidence` may be omitted and then equals its evidence's read confidence, which is the same reading. (d) The JSON parser merges a repeated key instead of keeping only the last one (the model once emitted two `document` objects). Reason for all four: the first V5 call ran past 8000 output tokens and was cut off (Rs 8.86 spent for nothing), and two later calls needed a repair purely for shape.

**D21. Code verifies the scope of blanket inheritance.** When a "same as last year" group covers exactly the RFx lines that the same document does not price elsewhere, code marks the scope verified and sets match confidence to 0.90, recording the model's own value in the reason. Partial groups keep the model's confidence. Prompted by run to run variance: the same statement scored 0.80 in one run and 0.85 or more in others.

**D22. An inferred answer never decides a knockout.** The model marks each questionnaire answer `explicit` or `inferred`. A knockout resting on an inferred answer is Pending, with the tentative reading kept ("reads as a fail, confirm with the vendor"). Excluding a vendor on an inference is a silent guess (R5), and showing both readings is the alternative interpretation FR-7.3 asks for. This was prompted by the E12 miss: V5's "testing is outsourced" was read as a plain "no". An explicit failure on any other knockout still fails the vendor.

**D23. Units: footnote markers and qualifiers.** "per box*" and "per box**" are different units when the vendor defines "box*" and "box**" differently, so the marker must match. Parenthetical qualifiers ("pcs (cartons, trays)") are ignored for unit parsing. If two definitions fit and nothing says which applies, the line is not converted (`pack_size_unknown`, Needs review).

**D24. Status thresholds.** Confirmed needs: high read confidence, match confidence at or above 0.85, the number present in the evidence quote, a known unit, no assumption, and a non-photo source. Medium read confidence on a text source goes to review; on a photo it stays Assumed (photos are capped anyway). `unit_suspect` fires when the normalized price is more than 4 times or less than a quarter of last year (catches an unconverted per 100 or per tonne price); `unusual_vs_last_year` at 35 percent is information only. Stated totals tolerate 0.5 percent.

**D25. Attachment checks are deterministic.** A certificate's legal name is compared with the quote letterhead name (as the model read it) and the vendor name, after removing case, punctuation and entity suffixes. When only the trade name matches, the flag says so. An expiry before the reply date flags the certificate, and its expiry feeds the ISO knockout when the answer itself says only "attached".

**D26. Prompts are files read at runtime** (`prompts/<name>.vN.md`), versioned by name plus a content hash, so any edit invalidates the dev cache. Vercel will need `includeFiles` for `/prompts` (phase 8).

**D27. Stopped after one improvement round.** After round 1 every line metric is at 100 percent and all 13 edges are detected. The 3 remaining questionnaire mismatches are labelling disagreements that change no decision (see the eval report's known limitations). Further rounds would tune toward the answer key on the same 15 documents, not improve the product, and would spend about Rs 44 each.

### Iteration log

| Round | What changed | Lines exact | Confident wrong | Edges | Questionnaire | Fresh run cost |
|---|---|---|---|---|---|---|
| Pre-eval (single documents) | v1 to v2 prompt: compact output, group statements; merging JSON parser; line confidence fallback; unit markers and qualifiers | n/a | n/a | n/a | n/a | Rs 70.47 spent bringing up all 15 documents one at a time |
| 0 | First full fresh eval | 147 of 147 | 0 of 90 | 12 of 13 (E12 missed) | 55 of 60 | Rs 44.33 |
| 1 | v3 prompt: answer basis; inferred answers never decide knockouts; code-verified blanket scope | 147 of 147 | 0 of 90 | 13 of 13 | 57 of 60 | Rs 43.60 |

Phase 2 spend, from usage_log: Rs 161.67 of the Rs 300 cap.

## 2026-10-07 Phases 3 and 4: normalization engine, comparison, evidence and review

No model calls were made in this phase. Everything reads the stored extraction results.

**D28. One derivation for every number.** `engine/recompute.ts` (`recomputeLine`) is the only place a line's normalized price, flags and status are derived. Extraction (`persist.ts`), server recompute and the browser all call it. Check: recomputing all 147 stored lines at the stored assumptions changed 0 of them, so the engine reproduces the live run exactly.

**D29. Corrections are an overlay, never an overwrite.** The extracted fields (quoted price, unit text, evidence) are never edited. A buyer's changes live in `quote_lines.overrides`, the audit trail in `corrections` (made nullable on `quote_line_id`, plus vendor, review item and action columns so a vendor level dismissal is also a row). Undo clears the overlay and the original reading returns.

**D30. What each review action means.** Accept as read, edit value and set unit meaning all mean "a person looked at the source", so read, match and evidence doubts are settled and the photo cap is lifted. They can accept interpretation assumptions (pack size from a footnote, GST basis not stated, last year inheritance) but never an external number: a vendor who gives no FX rate leaves its USD cells Assumed whatever anyone clicks, because looking at the source cannot verify a rate. A unit meaning set by the buyer is a decision, not an assumption. Mark not quoted removes the cell from totals and keeps the original for Undo. Dismiss closes only the queue item; the cell keeps its status.

**D31. Dismissed items stay dismissed.** Review items regenerated by checks carry a fingerprint (kind, document, line, first 48 characters of the message). When the same finding comes back after a recompute its state and reason are carried over; if the numbers in the message change, it reopens. Price dependent checks (conflicts, stated total) were split out into a batched `reconcilePrices`, so a recompute needs about a dozen queries instead of about a hundred (65 s down to about 3 s over this machine's slow link to the pooler; the database itself runs the queries in 2 ms).

**D32. Instant recompute is done in the browser too.** The comparison payload carries the raw fields per cell, so an FX or GST edit re-derives all cells with the same engine in about 10 ms, and the server persists in the background and then replaces the browser's result. A change banner lists every cell that moved, with before and after, so nothing moves silently.

**D33. Review queue contents.** Open review items plus every Assumed cell, sorted by value at stake. Assumed cells are listed because the buyer must be able to confirm them (they have no row to dismiss). For a vendor level item with no price of its own the value at stake is that vendor's annual total, the most that depends on the answer.

**D34. Readiness.** Blockers are open items that can change who wins or what a total is: cells needing review, conflicts, a stated total that does not add up, an undecided knockout, freight with no amount or terms, and failed extraction. Dismissing with a reason clears a blocker and is recorded. Ready with assumptions means no blockers but assumed cells or warnings remain. Today the dataset shows Not ready with 6 blockers (V2 total, V3 and V4 and V5 freight, V5 two knockouts).

**D35. Conditional discounts.** Never in a base price. The engine reads the threshold from the vendor's own condition text (`parseThresholdInr`, refuses when two amounts appear) and the affected lines from the lines that carry the same percentage in their own condition. The grid toggle applies a discount only when the vendor's whole quoted order, as one PO, is above the threshold; an unreadable threshold is never applied. The vendor header always shows the threshold, the order value and the saving.

**D36. "Lowest price" does not hide ineligible vendors.** With the questionnaire toggle off, the lowest price is the lowest of everyone, and a cell held by a vendor who did not clear says so in red inside the cell. With the toggle on, only Cleared vendors can hold it (Pending and Failed are both left out). The questionnaire tab states the other reading of "cleared" (no knockout failed).

**D37. Photo regions are approximate and labelled so.** The reader's normalized regions on the tilted V4 photo are a row or so off and too wide, and the footnote box is not on the footnote. The drawer shows the crop as "approximate" and links the whole photo. Fixing it would need a new model call or image processing, so it is left (see LEFT_OUT).

**D38. State and tables are hand built.** No TanStack Query or Table: one small store and a custom grid, because the grid needs roving focus and arrow keys and the data is one payload.

**D39. Vercel function count.** The API now has 12 route files (the hobby plan limit is 12). Phase 5 and later will exceed it; consolidate behind one catch all route in phase 8.
