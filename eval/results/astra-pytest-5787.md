# Astra effort comparison: pytest #5787

SWE-bench Verified `pytest-dev__pytest-5787`, dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`; five fresh attempts per arm at the same pinned base commit and grader. The first two medium and xhigh attempts were the selection spike. This task was selected after observing a medium/xhigh difference, so these results are exploratory, not an unbiased benchmark estimate.

## Selection spike

Both candidates passed base-fails/reference-passes grading preflight. Astra solved `django__django-14631` 2/2 at medium and 2/2 at xhigh; it solved `pytest-dev__pytest-5787` 1/2 at medium and 2/2 at xhigh. Only pytest was expanded.

## Selected task: pass@5


| Arm | Resolved | Evidence valid | Mean agent time (s) | Mean upstream output tokens | Mean agent-step output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium | 1/5 | 5/5 | 132.341 | 2649 | 2598 |
| high | 5/5 | 5/5 | 239.836 | 4113 | 4039 |
| xhigh | 5/5 | 5/5 | 336.692 | 7029 | 6941 |
| jev | 5/5 | 5/5 | 218.259 | 3916 | 3819 |

Jev effort decisions across 5 evidence-valid attempts: high 92, medium 20, low 15. Fallbacks: 7.

Each attempt's grader outcome is separate from usage-evidence validity. Upstream totals include the one logged auxiliary request; agent-step totals exclude it. Output tokens include reasoning tokens; times and tokens depend on solution path and do not establish dollar cost. Raw prompts, patches, traces, and grader logs remain in ignored `eval/runs/`.
