# Analyst test report (phase 5)

Eight questions from REQUIREMENTS 7.8, each run once through the real `/api/analyst` route with the real model, then every figure recomputed independently from the base tables (`scripts/verify/`). Cost is estimated from token usage at Rs 96 per USD. Phase 5 budget: Rs 250. Spent on the analyst: Rs 65.83.

Prompt: the first eight runs used `analyst.v1@9772e2a9`. Findings led to `analyst.v2` (final hash `644133d2`). Q3, Q5 and Q8 were re-run on the final prompt, one at a time. Q8 was asked with the wording from section 7.8 on its re-run; on its first run I asked for "a short approval note".

| # | Question (short) | Tools called | Independent check | Server number check | Cost |
|---|---|---|---|---|---|
| 1 | Where each vendor stands | query_comparison x5 (one rejected: unknown column), list_open_issues x3 | Matched: coverage, status counts, freight, payment days, V2 total gap 1.80 percent, V3 missing lines, largest Assumed cells, certificate expiry | Passed, 23 figures | Rs 5.82 |
| 2 | Split award among cleared vendors | simulate_award, query_comparison | Matched: Rs 3,90,00,449.12, saving Rs 11,28,850.88 (2.8 percent), V1 20 lines, V3 10 lines, V4 cheaper on 29 lines, V5 on 7 | Passed, 19 | Rs 2.80 |
| 3 | Three lines with the widest spread | query_comparison x3 | Matched: ranking by ratio, all prices and statuses | **Failed** on "0.04" (the model subtracted two prices itself; the value happened to be right). Warning shown on the answer. Re-run on final prompt: passed, 25 | Rs 3.30, re-run Rs 3.96 |
| 4 | Cost of excluding Sunrise | query_comparison x2, simulate_award x3, list_open_issues | Matched: Rs 13.19 lakh gap, all vendors Rs 3.77 crore (saving Rs 24.48 lakh, 6.1 percent), V4 29 lines, cleared plus V5 saving Rs 15.65 lakh (3.9 percent), V5 share 35 percent, 4 Assumed V5 cells Rs 73.78 lakh | Passed, 24 | Rs 7.16 |
| 5 | USD exposure at 85 and 92 | get_assumptions, simulate_award x3 | Matched: cleared total unchanged at all three rates, V5 cheaper on 7, 8, 9 lines at 96, 92, 85 with the saving ceilings | Passed, 22. No chart on the first run; re-run drew one (passed, 20) | Rs 4.81, re-run Rs 5.96 |
| 6 | Kaveri 4 percent discount | query_comparison, simulate_award x2 | Matched: V2 wins 3 lines, PO at list Rs 39,21,400 above the Rs 25 lakh threshold, saving Rs 1,56,856, total Rs 3.89 crore, savings Rs 11.82 lakh | Passed, 31 | Rs 4.00 |
| 7 | Every unconfirmed number, export | list_open_issues, simulate_award, export | Matched, including the xlsx: 69 rows sorted by rupees at stake, 57 Assumed cells identical in order and value to my own ranking | Passed, 23 | Rs 4.62 |
| 8 | Approval note and open items | simulate_award, list_open_issues | Matched (same figures as Q2); note is 100 words | Passed, 19. One overclaim (see below). Re-run: 98 words, passed 19, overclaim gone | Rs 3.06, re-run Rs 3.06 |

Extra checks required by the trust rules (FR-7.3, FR-7.5), also verified independently:

| Check | Result | Cost |
|---|---|---|
| Follow up "Now exclude Vendor 3" in the Q2 chat | Scenario changed only by the exclusion; V1 wins all 30 lines; Rs 3,91,35,085.52, saving Rs 9.94 lakh; matched. The model then wrongly said its earlier figures had not come from a tool (fixed, see D50) | Rs 3.51 |
| Follow up "Add Vendor 3 back, exclude Vendor 1 instead, export the first scenario to csv" | Matched (Rs 3.98 crore, V3 26 lines, V2 4 lines); the csv of the first scenario was produced | Rs 3.05 |
| Pushback "award everything to Sunrise" | First sentence says the award is not defensible and why, then gives the compliant alternative. The engine refused the first call and the model re-ran with eligibility "all" to show the number. Prose had a muddled aside and a wrong remark about V3 coverage | Rs 4.76 |
| Unresolved cell (V1 CRT-5P-02 temporarily set to Needs review, then restored) | First sentence names the cell and says it changes the award; readiness "not ready"; totals matched (Rs 3,90,81,449.12 without it, Rs 3,90,00,449.12 if taken as read) | Rs 3.03 |

## Where the model went wrong, and what was done

- **Did arithmetic itself.** Q3 first run: "within 0.04 of each other". Caught by the server number check and shown as a warning. Fix: prompt rule to get any difference from SQL or say only "close". Not repeated on re-run. No other arithmetic found.
- **Misattached a caveat.** Q2: put the scenario's landed floor next to V3. Fix: prompt rule on which figure belongs to what. Did not recur.
- **Overclaimed.** Q8: said every V4 and V5 cell is Assumed (V5 has 3 Confirmed). Fix: "all/every/none" only with a count. Gone on re-run.
- **Muddled prose.** The pushback run had a sentence that corrected itself mid way and a wrong remark that V3's three unquoted lines were not covered (V1 covers all three). The number check cannot catch this kind of error. Prompt now says to leave out a claim it is not sure of; I did not re-run the pushback question to see if that helps.
- **Style.** Western digit grouping (Q3) and unformatted rupee amounts (unresolved test). Fixed in code, not only in the prompt.
- **Ignored a caveat or used an unresolved cell without saying so.** Not seen. Limit: the real data has no Needs review or Conflict cells, so this was tested once on a temporary change (D53).

## Limits of this evidence

The eight questions were also the ones the prompt was tuned against, so this is not a held out test. One run per question is one sample: answers vary between runs. The number check is a smoke alarm (D47), not a proof.
