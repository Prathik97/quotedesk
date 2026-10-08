NOTE INPUT: What I decided and what I left out

Numbers come from eval/EVAL_REPORT.md, eval/ANALYST_REPORT.md, DECISIONS.md, or from running the tests, verify scripts and the usage log on Node 22 on 8 Oct 2026. D numbers refer to DECISIONS.md. Live app: https://quotedesk-sandy.vercel.app

1. HEADLINE NUMBERS

Extraction eval (15 documents, all calls live):
- Line recall 100.0% (147 of 147). Price exact 100.0% (147 of 147)
- Confident wrong 0 of 90 Confirmed cells. Edges detected 13 of 13
- Questionnaire 57 of 60. Cost Rs 43.60

Analyst (8 questions, real model):
- Independent checks matched on 8 of 8
- Server number check passed on 7 of 8 first runs. Q3 failed (the model subtracted prices itself) and passed after a prompt fix
- Cost Rs 65.83

Checks run for this note:
- Tests: 691 passed (40 files), all with a mocked or no model
- verify:decision 128 of 128. verify:sandbox 147 of 147 stored cells identical
- verify:seeded combined hash 22422a42047e13d0, same as the D84 baseline
- Default scenario: Ready with open items, 0 blockers, 4 open items
- Model spend recorded in usage_log: Rs 291.28 over 167 live calls. Local captures that use an in memory store are not in that log: Rs 7.83 in the last run (D129) and Rs 11.95 in the run before (D127)
- Secret scan of full git history: 0 matches for eyJhbGci and for postgres connection strings with a password. The only matches for sk-ant- and sb_secret_ (1 line each) are the scanner patterns in scripts/check-bundle.ts, none key length. Only .env.example is tracked

2. THE DECISIONS THAT MATTER MOST

- D3: The model reads, code calculates, because a tested function does not mis-multiply.
- D2: Photo prices are capped at Assumed, because blurry small digits are the likeliest confident wrong value.
- D24: Confirmed needs high read confidence, match 0.85 or more, the number in the evidence and no assumption.
- D22: An inferred questionnaire answer never decides a knockout.
- D30: A buyer check never settles an external number such as an FX rate.
- D35: A conditional discount never enters the base price.
- D40: The award engine refuses an ineligible vendor and treats an unquoted line as a gap, never zero.
- D47: A server number check flags any analyst figure not found in tool results.
- D78: The memo must print every assumption and unresolved item, enforced in three places.
- D84: No code path writes the seeded tables, proven by hashing before and after live use.
- D110 and D128: Tax basis comes from the vendor's own words, and for a spreadsheet from the price column's own header. Inclusive prices are divided by the stated rate. Model written notes cannot override a header.

3. WHAT WAS DELIBERATELY LEFT OUT

- By brief: real email, vendor portal, negotiation, authentication, multi tenancy, ERP, OCR, multi language.
- An adjusted price for a board grade difference: a guessed adjustment is a silent number, so the line goes to Needs review.
- Failed vendors on the Decision page (D73). Optimal split solver (greedy, says so). ESLint, Prettier, DOCX memo.
- Tax and size findings as stored review items: they would change stored readiness counts.
- Header based tax for Word tables, PDFs and photos (limitation 19). A model field for per line tax basis.
- A held out evaluation. Everything is in LEFT_OUT.md.

4. KNOWN LIMITATIONS

- The 100% scores are on a dev set I tuned on. They do not predict accuracy on a stranger's file.
- One run is one sample. A borderline match confidence can flip a cell between Confirmed and Needs review, always toward more review. The last Metro Kraft run put three lines at 0.80 for that reason.
- The three unseen files were each used to fix rules, so none counts as evidence any more.
- Tax, slab, grade and box size rules are regular expressions and word lists. Other wording or languages are not seen.
- Header detection is for spreadsheets and is a heuristic. A header and a terms row that disagree give Not derived, a false alarm by design.
- Photo prices are never Confirmed. A forged certificate would not be detected.
- 3 of 60 questionnaire answers disagree with the key. None changes a decision.
- Streaming of the co-pilot and large uploads are verified only under local Node 22.
- Lessons from live reruns are in eval/KNOWN_LIMITATIONS.md: replay of one sample did not predict the next live run.

5. THE THREE UNSEEN FILE TESTS

| File | Tested | Found | Fixed by |
|---|---|---|---|
| Metro Kraft xlsx | Units, notes, board grade, tax columns | Doubled pack divisor, unmapped units, conditional prices Confirmed, dropped notes, header read as a tax statement | D102 to D105, D123, D128 |
| Trident email | Slabs, indicative prices | Notes captured then dropped | D104, D105 |
| Gupta WhatsApp chat | Informal tax, validity, pack text | Inclusive price shown as excluding GST, box size mismatch, pack definition lost | D110 to D114, D117 to D124 |

Final state of each unseen file:
- Metro Kraft, last live run (D129, Rs 7.83): all 24 lines derive their basic price from the sheet's "Basic rate (Rs)" header. 16 Confirmed, 8 Needs review: five 5 ply cartons on BF 20 with the vendor's text and no adjusted price, and three lines the model matched at 0.80. Replayed with five wordings of the model's tax note, the results are identical.
- Trident, from its fixture: no tax change from K5, the notes are shown beside Not quoted lines and never applied. Replays are byte identical before and after K5.
- Gupta, last live run (D127): 13 lines, the tape is 45.00 per roll, Assumed, pack size from the vendor's definition. The box lines are Needs review at match confidence 0.75 to 0.80, and INS-EDG-01 stayed Not derived because no statement covers it.

6. BUGS THAT MATTERED MOST

- Per 100 double conversion (D102): "615 per 100" became 0.0615, not 6.15.
- Tax inclusive prices (D110): four Gupta box lines moved from 28.4, 6.3, 9.5, 4.8 to 25.36, 5.62, 8.48, 4.29.
- Store before call data loss (D59). Production crash from extensionless imports (D67).
- Header row read as a tax statement (D122, D123), then the guard depending on the model's note wording (D128).

7. THE BETTER PROBLEM

The memo already lists one next step per unresolved item. The idea, my inference only: turn each open item into a drafted question to that vendor and read the reply back into the evidence backed comparison.

8. CLAIMS FIXED IN THE FINAL SESSION

- LEFT_OUT, D98: Try your file "has not run against the real model". Fixed: three files have run for real.
- LEFT_OUT: no upload route, signed URLs, Eval page "not built", README "short", "still phase 8". Each now carries a superseded line.
- LEFT_OUT: "verified only on the first deploy". Updated: deployed, small uploads ran, streaming and large uploads unverified.
- LEFT_OUT: fixed tax guard not run live, column of a price not checked, vendor text not stored. Marked done (D127, D128, D129).
- EVAL_REPORT limitation 1: now says later fixes came from the unseen files.
- D108 and D115 test counts: superseded, the suite is 691.
- D74's "5 open items": rechecked, it is 4.
- README: tax handling sentence and deployment line updated. D110 and D117 marked superseded in part by D128.
