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
