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
