# SWE-bench Verified pilot results

Dataset: `SWE-bench/SWE-bench_Verified` revision `78f471bf655a3137b2e8a75af1501690ec009ec3`.
Run set: `gateway-pilot-2026-09-23`. One short and one harder selected case; this is not a representative benchmark score. Only compare token totals when evidence is valid.

| Task | Model | Arm | Graded | Grader error | Evidence valid | Time (s) | Requests | Auxiliary requests | Selected efforts | Fallbacks | Input tokens | Cached input | Output tokens | Run ID |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| django__django-15957 | gpt-6-astra | high | true | false | true | 221 | 32 | 1 | high:32 | 0 | 453551 | 404480 | 4000 | django__django-15957-gpt-6-astra-high-5f4028e9-a974-4e69-a363-9742bddbfb60 |
| django__django-15957 | gpt-6-astra | jev | true | false | true | 232 | 31 | 1 | medium:5, high:21, low:5 | 4 | 447899 | 402688 | 3719 | django__django-15957-gpt-6-astra-jev-86d647a2-ab17-4c8a-9065-2fd3d3eee31d |
| django__django-15957 | gpt-6-astra | medium | true | false | true | 165 | 28 | 1 | medium:28 | 0 | 302190 | 282624 | 2905 | django__django-15957-gpt-6-astra-medium-a7a2b62d-2e55-48c2-ae50-6fc1b04c59a7 |
| django__django-15957 | gpt-6-sol | high | false | false | true | 120 | 15 | 1 | high:15 | 0 | 387127 | 349440 | 3945 | django__django-15957-gpt-6-sol-high-6537c7eb-d044-4e35-9e8f-59ee8956ae7d |
| django__django-15957 | gpt-6-sol | jev | true | false | true | 223 | 31 | 1 | high:25, medium:5, low:1 | 3 | 733474 | 692480 | 6068 | django__django-15957-gpt-6-sol-jev-dce3cd20-357a-4162-bded-f89fede92faf |
| django__django-15957 | gpt-6-sol | medium | false | false | true | 101 | 14 | 1 | medium:14 | 0 | 238478 | 212352 | 2975 | django__django-15957-gpt-6-sol-medium-594b8a4b-b5ef-4ab0-b6e1-2db39a3e875b |
| pallets__flask-5014 | gpt-6-astra | high | true | false | true | 126 | 18 | 1 | high:18 | 0 | 383217 | 332928 | 1430 | pallets__flask-5014-gpt-6-astra-high-d8077c6d-3f65-40f3-870b-76d5c7c1106c |
| pallets__flask-5014 | gpt-6-astra | jev | true | false | true | 65 | 12 | 1 | medium:9, low:3 | 1 | 77636 | 62336 | 687 | pallets__flask-5014-gpt-6-astra-jev-1dccb0f0-89a4-4bad-89ba-ed8e0f7e02a0 |
| pallets__flask-5014 | gpt-6-astra | medium | true | false | true | 44 | 9 | 1 | medium:9 | 0 | 56221 | 46336 | 425 | pallets__flask-5014-gpt-6-astra-medium-be00310f-96aa-40b4-a37a-f1465aed9b9e |
| pallets__flask-5014 | gpt-6-sol | high | true | false | true | 47 | 9 | 1 | high:9 | 0 | 79747 | 70784 | 979 | pallets__flask-5014-gpt-6-sol-high-5491e75c-76f9-4ef8-a385-f8a2641ff690 |
| pallets__flask-5014 | gpt-6-sol | jev | true | false | true | 42 | 8 | 1 | medium:7, low:1 | 1 | 59098 | 47744 | 794 | pallets__flask-5014-gpt-6-sol-jev-95626a32-c0f2-42ac-b946-359e3a8e7bd6 |
| pallets__flask-5014 | gpt-6-sol | medium | true | false | true | 48 | 9 | 1 | medium:9 | 0 | 93269 | 73856 | 1012 | pallets__flask-5014-gpt-6-sol-medium-2931288f-0cb9-418a-a97d-1d2f1c463f5e |

## Reading this pilot

Resolved: 10/12 attempts; adaptive arm: 4/4.
Adaptive selected-effort events: medium 26, high 46, low 10; fallback events: 9. Fallback efforts are included in the displayed effort counts.
Each arm used one fresh attempt per task/model. Differences in solution path and run length confound token and time comparisons; these two tasks cannot establish a general saving or success-rate advantage.
Raw OpenCode events, grader logs, and patches remain in ignored local run directories; only metadata is published here.
