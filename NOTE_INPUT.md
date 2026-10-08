NOTE INPUT: What I decided and what I left out

Numbers come from eval/EVAL_REPORT.md, eval/ANALYST_REPORT.md, DECISIONS.md, or from running the tests and verify scripts on Node 22 on 8 Oct 2026. D numbers refer to DECISIONS.md.

1. HEADLINE NUMBERS

Extraction eval (fresh run, 15 documents, all calls live):
- Line recall 100.0% (147 of 147). Price exact 100.0% (147 of 147)
- Confident wrong 0 of 90 Confirmed cells. Edges detected 13 of 13
- Questionnaire 57 of 60. Cost Rs 43.60

Analyst (8 questions, real model):
- Independent checks matched on 8 of 8
- Server number check passed on 7 of 8 first runs. Q3 failed ("0.04", the model subtracted prices itself) and passed after a prompt fix
- Cost Rs 65.83

Checks run today:
- Tests: 572 passed (35 files)
- verify:decision 128 of 128. verify:sandbox 147 of 147
- verify:seeded combined hash 22422a42047e13d0, same as the D84 baseline
- Total model spend to date, from usage_log: Rs 267.84

2. THE 12 DECISIONS THAT MATTER MOST

- D3: The model reads, code calculates, because a tested function does not mis-multiply.
- D2: Photo prices are capped at Assumed, because blurry small digits are the likeliest confident wrong value.
- D24: Confirmed needs high read confidence, match 0.85 or more, the number in the evidence quote and no assumption, so green means safe.
- D22: An inferred questionnaire answer never decides a knockout, because excluding a vendor on a guess is a silent error.
- D30: A buyer check can settle reading doubts but never an external number such as a vendor's FX rate, because looking at the source cannot verify it.
- D35: A conditional discount never enters the base price and applies only when the order clears a threshold read from the vendor's text.
- D40: The award engine defaults to cleared vendors, refuses an ineligible vendor, and treats an unquoted line as a gap, never zero.
- D44: Charts and exports reference stored results, so they cannot contain a figure no tool produced.
- D47: A server number check flags any analyst figure not found in tool results, a smoke alarm that catches the model doing its own sums.
- D78: The memo must print every assumption and unresolved item, enforced in the builder, the route and the tests, so no memo hides a risk.
- D84: No code path writes the seeded tables, proven by hashing ten of them before and after live use.
- D110: Tax basis is read from the vendor's own words and inclusive prices are divided by the stated rate, so tax inclusive and exclusive prices are not compared.

3. WHAT WAS DELIBERATELY LEFT OUT

Product scope:
- Real email, vendor portal, negotiation rounds, authentication, multi tenancy, role approvals, ERP, OCR, multi language: out by brief.
- Adjusted price for a board grade difference: a guessed adjustment is a silent number, so the line goes to Needs review.
- Failed vendors on the Decision page: such an award is not defensible (D73).

Engineering:
- ESLint and Prettier, DOCX memo, charts in the memo, pack history, draft management: cut for time.
- Optimal split solver: split_cap is greedy and says so.
- Structured API outputs: prompted JSON, zod and one repair is enough (D17).
- Tax and size findings as stored review items: they would change stored readiness counts.
- Proof on real Vercel for streaming and large uploads: checked only under local Node 22.

Data:
- Lab report, company profile and FSC certificate PDFs: no planted edge needs them.
- A model field for per line tax basis: only worth it if the regular expressions miss real phrasing.
- GSM and flute grade rules, and a held out evaluation: not built, so there is no held out score.

4. KNOWN LIMITATIONS

- The 100% scores are on a dev set I tuned on. They show the pipeline handles those planted edges, not that it will on a stranger's file.
- One run is one sample. A borderline confidence can flip a cell between Confirmed and Needs review, always toward more review.
- Three unseen files were read once and then used to fix rules, so none counts as evidence any more.
- Tax, slab, board grade and box size rules are regular expressions over the model's phrasing. A vendor who words it differently is not seen.
- Box sizes depend on the model's description. A bare "14x10x8" is not guessed and the 6 percent tolerance is a rule of thumb.
- A validity written as a date, or with an unlisted unit, gives no days and no warning.
- Photo regions are approximate (D37). Photo prices are never Confirmed.
- A forged certificate would not be detected.
- 3 of 60 questionnaire answers disagree with the key. None changes a decision.
- The stored data has no Needs review cells, so that path was tested once with a temporary change (D53).
- The analyst's prose can be muddled in ways the number check cannot catch.
- Approval note prompt v2 has not been run live. The v1 note was 187 words against a 149 limit (D80).

5. THE THREE UNSEEN FILE TESTS

| File | Tested | Found | Fixed by |
|---|---|---|---|
| Metro Kraft xlsx | Units, notes, board grade | Doubled pack divisor, unmapped unit phrases, conditional prices Confirmed, dropped vendor notes (four gaps shared with Trident) | D102 to D105, no prompt change |
| Trident email | Slabs, indicative prices | Model captured the notes, the result dropped them | D104, D105: shown beside Not quoted lines, never applied |
| Gupta WhatsApp chat | Informal tax and validity | Inclusive price shown as excluding GST, box size mismatch, stored label counted sandbox runs | D110 to D114 |

The docs do not attribute each gap to one of the first two files.

6. BUGS THAT MATTERED MOST

The docs do not always say who found each.
- Per 100 double conversion (D102): "615 per 100" became 0.0615, not 6.15.
- Tax inclusive prices (D110): four Gupta box lines moved from 28.4, 6.3, 9.5, 4.8 to 25.36, 5.62, 8.48, 4.29.
- Store before call data loss (D59): extraction deleted stored lines before the model call, so a cap or outage would leave a document empty.
- Stored label count (D112): Try your file calls moved the label from 24 to 26 calls with no data change.
- Production crash (D67): 14 extensionless imports failed on Vercel, fixed by bundling and check:function.
- Analyst arithmetic (Q3) and "figures did not come from a tool" (D50): fixed by prompt rules and a prior results line.

7. THE BETTER PROBLEM

The docs do not describe a vendor clarification loop. They hold the groundwork: the memo lists one next step per unresolved item, D22 and D41 say "confirm with the vendor", and nothing comes back from the simulated outbox. The idea, my inference only: turn each open item into a drafted question to that vendor and read the reply back into the evidence backed comparison.

8. CLAIMS NO LONGER TRUE

- LEFT_OUT and D98: Try your file "has not run against the real model". Three files have run on production.
- LEFT_OUT Phase 8 and D61: "No route accepts a file yet". Try your file takes 4 MB uploads (D95). D9 (signed URLs) is superseded.
- LEFT_OUT Phase 3 and 4: "Eval page ... not built". D64 built it.
- LEFT_OUT Phase 1 and 8: README "short" and "still phase 8". It now has setup and architecture.
- LEFT_OUT Phase 8 and README: "verified only on the first deploy". Deployed, and small uploads ran; streaming and large uploads remain unverified.
- EVAL_REPORT limitation 1 says every fix came from this set; later fixes came from the unseen files.
- D108 and D115 give 503 tests; it is 572.
- Not rechecked: D74's "5 open items" may have moved after D107.
