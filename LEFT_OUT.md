# Left out

Everything deliberately not built, and why.

## Out of scope by brief
Real email sending and receiving, authentication and multi tenancy, vendor portal, negotiation rounds, multiple categories, ERP and contract integrations, handwriting OCR, multi language documents, mobile first design, audit trail beyond corrections, role based approvals.

## Cut in phase 1 (2026-10-07), to hold the 3 hour budget
- **ESLint and Prettier.** `tsc --noEmit` in strict mode is the only static gate for now.
- **shadcn components beyond init.** `components.json` and `cn` exist; components are added when a screen needs them.
- **README depth.** A short README now; the full setup and architecture guide comes in phase 8.
- **Lab test report and company profile PDFs (V1, V2) and the FSC certificate (V1).** No edge in E1 to E13 depends on them. ISO certificates for all five vendors and the GST certificate for V3 are kept, because E6 and E8 need them.

## Deferred
- **Held out vendor variant for the eval.** Revisit after phase 5 only if there is time.

## Cut or deferred in phase 2 (2026-10-07)
- **Improvement rounds 2 and 3.** Not run; see DECISIONS D27.
- **Structured outputs (API constrained JSON).** Prompted JSON plus zod plus one repair is enough at this volume (D17). Revisit if repairs become common.
- **Extraction UI.** Re-run and retry buttons, per document error display and the inbox pipeline view arrive with the comparison and inbox screens (phases 3 and 6). `/api/extract` already returns per document results and errors.
- **Upload endpoint with signed Storage URLs.** The pipeline accepts any stored document; the upload route itself is phase 6.
- **Image crop rendering.** The model returns a normalized region for photo evidence; drawing the crop is the evidence drawer (phase 4).
- **Opus for the photo.** Not needed: Sonnet read all 30 rate card prices exactly.
- **Held out vendor variant.** Still deferred; the eval is therefore not a held out test (stated in the report).

## Cut or deferred in phases 3 and 4 (2026-10-07)
- **Dark mode, animations, mobile layout.** Cut as allowed. Only a short flash on cells a recompute changed, which respects reduced motion.
- **Accurate regions on the tilted photo.** The model's regions are approximate (D37). A real fix needs a new read or image processing.
- **Re-run extraction and retry buttons in the inbox.** Inbox and source view are read only; they arrive with the inbox simulation.
- **Vendor level and line level assumption scopes.** Only the global FX and GST are editable; the `assumptions` table supports more.
- **Undo for FX edits and an audit log of assumption changes.** FX can be reset to the default; only line corrections are logged.
- **Corrections survive re-extraction.** Re-running a document replaces its lines and drops their overrides and corrections. Fine for now; to revisit with the inbox.
- **Eval page in the app.** `eval/EVAL_REPORT.md` exists; the page is not built.
- **Needs review cells in the stored data.** The stored run produced none, so that part of the queue shows empty. It is exercised by unit tests, not by the live data.

## Cut or deferred in phase 5 (2026-10-08)
- **PDF decision memo and the approval note as a document.** The analyst drafts the note as chat text; the memo is phase 7.
- **Rate limits, daily spend cap and the usage meter.** The per turn cap (Rs 12) and the session guard exist; per IP and daily limits are phase 8.
- **Optimal split award.** `split_cap` is greedy and says so. A proper solver (integer program) was not worth it for 30 lines and 5 vendors.
- **More than one discount rule per vendor in the equilibrium search.** It handles several, but only V2 has one in the data and that is the only case tested live.
- **Tool output replay across turns.** Only answer text and a one line summary of earlier results are replayed. A follow up that needs an old figure re-runs the tool.
- **Vendor level and line level scenario assumptions.** Only the global FX and GST can be overridden for a scenario.
- **Held out questions.** The eight test questions were also the ones I tuned the prompt against, so they are not a held out test. The report says so.
- **Streaming resume.** If the connection drops mid answer the page says so and the user asks again; the partial text is not recovered.
- **A visual regression pass of the chat on narrow screens.** Desktop first, as the brief allows.

## Cut or deferred in the Phase 8 deployment slice (2026-10-08)
- **Limits on writes that do not spend money.** Review actions, FX and GST edits and recompute are not rate limited. They cost database time, not rupees, and Reset demo undoes them. A determined visitor could still slow the demo for everyone.
- **Counting model calls per IP.** The hourly limit counts requests to model routes; one analyst turn can make several model calls. The daily cap bounds the money.
- **An exact cap.** Two requests admitted at the same moment near the cap can overshoot it by their worst cases together. The Rs 12 door margin keeps this small.
- **Automatic switch to stored mode on an API outage.** A failed model call shows a friendly error and nothing stored is touched (D59), but only a cap, not an outage, switches the page to the stored runs view.
- **Upload route and signed upload URLs.** No route accepts a file yet; the validator is ready (D61). The route comes with the inbox in phase 6.
- **Live eval page.** It shows the committed report (D64), not the latest `eval_runs` row.
- **Stable order after Reset demo** for open items with equal value at stake.
- **Cleaning up visitors' chats before Reset.** Chats from visitors stay in the database until someone uses Reset demo.
- **Anything proven on real Vercel.** Function bundling, the bracketed catch all file, `includeFiles`, streaming on the live runtime and the TypeScript 7 build of the function are verified only on the first deploy (D62).
- **README setup and architecture guide, production seed run and the Loom walkthrough.** Still phase 8; `DEPLOY.md` covers deploying.

## Cut or deferred in Phase 7 (2026-10-08)
- **DOCX memo.** PDF and xlsx only (the brief allows PDF plus a DOCX or an xlsx appendix).
- **Charts in the memo.** Tables only. The Decision page has no charts either: the analyst draws charts from stored results.
- **The rupee sign and a custom font in the PDF.** Standard Helvetica, so amounts say "Rs". A custom font would need a font file shipped in the function and a font engine; not worth it for the demo.
- **Evidence crops and source quotes inside the memo.** The memo names the vendor, line and flag, and the page links to the evidence drawer. The photo crop for V4 stays in the app.
- **Pack history.** Nothing is stored: each download regenerates the pack. There is no list of past packs, no version number and no signature or approval step (role based approvals are out of scope by brief). A stored model note is reused only for identical data.
- **A discount threshold sweep.** Sensitivity shows the discount on and off, not a sweep of the threshold or of which PO split would reach it (the analyst answers that question on request).
- **Share cap or strategy sensitivity in the memo.** Only the USD rate, the discount and the loss of the top vendor, as FR-8.1 lists.
- **Failed vendors on the Decision page.** Eligibility offers cleared, or cleared plus Pending. A Failed vendor cannot be included here (the analyst can show it with warnings).
- **Decision page choices survive a reload.** The scenario resets when the page is left or reloaded.
- **The note's second live run.** Prompt version 2 for the approval note is unverified live (see D80).
- **Questionnaire answers in full inside the memo PDF.** The PDF shows the three knockouts and the result per vendor; the full twelve question matrix, with each vendor's answer text cut at 140 characters, is in the xlsx.
- **A visual regression test of the memo.** The layout was checked by eye on two scenarios. Tests read the text out of the PDF and check page count; they do not compare pixels.
- **Streaming the pack.** The route returns when the pack is done (a few seconds, up to about 15 with the model call). There is no progress beyond a status line.
- **Anything proven on real Vercel.** That `pdf-lib` is traced into the function and the 60 second duration is enough are checked only locally (plain Node 22 with the built function) until the deploy.

## Cut or deferred in Phase 6 (2026-10-08)
- **Real uploads of the owner's files through Try your file.** None were provided, so Part C has not run against the real model. Everything else about it is tested (D98).
- **Part C reads one file and decides nothing about a vendor.** No stated total reconciliation (`total_mismatch`), no knockout verdict, no certificate against letterhead check and no photo crop: those need the whole reply set or a second step. It lists lines, units, statuses, evidence, flags, review items, the questionnaire answers read and a certificate's facts.
- **Larger uploads for Try your file.** 4 MB, through the function. A signed Storage URL (which would allow the 10 MB the brief names) was not simple enough here, and the validator's 10 MB limit still stands for any future upload into the real inbox.
- **Upload into the real inbox, and duplicate detection by sha256 (FR-3.3, FR-3.4).** Try your file is the only upload and never touches the inbox, by design. The replay and the saved replies are read only.
- **Replies to a visitor's own RFx.** The stored replies answer the saved FY27 RFx only; the page says so. A draft that is issued gets five simulated emails and a pack and nothing comes back.
- **Draft management.** One active draft per browser in the UI. Up to five are kept, but there is no list, no rename, no duplicate and no version history or undo for the co-pilot's changes. An issued RFx cannot be edited or recalled.
- **Per vendor emails and real attachments.** One covering email per issue with the vendor name filled in. The PDF pack is rendered on download rather than attached as a stored file. No cc, no reply tracking, no resend.
- **The co-pilot cannot issue, and cannot see or change the questionnaire rules of the saved RFx.** By design. It also cannot change the buyer organisation (fixed to the demo buyer) or the vendor list (the five seeded vendors).
- **A code check for "one clarifying question".** Prompt rule only (D87).
- **Streaming resume** for the co-pilot, as for the analyst. A dropped connection keeps what the tools already did and asks the buyer to continue.
- **DOCX pack.** PDF only, as the cut order allowed. The timeline and the pack were built, so nothing from the cut order was dropped except Part C's real uploads.
- **Hiding the comparison until the replay is run.** The replay gates the Inbox only (D92).
- **Per visitor Reset.** Reset demo clears every visitor's drafts and sandbox rows (D99).
- **Anything proven on real Vercel.** Co-pilot streaming, the octet-stream upload body and the 60 second limit for a large file (D99).
- **A held out test of the co-pilot.** Four live turns and a scripted test suite, not an evaluation of draft quality. Quantities and specs it proposes are defaults it labels as such; there is no check that they are sensible for a real plant.

## Cut or deferred after the two unseen files (2026-10-08)
- **A prompt change.** None: the raw replies showed the model had captured every note (D101). Nothing in `prompts/` changed and there was no live run of the production path after the code changes.
- **A real fix for slab and indicative statements landing in `conditional_discounts`.** The model files a slab price and Trident's "5 percent below last year" under conditional discounts. Try your file only shows them. The stored pipeline would pass them to the discount engine, which only applies one it can read as a percent with a threshold. A prompt or a schema field for "price alternatives" would be the real fix.
- **An adjusted price for a board grade difference.** Deliberately not computed. The vendor's surcharge text is shown and the line goes to Needs review.
- **Comparison readiness for short validity.** Shown as a header warning only. A review item would change stored readiness counts.
- **Per vendor validity in the decision memo and note.** Not added; the memo does not mention validity.
- **Grade rules beyond BF numbers.** GSM, flute type and other board specs are not compared.
- **Free text units not in the list** ("per lot", "per bundle of 50") still go to Needs review, or to the vendor's pack definition when one exists.
- **Browser side recompute of the board grade for old stored cells** needs the quote level notes; they are passed, but only from the cell's own document, as for unit definitions.
- **Held out evaluation.** Still none. These two files are used up (D100).
- **Tax conflicts as stored review items.** The flag is on the line and in the Assumptions panel, but a conflict adds no separate open review item or vendor level `conflicting` basis in `vendor_terms.gst_basis` for the stored pipeline (Try your file has both). Adding it would change the stored readiness counts.
- **Stated "GST extra" lifting a line to Confirmed.** A line that says GST extra under an unknown document basis stays Assumed, as before. Changing it needs a decision on lines that carry other unverified conditions.
- **A model field for the tax basis and rate per line.** The schema has none and the prompt was not changed, because the model had captured the text. Only worth adding if the regular expressions miss real phrasing.
- **Held out evaluation.** Still none. The WhatsApp file is used up (D109).
- **A way for the buyer to settle a Not derived tax line in the app.** Deliberately not built: an edited value or a buyer check does not clear it (same as a line that contradicts itself). Needs a decision on who may state the basis.
- **Running the fixed tax guard live.** The live budget was spent on the run that exposed the gap (D120). The fix was verified by replay of that reply only.
- **Moving the stored pipeline to `extract.v4`.** It would orphan the cached replies of the stored run and change what a re-extraction costs. Try your file only for now.
- **A line level scope for statements in tables.** Statements are matched to a line by product words. A column of "GST extra" next to each row of a spreadsheet is read as the line's own text only when the extraction used it as evidence or a condition.

