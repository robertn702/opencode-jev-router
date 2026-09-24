# Astra pytest #5787: fallback-free confirmation

Run set: `astra-strict-2026-09-24`. Five fresh attempts per arm; two concurrent attempts, rotated arm order. Base-fails/reference-passes preflight passed before execution.

Jev: three additional retries, 10-second total classification deadline, fallback disabled. All initiated attempts are retained, with no replacement runs. Historical fallback-enabled attempts are excluded.

| Arm | Solved / initiated | Graded | Evidence valid | Mean agent seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 4/5 | 5 | 5/5 | 113.1 | 126506.6 | 108723.2 | 2035.4 |
| high | 5/5 | 5 | 5/5 | 228.4 | 407752.2 | 369408.0 | 4238.0 |
| xhigh | 4/5 | 5 | 5/5 | 284.0 | 652298.6 | 599731.2 | 5746.4 |
| jev | 5/5 | 5 | 5/5 | 247.8 | 411644.6 | 373708.8 | 4149.0 |

Time means include incomplete attempts; usage means include only evidence-valid attempts. Compare denominators before interpreting savings. Cached input is a subset of input, not an additional token category. Output includes reasoning and auxiliary requests. These are consumption measurements, not dollar-cost estimates.

## Individual attempts

| Round | Arm | Solved | Agent error | Classification errors | Timeout | Grader error | Evidence valid | Seconds | Output | Extra classification attempts | Run ID |
| --- | --- | --- | --- | ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| r1 | high | True | False | 0 | False | False | True | 215.6 | 4344 | 0 | pytest-dev__pytest-5787-gpt-6-astra-high-3996ce5d-bfe4-4e94-848d-c8f2c789eb86 |
| r1 | jev | True | False | 0 | False | False | True | 253.8 | 4267 | 5 | pytest-dev__pytest-5787-gpt-6-astra-jev-12d7376d-d7eb-4ba1-8aca-fff06eb487d3 |
| r1 | medium | True | False | 0 | False | False | True | 111.4 | 2216 | 0 | pytest-dev__pytest-5787-gpt-6-astra-medium-1bdcd4be-a95b-46e9-bc84-245622777006 |
| r1 | xhigh | False | False | 0 | False | False | True | 64.2 | 1190 | 0 | pytest-dev__pytest-5787-gpt-6-astra-xhigh-da7be223-ecdf-4192-98f7-aa213632b8c0 |
| r2 | high | True | False | 0 | False | False | True | 224.6 | 4302 | 0 | pytest-dev__pytest-5787-gpt-6-astra-high-8067897f-c979-4612-af35-bff37ea3d384 |
| r2 | jev | True | False | 0 | False | False | True | 232.0 | 4042 | 3 | pytest-dev__pytest-5787-gpt-6-astra-jev-df7b5db9-67ee-4dec-8a98-2a7f6e35edfd |
| r2 | medium | False | False | 0 | False | False | True | 131.3 | 2442 | 0 | pytest-dev__pytest-5787-gpt-6-astra-medium-3128bd3b-b184-4e38-8703-19be3234eb92 |
| r2 | xhigh | True | False | 0 | False | False | True | 402.2 | 7597 | 0 | pytest-dev__pytest-5787-gpt-6-astra-xhigh-18cc891c-cce3-4f9d-bcdc-260ebc9be6d9 |
| r3 | high | True | False | 0 | False | False | True | 222.3 | 3602 | 0 | pytest-dev__pytest-5787-gpt-6-astra-high-d0073b06-325c-4445-b112-cb210038b336 |
| r3 | jev | True | False | 0 | False | False | True | 258.0 | 3886 | 3 | pytest-dev__pytest-5787-gpt-6-astra-jev-8215d14a-2009-42c8-a491-7973eb40141a |
| r3 | medium | True | False | 0 | False | False | True | 107.4 | 2070 | 0 | pytest-dev__pytest-5787-gpt-6-astra-medium-10a7c0b0-4389-4b70-bdbd-b03da1fab867 |
| r3 | xhigh | True | False | 0 | False | False | True | 335.9 | 7092 | 0 | pytest-dev__pytest-5787-gpt-6-astra-xhigh-c5467822-1c6e-4baa-85f6-0ea3fc49df6a |
| r4 | high | True | False | 0 | False | False | True | 258.7 | 4580 | 0 | pytest-dev__pytest-5787-gpt-6-astra-high-963cfeb5-ecc8-4825-9184-5f6efc6ce15c |
| r4 | jev | True | False | 0 | False | False | True | 239.6 | 4336 | 1 | pytest-dev__pytest-5787-gpt-6-astra-jev-18c5efeb-4179-4d9d-84da-7607da713411 |
| r4 | medium | True | False | 0 | False | False | True | 119.1 | 1663 | 0 | pytest-dev__pytest-5787-gpt-6-astra-medium-9c6fe959-8889-4677-98a0-4c87279c7011 |
| r4 | xhigh | True | False | 0 | False | False | True | 322.8 | 6319 | 0 | pytest-dev__pytest-5787-gpt-6-astra-xhigh-7f586929-79d7-4507-b6c2-ab426e0b1902 |
| r5 | high | True | False | 0 | False | False | True | 220.9 | 4362 | 0 | pytest-dev__pytest-5787-gpt-6-astra-high-81e3f848-b429-4f50-a08c-20df24453436 |
| r5 | jev | True | False | 0 | False | False | True | 255.3 | 4214 | 4 | pytest-dev__pytest-5787-gpt-6-astra-jev-8b9aa1ab-1ccf-43fe-bd93-abbf3ddff96a |
| r5 | medium | True | False | 0 | False | False | True | 96.5 | 1786 | 0 | pytest-dev__pytest-5787-gpt-6-astra-medium-2043f3d1-df2f-479a-a382-e2e5c77a15cc |
| r5 | xhigh | True | False | 0 | False | False | True | 295.2 | 6534 | 0 | pytest-dev__pytest-5787-gpt-6-astra-xhigh-551899e5-77f1-40fb-a7ce-81150cd15933 |

## Routing

Fallback events: **0**. Additional classification attempts: **16**.

Recorded effort counts: low 8, medium 33, high 84, xhigh 0, max 0.

## Comparisons

Jev versus high, all five attempts per arm: time +8.5%, input tokens +1.0%, output tokens -2.1% (negative means reduction).

Jev versus xhigh, all five attempts per arm: time -12.8%, input tokens -36.9%, output tokens -27.8% (negative means reduction).

The strict router solved 5/5 without fallback, so these successes were not rescued by fallback-to-high. Against high, the small output-token reduction did not produce a speed gain. Medium solved 4/5, versus 1/5 historically: the previously observed sharp effort boundary did not reproduce. Xhigh's aggregate includes one short failed attempt; it is not a matched-success comparison. These fresh results do not explain whether historical outcomes were caused by fallback.

## Provenance

Router commit: `dcdfd9012712e83abf9380f0a6c4a2a5e0993ebd`. Node `v24.21.0`; OpenCode `1.18.32`. Task base: `955e54221008aba577ecbaefa15679f6777d3bf8`. Dataset revision: `78f471bf655a3137b2e8a75af1501690ec009ec3`, checked using `eval/swebench-astra.sha256`. Jev endpoint: Vercel Gateway; generation upstream: local CLIProxyAPI. Agent cap: 15 minutes. Agent time excludes independent grading, but includes classification and retries.

Schedule by round: r1: medium, high, xhigh, jev; r2: jev, xhigh, high, medium; r3: high, jev, medium, xhigh; r4: xhigh, medium, jev, high; r5: medium, jev, high, xhigh. At most two attempts were active, with queued attempts starting as slots became free.

## Scope

This is a fresh confirmation on one task selected from earlier exploratory results, not a representative benchmark. Five attempts per arm do not establish equal success probabilities. Two concurrent runs and other host/upstream activity can affect latency. No causal claim is made about the effort required by an individual step. Raw evidence stays in ignored eval/runs/.
