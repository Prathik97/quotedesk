# K5 before and after: Metro Kraft, the same sheet, five wordings of the model's tax note

Replays with no model call of the stored Metro Kraft extract.v4 reply and the real sheet text (the vendor file is not in the repo; the prepared text is saved as `eval/fixtures/sandbox-metro-kraft.sheet.txt`). "Before" is commit 64e66de, "after" is the K5 code. Only the model written document basis and notes change between variants. A value of null is Not derived.

| variant | before (64e66de) | after (K5) |
|---|---|---|
| production wording: "Carton rows have Basic rate (excl GST) and Rate incl GST columns", basis unknown | 12 lines Not derived (CRT-5P-01 to 05, CRT-5P-07, CRT-3P-01 to 05, INS-PRT-01); 11 Assumed, 13 Needs review | 24 derived; 18 Confirmed, 6 Needs review |
| no tax note, basis unknown | 24 derived; 18 Assumed, 6 Needs review | 24 derived; 18 Confirmed, 6 Needs review |
| "incl GST shown for convenience", basis excl | 24 derived; 18 Confirmed, 6 Needs review | same |
| an unrelated sentence, basis unknown | 24 derived; 18 Assumed, 6 Needs review | 24 derived; 18 Confirmed, 6 Needs review |

The 6 Needs review are the five 5 ply cartons on BF 20 and INS-EDG-01 (stored reply match confidence). A fifth wording, a note claiming "Carton prices include GST" with document basis incl, is covered by the tests only: all 24 lines derive from the header.

After, the four variants listed in the test file give identical results line by line. Derived basic prices: 3 ply cartons 6.15, 9.40, 4.70, 14.30, 2.85; partition set 9.50; CRT-5P-07 16.90; the five 5 ply cartons on BF 20 stay Needs review with the vendor's BF text and no adjusted price. Gupta and Trident replays are byte identical before and after (the replay files compare equal).
