# Tax guard: before and after, every changed line

Replays of the stored raw model replies through `deriveLines` with no model call. "Before" is commit 3c6e0a6 (production at the time of the G1 failure), "after" is the current code. Unchanged lines are not listed. A value of null means Not derived (no price excluding GST is shown; the price as the vendor wrote it is shown instead).

The Gupta replays carry no document text (the vendor file is not in the repo), so the guard works from the notes and the lines. With the real text the box lines of the live reply also resolve through the model (see DECISIONS D120).

## sandbox-gupta-whatsapp

| RFx line | as written | excl GST before | status before | excl GST after | status after | flags after |
|---|---|---|---|---|---|---|
| INS-EDG-01 | 14 | 14 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |

## sandbox-gupta-whatsapp-b

| RFx line | as written | excl GST before | status before | excl GST after | status after | flags after |
|---|---|---|---|---|---|---|
| INS-EDG-01 | 14 | 14 | assumed | Not derived | needs_review | tax_unresolved,tax_conflict |

## sandbox-gupta-whatsapp-b-variance

| RFx line | as written | excl GST before | status before | excl GST after | status after | flags after |
|---|---|---|---|---|---|---|
| CRT-3P-01 | 6.3 | 6.3 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| CRT-3P-02 | 9.5 | 9.5 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| CRT-3P-03 | 4.8 | 4.8 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| CRT-5P-01 | 28.4 | 28.4 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| CRT-5P-02 | 24.1 | 24.1 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| CRT-5P-03 | 37.6 | 37.6 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| CRT-5P-05 | 16.2 | 16.2 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| FLM-STR-01 | 104 | 104 | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| INS-EDG-01 | 14 | 14 | assumed | Not derived | needs_review | tax_unresolved,tax_conflict |
| PLT-WD-01 | 690 | null | needs_review | Not derived | needs_review | tax_unresolved,tax_conflict |
| SHT-5P-01 | 44.5 | 44.5 | assumed | Not derived | needs_review | tax_unresolved,tax_conflict,conditional_price |
| STP-PET-01 | 126000 | 126 | assumed | Not derived | needs_review | tax_unresolved,tax_conflict |
| TPE-BOPP-01 | 4500 | 45 | assumed | Not derived | needs_review | tax_unresolved,tax_conflict |

## sandbox-metro-kraft

| RFx line | as written | excl GST before | status before | excl GST after | status after | flags after |
|---|---|---|---|---|---|---|
| CRT-3P-01 | 615 | 6.15 | confirmed | Not derived | needs_review | tax_unresolved |
| CRT-3P-02 | 940 | 9.4 | confirmed | Not derived | needs_review | tax_unresolved |
| CRT-3P-03 | 470 | 4.7 | confirmed | Not derived | needs_review | tax_unresolved |
| CRT-3P-04 | 1430 | 14.3 | confirmed | Not derived | needs_review | tax_unresolved |
| CRT-3P-05 | 285 | 2.85 | confirmed | Not derived | needs_review | tax_unresolved |
| CRT-5P-01 | 2740 | 27.4 | needs_review | Not derived | needs_review | tax_unresolved,board_grade_mismatch |
| CRT-5P-02 | 2320 | 23.2 | needs_review | Not derived | needs_review | tax_unresolved,board_grade_mismatch |
| CRT-5P-03 | 3640 | 36.4 | needs_review | Not derived | needs_review | tax_unresolved,board_grade_mismatch |
| CRT-5P-04 | 5290 | 52.9 | needs_review | Not derived | needs_review | tax_unresolved,board_grade_mismatch |
| CRT-5P-05 | 1590 | 15.9 | needs_review | Not derived | needs_review | tax_unresolved,board_grade_mismatch |
| CRT-5P-07 | 1690 | 16.9 | confirmed | Not derived | needs_review | tax_unresolved |
| INS-PRT-01 | 9.5 | 9.5 | confirmed | Not derived | needs_review | tax_unresolved |

## sandbox-trident

No line changed.

