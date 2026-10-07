# Evaluation report

Run: 3d63bdd2-d8b5-4dd3-b653-31c4eef15c88  |  2026-10-07T17:02:48.795Z  |  mode: fresh

**FRESH: every model call in this run was a live API call.**

Scored against `seed/out/truth.json`, which only this harness reads. "Exact" means within half a paisa of the true INR price per base unit after normalization.

## Metrics

| Metric | Value |
|---|---|
| Line recall (quoted lines found) | 100.0% (147 of 147) |
| Price exact after normalization | 100.0% (147 of 147) |
| Price within 1 percent | 100.0% |
| Unit and pack size correctness (lines needing a conversion) | 100.0% (50 of 50) |
| Questionnaire accuracy | 95.0% (57 of 60) |
| Status agrees with expected | 100.0% |
| Edges detected (E1 to E13) | 13 of 13 |
| **Confident wrong (Confirmed but wrong)** | **0 of 90 Confirmed cells (0.0%)** |
| Assumed but wrong | 0 |
| False alarm rate (right value sent to review) | 0.0% |
| Lines invented for unquoted items | 0 |
| Model calls | 28 live, 0 cache hits |
| Tokens (live calls) | 98028 in, 34945 out |
| Cost (live calls) | Rs 43.60 |

## Per vendor

| Vendor | Coverage | Exact | Confirmed | Assumed | Needs review | Conflict | Confident wrong | Questionnaire (ours / truth) |
|---|---|---|---|---|---|---|---|---|
| V1 | 30 of 30 | 30 of 30 | 30 | 0 | 0 | 0 | 0 | cleared / cleared |
| V2 | 30 of 30 | 30 of 30 | 30 | 0 | 0 | 0 | 0 | cleared / cleared |
| V3 | 27 of 30 | 27 of 27 | 27 | 0 | 0 | 0 | 0 | cleared / cleared |
| V4 | 30 of 30 | 30 of 30 | 0 | 30 | 0 | 0 | 0 | failed / failed |
| V5 | 30 of 30 | 30 of 30 | 3 | 27 | 0 | 0 | 0 | pending / pending |

## Edge cases

| Edge | Result | Detail |
|---|---|---|
| E1 | Detected | 30/30 lines exact; hidden sheet surfaced: true; lines taken from hidden sheet: 0 |
| E2 | Detected | 3/3 per tonne lines exact per kg and Confirmed |
| E3 | Detected | discount stored as condition: true; 14/14 affected lines kept at undiscounted base price; 14/14 lines carry the condition |
| E4 | Detected | Stated grand total Rs 4,20,57,101.22 differs from the sum of its 30 lines times annual quantity, Rs 4,13,13,458.96 (1.80 percent). Neither figure is trusted until resolved. |
| E5 | Detected | coverage 27 of 30; rows for the 3 unquoted lines: 0; not_quoted review: true |
| E6 | Detected | GST_REG06_29AADCD7745K1Z9.pdf: legal name "Deccan Paperboard Industries Private Limited" differs from the quote letterhead "Deccan Board Mills Pvt Ltd". The trade name "Deccan Board Mills" matches, so check which legal entity will invoice. |
| E7 | Detected | 20/20 per box lines exact and Assumed |
| E8 | Detected | V4 questionnaire: questionnaire_failed; expired certificate flagged: true |
| E9 | Detected | 22/22 inherited lines at last year rate and Assumed |
| E10 | Detected | 5/5 USD lines converted at the assumed 96 and Assumed |
| E11 | Detected | freight extra with no amount flagged V3:true V4:true V5:true |
| E12 | Detected | V5 questionnaire: questionnaire_pending; pending knockouts listed: 2 |
| E13 | Detected | suspicious content items on V3: 1; V3 questionnaire still decided on its real answers: questionnaire_cleared |

## Confident wrong cells

None.

## Line failures

None.

## Questionnaire mismatches

- V4 Q1: ours partial {"has":true} vs truth answered {"has":true,"number":"VAS/QMS/17/2214","expiry":"2026-03-31"}
- V5 Q1: ours partial {"has":true} vs truth answered {"has":true,"number":"VAS/QMS/22/8830","expiry":"2027-06-30"}
- V5 Q2: ours answered false vs truth partial null

## Document failures

None.

## Known limitations (read before trusting the numbers above)

1. **This is not a held out test.** Prompts and engine rules were debugged against these same 15 documents. A perfect line score here says the pipeline handles these planted edges; it does not predict accuracy on an evaluator's own file. No truth values or planted phrases were copied into prompts (checked by grep), but every fix was prompted by a failure seen on this set.
2. **One run is one sample.** Model output varies between runs. In one V5 run the blanket "same as last year" statement came back at match confidence 0.80 (below the 0.85 bar) and in others at 0.85 or more. Code now verifies that kind of scope deterministically (DECISIONS D21), but other borderline confidences can still flip a cell between Confirmed and Needs review from run to run. That flip only ever moves toward more review, never toward a silent wrong value.
3. **Questionnaire labels we disagree with (3 of 60).** V4 Q1 and V5 Q1 answer "certificate attached" without stating a number or expiry, which the model marks partial and the answer key marks answered. The knockout still resolves correctly from the attached certificate's expiry. V5 Q2 ("testing outsourced to a lab") is marked answered "no" but inferred, so the knockout stays Pending with the tentative fail shown. The key marks it partial.
4. **Photo lines are never Confirmed.** All 30 V4 values were read exactly, but they stay Assumed by design (DECISIONS D2). A buyer must eyeball the crop.
5. **Certificates are read for facts only.** Name and expiry checks are deterministic, but a forged or edited certificate would not be detected.
6. **Email bodies are documents.** Cover notes cost a classification call each (about Rs 0.06) and are then skipped.
