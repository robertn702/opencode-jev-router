# Quota-bounded Astra autoresearch

## Outcome

The frozen candidate **did not meet the objective**. Across six preselected, independent SWE-bench Verified tasks with six fresh attempts per arm, fixed high solved **36/36**, current Jev **36/36**, and the `verify-explicit` candidate **35/36**. Its one failure was on SymPy #16450. Candidate usage evidence was invalid in two other, graded-successful attempts; these remain in the success denominator but cannot support a token estimate. No change to the production Jev prompt is recommended from this pilot.

On evidence-valid runs, candidate output averaged **1,498** tokens versus **1,507** for current Jev (about **0.6% less**, with different denominators) and **1,800** for fixed high. Candidate mean agent time was **113.7s**, current Jev **111.0s**, high **118.4s**. The ~15% output-saving target *versus current Jev* was not reached; this is not a matched-quality saving because of the candidate's failure and invalid usage. The short failed SymPy attempt (163 output tokens) is retained in the candidate's valid-usage mean, never interpreted as an efficiency win. Relative to fixed high, current Jev used about **16.3% fewer output tokens** on these all-successful arms, but this task set is a pilot and not a broad workload estimate.

All **140 initiated attempts** have recorded completions: 16 development baseline attempts, 16 initial candidate screens, and 108 frozen confirmation attempts. No agent timeout, classification failure, or fallback occurred in confirmation. The original weekly quota window was **65% used** on 2026-09-25 04:58Z; the experiment stopped after completing the extension, well before the original reset, with 35% reported remaining. Quota is shared and percentage reports are coarse; this is not a precise guarantee of consumption.

### Holdout variability and routing

| Task | High success | Current Jev success | Candidate success | Current output | Candidate output* |
| --- | ---: | ---: | ---: | ---: | ---: |
| pytest #5262 | 6/6 | 6/6 | 6/6 | 1,112 | 1,355 |
| Django #14500 | 6/6 | 6/6 | 6/6 | 1,279 | 1,316 |
| scikit-learn #26194 | 6/6 | 6/6 | 6/6 | 2,025 | 2,146 |
| SymPy #16450 | 6/6 | 6/6 | 5/6 | 1,007 | 894 |
| xarray #7393 | 6/6 | 6/6 | 6/6 | 2,206 | 2,021 |
| Requests #2931 | 6/6 | 6/6 | 6/6 | 1,413 | 1,338 |

*Mean on evidence-valid attempts only. Two candidate successes lack reconciled usage (scikit-learn and Requests). The SymPy mean includes the short failed attempt. Per-decision effort counts: current Jev high 375 / medium 159 / low 42; candidate high 382 / medium 158 / low 51. Neither chose xhigh. Mean recorded Jev classification latency per decision: current 572ms, candidate 563ms; this overhead is included in agent time. All-arm input and cached-input means appear below; cached input is a subset of input, not an additional category.

### Provenance and limits

Public dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`; task list, row digest, selection rule, and prompt hashes were frozen in the ignored schedule before outcomes. Holdout selection used a fixed SHA-256 rank and distinct repositories, excluding the previously investigated cases. Every task passed independent base-fails/reference-passes preflight. Agents ran GPT-6 Astra in fresh Docker containers with per-attempt worktree, HOME and private `/tmp`; the same preinstalled dependencies and image were used across arms. Grading ran separately against the pinned reference tests, never in the agent's mounted filesystem. One agent attempt at a time. This is a public benchmark; possible public-solution exposure and small task/sample counts limit generalization. The metadata below includes all started attempts, including evidence failures; raw logs and patches stay ignored. No repository changes were committed.

Pinned schedule: `eval/runs/quota-autoresearch-20260924/schedule.json`.
All started attempts, including short failures, are in the append-only ledger. Raw artifacts remain ignored.

| Phase | Arm | Initiated | Solved | Incomplete | Valid usage | Input | Cached input | Output | Seconds (all) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| confirmation-baseline | jev | 36 | 36 | 0 | 36 | 186492.4 | 162677.3 | 1506.9 | 111.0 |
| confirmation-candidate | jev | 36 | 35 | 0 | 34 | 191489.4 | 167258.4 | 1498.2 | 113.7 |
| confirmation-high | high | 36 | 36 | 0 | 36 | 238030.1 | 210090.7 | 1800.0 | 118.4 |
| development | high | 8 | 8 | 0 | 8 | 488542.8 | 445440.0 | 3120.1 | 229.1 |
| development | jev | 8 | 8 | 0 | 8 | 404756.1 | 366480.0 | 2835.6 | 195.8 |
| screen-lowest-sufficient | jev | 4 | 4 | 0 | 4 | 315528.8 | 287808.0 | 2673.8 | 157.8 |
| screen-marginal-benefit | jev | 4 | 4 | 0 | 3 | 145977.7 | 123392.0 | 1359.3 | 130.1 |
| screen-next-step-only | jev | 4 | 4 | 0 | 4 | 192268.5 | 169728.0 | 2148.0 | 128.9 |
| screen-verify-explicit | jev | 4 | 4 | 0 | 4 | 218815.5 | 187712.0 | 2078.2 | 126.2 |

## Individual attempts

| Key | Grade | Evidence | Input | Cache | Output | Seconds | Error / fallback |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| development:pallets__flask-5014:high:1 | True | True | 170098 | 150656 | 1154 | 81.1 | 0/0 |
| development:pytest-dev__pytest-5787:jev:1 | True | True | 549570 | 506880 | 4296 | 225.8 | 0/0 |
| screen-lowest-sufficient:pallets__flask-5014:jev:1 | True | True | 65490 | 54528 | 625 | 57.1 | 0/0 |
| development:scikit-learn__scikit-learn-25102:high:1 | True | True | 962597 | 897792 | 4897 | 489.4 | 0/0 |
| development:pytest-dev__pytest-5787:high:1 | True | True | 590428 | 542592 | 4432 | 228.1 | 0/0 |
| screen-marginal-benefit:scikit-learn__scikit-learn-25102:jev:1 | True | True | 113354 | 101120 | 1518 | 96.6 | 0/0 |
| screen-lowest-sufficient:django__django-14631:jev:1 | True | True | 241805 | 216960 | 1840 | 124.4 | 0/0 |
| screen-lowest-sufficient:scikit-learn__scikit-learn-25102:jev:1 | True | True | 260720 | 230272 | 3005 | 170.4 | 0/0 |
| development:pytest-dev__pytest-5787:jev:2 | True | True | 535911 | 479360 | 4346 | 224.0 | 0/0 |
| development:pallets__flask-5014:jev:2 | True | True | 59699 | 48384 | 618 | 53.7 | 0/0 |
| development:scikit-learn__scikit-learn-25102:high:2 | True | True | 673470 | 601216 | 3469 | 420.7 | 0/0 |
| development:scikit-learn__scikit-learn-25102:jev:2 | True | True | 1181862 | 1118208 | 5088 | 526.3 | 0/0 |
| development:scikit-learn__scikit-learn-25102:jev:1 | True | True | 290922 | 227328 | 3258 | 174.9 | 0/0 |
| development:pytest-dev__pytest-5787:high:2 | True | True | 653931 | 596224 | 4770 | 235.7 | 0/0 |
| development:django__django-14631:high:2 | True | True | 312545 | 282240 | 2396 | 140.0 | 0/0 |
| development:django__django-14631:jev:1 | True | True | 232734 | 203648 | 1941 | 127.9 | 0/0 |
| development:pallets__flask-5014:high:2 | True | True | 197162 | 174848 | 1275 | 88.2 | 0/0 |
| development:django__django-14631:jev:2 | True | True | 283874 | 257152 | 2225 | 152.6 | 0/0 |
| development:pallets__flask-5014:jev:1 | True | True | 103477 | 90880 | 913 | 80.8 | 0/0 |
| screen-marginal-benefit:django__django-14631:jev:1 | True | True | 219742 | 187136 | 1735 | 116.8 | 0/0 |
| development:django__django-14631:high:1 | True | True | 348111 | 317952 | 2568 | 149.1 | 0/0 |
| screen-marginal-benefit:pallets__flask-5014:jev:1 | True | True | 104837 | 81920 | 825 | 66.6 | 0/0 |
| screen-lowest-sufficient:pytest-dev__pytest-5787:jev:1 | True | True | 694100 | 649472 | 5225 | 279.4 | 0/0 |
| screen-marginal-benefit:pytest-dev__pytest-5787:jev:1 | True | False | None | None | None | 240.4 | 0/0 |
| screen-verify-explicit:pallets__flask-5014:jev:1 | True | True | 69394 | 61824 | 622 | 56.4 | 0/0 |
| screen-verify-explicit:pytest-dev__pytest-5787:jev:1 | True | True | 493064 | 457216 | 3917 | 220.9 | 0/0 |
| screen-verify-explicit:django__django-14631:jev:1 | True | True | 180265 | 142976 | 1652 | 114.8 | 0/0 |
| screen-verify-explicit:scikit-learn__scikit-learn-25102:jev:1 | True | True | 132539 | 88832 | 2122 | 112.6 | 0/0 |
| screen-next-step-only:pallets__flask-5014:jev:1 | True | True | 117792 | 95360 | 1053 | 79.6 | 0/0 |
| screen-next-step-only:pytest-dev__pytest-5787:jev:1 | True | True | 182544 | 167936 | 3120 | 143.4 | 0/0 |
| screen-next-step-only:django__django-14631:jev:1 | True | True | 205149 | 176768 | 1716 | 131.8 | 0/0 |
| screen-next-step-only:scikit-learn__scikit-learn-25102:jev:1 | True | True | 263589 | 238848 | 2703 | 160.9 | 0/0 |
| confirmation-high:scikit-learn__scikit-learn-26194:high:2 | True | True | 179152 | 151168 | 1848 | 102.0 | 0/0 |
| confirmation-high:pydata__xarray-7393:high:1 | True | True | 448642 | 416128 | 2605 | 182.3 | 0/0 |
| confirmation-baseline:sympy__sympy-16450:jev:3 | True | True | 81773 | 65152 | 1221 | 107.7 | 0/0 |
| confirmation-baseline:psf__requests-2931:jev:2 | True | True | 222811 | 201856 | 1315 | 91.0 | 0/0 |
| confirmation-candidate:pytest-dev__pytest-5262:jev:2 | True | True | 84507 | 75136 | 1101 | 75.0 | 0/0 |
| confirmation-high:pydata__xarray-7393:high:3 | True | True | 418977 | 384128 | 2208 | 173.3 | 0/0 |
| confirmation-baseline:django__django-14500:jev:3 | True | True | 225233 | 198016 | 1403 | 109.6 | 0/0 |
| confirmation-high:sympy__sympy-16450:high:1 | True | True | 109397 | 95360 | 1469 | 83.3 | 0/0 |
| confirmation-candidate:sympy__sympy-16450:jev:1 | False | True | 18256 | 15104 | 163 | 25.0 | 0/0 |
| confirmation-candidate:pytest-dev__pytest-5262:jev:1 | True | True | 230361 | 190592 | 1698 | 134.9 | 0/0 |
| confirmation-candidate:django__django-14500:jev:2 | True | True | 195894 | 172544 | 1448 | 114.4 | 0/0 |
| confirmation-baseline:django__django-14500:jev:1 | True | True | 166571 | 151808 | 1172 | 91.5 | 0/0 |
| confirmation-candidate:psf__requests-2931:jev:1 | True | True | 229558 | 193024 | 1311 | 100.7 | 0/0 |
| confirmation-baseline:pytest-dev__pytest-5262:jev:1 | True | True | 147158 | 136704 | 1464 | 112.4 | 0/0 |
| confirmation-baseline:sympy__sympy-16450:jev:2 | True | True | 51140 | 44160 | 889 | 68.9 | 0/0 |
| confirmation-candidate:pydata__xarray-7393:jev:3 | True | True | 292382 | 269184 | 1783 | 148.0 | 0/0 |
| confirmation-high:sympy__sympy-16450:high:3 | True | True | 130344 | 110464 | 1451 | 89.4 | 0/0 |
| confirmation-baseline:django__django-14500:jev:2 | True | True | 229338 | 209280 | 1415 | 116.8 | 0/0 |
| confirmation-baseline:pytest-dev__pytest-5262:jev:2 | True | True | 84364 | 75392 | 860 | 65.8 | 0/0 |
| confirmation-high:psf__requests-2931:high:3 | True | True | 258271 | 230528 | 1698 | 105.1 | 0/0 |
| confirmation-candidate:scikit-learn__scikit-learn-26194:jev:2 | True | False | None | None | None | 137.3 | 0/0 |
| confirmation-baseline:sympy__sympy-16450:jev:1 | True | True | 101464 | 78464 | 1117 | 96.5 | 0/0 |
| confirmation-baseline:pydata__xarray-7393:jev:1 | True | True | 354029 | 309120 | 1904 | 201.9 | 0/0 |
| confirmation-high:pydata__xarray-7393:high:2 | True | True | 445682 | 418944 | 2393 | 174.4 | 0/0 |
| confirmation-baseline:psf__requests-2931:jev:3 | True | True | 179858 | 158336 | 1366 | 89.0 | 0/0 |
| confirmation-candidate:pytest-dev__pytest-5262:jev:3 | True | True | 207474 | 175360 | 1368 | 120.5 | 0/0 |
| confirmation-high:scikit-learn__scikit-learn-26194:high:1 | True | True | 247746 | 197376 | 2329 | 121.2 | 0/0 |
| confirmation-high:django__django-14500:high:1 | True | True | 266723 | 248576 | 1429 | 106.0 | 0/0 |
| confirmation-candidate:psf__requests-2931:jev:2 | True | True | 192719 | 167168 | 1416 | 100.7 | 0/0 |
| confirmation-candidate:django__django-14500:jev:3 | True | True | 165578 | 150400 | 1030 | 100.1 | 0/0 |
| confirmation-baseline:scikit-learn__scikit-learn-26194:jev:3 | True | True | 192926 | 167552 | 2076 | 117.4 | 0/0 |
| confirmation-candidate:sympy__sympy-16450:jev:2 | True | True | 94593 | 78336 | 947 | 113.0 | 0/0 |
| confirmation-candidate:pydata__xarray-7393:jev:1 | True | True | 519182 | 483456 | 2615 | 217.0 | 0/0 |
| confirmation-candidate:scikit-learn__scikit-learn-26194:jev:3 | True | True | 156640 | 132608 | 1872 | 116.8 | 0/0 |
| confirmation-candidate:psf__requests-2931:jev:3 | True | False | None | None | None | 98.5 | 0/0 |
| confirmation-baseline:pytest-dev__pytest-5262:jev:3 | True | True | 104546 | 94976 | 980 | 74.2 | 0/0 |
| confirmation-high:pytest-dev__pytest-5262:high:2 | True | True | 289063 | 253696 | 1863 | 141.8 | 0/0 |
| confirmation-high:pytest-dev__pytest-5262:high:1 | True | True | 144105 | 118272 | 1484 | 89.8 | 0/0 |
| confirmation-baseline:psf__requests-2931:jev:1 | True | True | 236928 | 195968 | 1369 | 111.3 | 0/0 |
| confirmation-high:psf__requests-2931:high:2 | True | True | 129270 | 110208 | 1387 | 83.6 | 0/0 |
| confirmation-candidate:django__django-14500:jev:1 | True | True | 193074 | 174976 | 1447 | 122.5 | 0/0 |
| confirmation-baseline:scikit-learn__scikit-learn-26194:jev:2 | True | True | 241581 | 200448 | 2135 | 121.6 | 0/0 |
| confirmation-baseline:pydata__xarray-7393:jev:2 | True | True | 411051 | 356736 | 2205 | 173.9 | 0/0 |
| confirmation-candidate:sympy__sympy-16450:jev:3 | True | True | 95940 | 73472 | 1092 | 102.0 | 0/0 |
| confirmation-high:psf__requests-2931:high:1 | True | True | 245763 | 222464 | 1424 | 98.7 | 0/0 |
| confirmation-high:django__django-14500:high:3 | True | True | 184530 | 158592 | 1402 | 100.2 | 0/0 |
| confirmation-high:scikit-learn__scikit-learn-26194:high:3 | True | True | 136515 | 108800 | 1836 | 96.7 | 0/0 |
| confirmation-high:pytest-dev__pytest-5262:high:3 | True | True | 201575 | 175616 | 1571 | 99.4 | 0/0 |
| confirmation-high:sympy__sympy-16450:high:2 | True | True | 182900 | 161280 | 1783 | 123.1 | 0/0 |
| confirmation-baseline:scikit-learn__scikit-learn-26194:jev:1 | True | True | 161135 | 144512 | 2094 | 114.0 | 0/0 |
| confirmation-candidate:pydata__xarray-7393:jev:2 | True | True | 349514 | 307456 | 1928 | 152.3 | 0/0 |
| confirmation-baseline:pydata__xarray-7393:jev:3 | True | True | 465834 | 430464 | 2395 | 167.3 | 0/0 |
| confirmation-candidate:scikit-learn__scikit-learn-26194:jev:1 | True | True | 170499 | 139264 | 2277 | 127.0 | 0/0 |
| confirmation-high:django__django-14500:high:2 | True | True | 194347 | 180736 | 1473 | 101.7 | 0/0 |
| confirmation-candidate:pytest-dev__pytest-5262:jev:5 | True | True | 112679 | 96256 | 1358 | 85.0 | 0/0 |
| confirmation-high:sympy__sympy-16450:high:4 | True | True | 126246 | 102528 | 1400 | 104.9 | 0/0 |
| confirmation-high:pydata__xarray-7393:high:5 | True | True | 451068 | 424192 | 2663 | 176.7 | 0/0 |
| confirmation-candidate:django__django-14500:jev:4 | True | True | 268413 | 249088 | 1457 | 126.4 | 0/0 |
| confirmation-high:psf__requests-2931:high:5 | True | True | 186448 | 161920 | 1402 | 84.7 | 0/0 |
| confirmation-high:pytest-dev__pytest-5262:high:6 | True | True | 360545 | 317056 | 2338 | 175.9 | 0/0 |
| confirmation-candidate:psf__requests-2931:jev:6 | True | True | 136778 | 112256 | 1332 | 84.3 | 0/0 |
| confirmation-high:psf__requests-2931:high:6 | True | True | 229150 | 207616 | 1496 | 89.9 | 0/0 |
| confirmation-high:scikit-learn__scikit-learn-26194:high:6 | True | True | 166675 | 137856 | 2249 | 112.1 | 0/0 |
| confirmation-baseline:sympy__sympy-16450:jev:6 | True | True | 50402 | 39680 | 934 | 70.6 | 0/0 |
| confirmation-baseline:scikit-learn__scikit-learn-26194:jev:6 | True | True | 133616 | 109312 | 1990 | 105.7 | 0/0 |
| confirmation-baseline:django__django-14500:jev:5 | True | True | 164465 | 150400 | 1109 | 91.2 | 0/0 |
| confirmation-high:scikit-learn__scikit-learn-26194:high:4 | True | True | 169572 | 134144 | 2146 | 108.7 | 0/0 |
| confirmation-high:pytest-dev__pytest-5262:high:5 | True | True | 248049 | 215168 | 2073 | 137.2 | 0/0 |
| confirmation-candidate:django__django-14500:jev:6 | True | True | 166784 | 152704 | 1123 | 93.9 | 0/0 |
| confirmation-high:sympy__sympy-16450:high:6 | True | True | 89989 | 80512 | 1155 | 73.9 | 0/0 |
| confirmation-high:django__django-14500:high:5 | True | True | 223610 | 206592 | 1416 | 107.6 | 0/0 |
| confirmation-high:scikit-learn__scikit-learn-26194:high:5 | True | True | 266420 | 220672 | 2583 | 134.0 | 0/0 |
| confirmation-candidate:psf__requests-2931:jev:4 | True | True | 147061 | 124544 | 1286 | 71.1 | 0/0 |
| confirmation-candidate:sympy__sympy-16450:jev:5 | True | True | 111265 | 81792 | 1117 | 98.9 | 0/0 |
| confirmation-baseline:pydata__xarray-7393:jev:4 | True | True | 358826 | 323456 | 2172 | 178.7 | 0/0 |
| confirmation-high:pytest-dev__pytest-5262:high:4 | True | True | 299567 | 252416 | 2120 | 163.1 | 0/0 |
| confirmation-candidate:pytest-dev__pytest-5262:jev:6 | True | True | 216629 | 177536 | 1501 | 127.8 | 0/0 |
| confirmation-candidate:scikit-learn__scikit-learn-26194:jev:6 | True | True | 220854 | 190848 | 2335 | 125.8 | 0/0 |
| confirmation-high:django__django-14500:high:6 | True | True | 201565 | 170240 | 1402 | 105.6 | 0/0 |
| confirmation-candidate:sympy__sympy-16450:jev:6 | True | True | 65967 | 55424 | 1018 | 70.5 | 0/0 |
| confirmation-high:pydata__xarray-7393:high:6 | True | True | 414764 | 370560 | 2220 | 169.8 | 0/0 |
| confirmation-baseline:psf__requests-2931:jev:4 | True | True | 226426 | 182912 | 1408 | 98.9 | 0/0 |
| confirmation-candidate:pydata__xarray-7393:jev:6 | True | True | 501743 | 472576 | 2195 | 195.3 | 0/0 |
| confirmation-baseline:scikit-learn__scikit-learn-26194:jev:5 | True | True | 135425 | 106496 | 1906 | 126.5 | 0/0 |
| confirmation-high:sympy__sympy-16450:high:5 | True | True | 115527 | 90752 | 1154 | 97.1 | 0/0 |
| confirmation-candidate:psf__requests-2931:jev:5 | True | True | 165549 | 143616 | 1346 | 86.7 | 0/0 |
| confirmation-baseline:sympy__sympy-16450:jev:4 | True | True | 50918 | 39552 | 861 | 60.8 | 0/0 |
| confirmation-baseline:sympy__sympy-16450:jev:5 | True | True | 95789 | 77696 | 1022 | 98.8 | 0/0 |
| confirmation-high:pydata__xarray-7393:high:4 | True | True | 408984 | 379648 | 2293 | 152.5 | 0/0 |
| confirmation-baseline:psf__requests-2931:jev:5 | True | True | 175424 | 151936 | 1507 | 83.1 | 0/0 |
| confirmation-baseline:pytest-dev__pytest-5262:jev:5 | True | True | 83149 | 69248 | 935 | 66.3 | 0/0 |
| confirmation-high:django__django-14500:high:4 | True | True | 192933 | 170624 | 1449 | 109.9 | 0/0 |
| confirmation-candidate:scikit-learn__scikit-learn-26194:jev:5 | True | True | 149562 | 122880 | 2145 | 121.1 | 0/0 |
| confirmation-candidate:scikit-learn__scikit-learn-26194:jev:4 | True | True | 133854 | 108672 | 2101 | 111.7 | 0/0 |
| confirmation-baseline:pydata__xarray-7393:jev:6 | True | True | 331055 | 305408 | 2038 | 188.1 | 0/0 |
| confirmation-high:psf__requests-2931:high:4 | True | True | 204969 | 178432 | 1587 | 88.0 | 0/0 |
| confirmation-baseline:pydata__xarray-7393:jev:5 | True | True | 365389 | 323968 | 2521 | 190.5 | 0/0 |
| confirmation-candidate:django__django-14500:jev:5 | True | True | 198308 | 175616 | 1392 | 120.5 | 0/0 |
| confirmation-baseline:scikit-learn__scikit-learn-26194:jev:4 | True | True | 142522 | 117248 | 1948 | 129.3 | 0/0 |
| confirmation-baseline:psf__requests-2931:jev:6 | True | True | 170046 | 146944 | 1512 | 98.2 | 0/0 |
| confirmation-baseline:django__django-14500:jev:6 | True | True | 142359 | 125184 | 1133 | 94.6 | 0/0 |
| confirmation-candidate:sympy__sympy-16450:jev:4 | True | True | 70390 | 58752 | 1029 | 72.1 | 0/0 |
| confirmation-candidate:pydata__xarray-7393:jev:5 | True | True | 303521 | 263552 | 1990 | 162.8 | 0/0 |
| confirmation-candidate:pydata__xarray-7393:jev:4 | True | True | 270312 | 246912 | 1612 | 156.9 | 0/0 |
| confirmation-baseline:pytest-dev__pytest-5262:jev:6 | True | True | 145826 | 125056 | 1629 | 99.5 | 0/0 |
| confirmation-baseline:pytest-dev__pytest-5262:jev:4 | True | True | 84232 | 66176 | 801 | 65.3 | 0/0 |
| confirmation-candidate:pytest-dev__pytest-5262:jev:4 | True | True | 74798 | 55680 | 1105 | 75.2 | 0/0 |
| confirmation-baseline:django__django-14500:jev:4 | True | True | 200116 | 176768 | 1444 | 118.0 | 0/0 |

Started without completed metadata: 0. See ledger for abort/incomplete reasons.

This is a pilot; no equivalence inference from small samples. Cache input is included in input usage. Usage means exclude invalid evidence, but initiated failures remain in success denominators. Agent latency includes routing; the decision event log in each raw attempt records per-call Jev latency.
