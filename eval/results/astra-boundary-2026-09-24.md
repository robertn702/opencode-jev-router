# Astra effort-boundary search

## Outcome

The five-candidate search did **not** establish the requested reliable medium-versus-higher-effort boundary. There were 20 screening attempts and 20 fresh confirmation attempts, with no replacements. All five candidates passed base-fails/reference-passes preflight. One SymPy xhigh screen timed out; the other 39 attempts were graded with valid usage evidence.

The exploratory Sphinx #7590 confirmation resolved medium **0/5**, high **0/5**, xhigh **0/5**, and strict Jev **2/5**. Every Jev attempt had zero fallback events and zero terminal classification errors. The two router successes are interesting, but five attempts do not establish a router advantage, and the fixed high/xhigh baselines were not reliably successful. This is not evidence of equal-quality savings.

Across all five attempts per arm, Jev used **6.2% more output tokens and 11.2% more time than high**; versus xhigh, it used **36.1% fewer output tokens and 5.1% less time**. These compare different quality outcomes, not equivalent successful solutions. Full input/cache/output means and all attempt IDs follow. The search stopped at the five-candidate budget; no further workers are queued.

## Protocol

Run set: `astra-boundary-2026-09-24`. Dataset revision: `78f471bf655a3137b2e8a75af1501690ec009ec3`. Candidate order: sympy__sympy-13878, sphinx-doc__sphinx-7590, scikit-learn__scikit-learn-25102, sphinx-doc__sphinx-11510, pytest-dev__pytest-6197.

Predeclared screen: medium 0/2 and xhigh 2/2, with all four runs graded and evidence-valid. Qualifying cases receive five fresh attempts per arm. Confirmation: medium at most 1/5, and high or xhigh at least 4/5, with all 20 runs graded and evidence-valid. Stop after the first confirmed fixed-effort boundary, independent of whether Jev wins, or after five candidates. Failed preflight consumes a candidate slot.

At most two concurrent attempts, 15-minute agent cap. Screen orders: medium/xhigh, xhigh/medium. Full orders rotate across rounds. Strict Jev: three additional retries, 10-second total deadline, fallback disabled. No replacements; screen attempts are excluded from confirmation. Independent base/reference preflight is required. Raw prompts, patches and logs remain ignored.

After all five screens failed the strict qualification rule, Sphinx #7590 (medium 0/2, xhigh 1/2) was selected for an exploratory full matrix as the strongest observed fixed-effort contrast. This is a disclosed post-screen extension on an existing candidate, not a sixth candidate or a qualified screen. The full confirmation threshold is unchanged.

## sympy__sympy-13878

Status: screen did not qualify

### screen

| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 1/2 | 2 | 2 | 126.6 | 128789.0 | 112192.0 | 2620.5 |
| xhigh | 1/2 | 1 | 1 | 874.6 | 1144966.0 | 1075968.0 | 9356.0 |

| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |
| --- | --- | --- | --- | ---: | ---: |
| sympy__sympy-13878-gpt-6-astra-medium-1f04df1e-c41c-4a69-b7e2-eb279ae09802 | False | True | False | 0 | 0 |
| sympy__sympy-13878-gpt-6-astra-xhigh-f37eb008-c39c-4ae9-9906-87cd4ad7a0c0 | None | False | True | 0 | 0 |
| sympy__sympy-13878-gpt-6-astra-xhigh-c49ceb50-2bf1-4fb4-a653-4d7f48da26ee | True | True | False | 0 | 0 |
| sympy__sympy-13878-gpt-6-astra-medium-a2fc61b0-e28f-400d-94b6-6e8c04124fac | True | True | False | 0 | 0 |

## sphinx-doc__sphinx-7590

Status: exploratory full matrix: inconclusive

### screen

| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 0/2 | 2 | 2 | 99.5 | 138819.5 | 120832.0 | 1655.5 |
| xhigh | 1/2 | 2 | 2 | 284.5 | 628557.5 | 572032.0 | 6852.0 |

| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |
| --- | --- | --- | --- | ---: | ---: |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-6a36ed40-0e18-4d96-ab1e-4fe67ab8f75a | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-e93ce56d-f313-4f5c-8cc2-3cdb74175cf2 | True | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-c98e12d1-0c44-47c2-9fff-cb8574b23d21 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-abbbc0c4-7862-45fa-a0b8-222140b36586 | False | True | False | 0 | 0 |

### full

| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 0/5 | 5 | 5 | 99.4 | 112365.2 | 94336.0 | 1550.4 |
| high | 0/5 | 5 | 5 | 271.7 | 600586.8 | 556467.2 | 4090.8 |
| xhigh | 0/5 | 5 | 5 | 318.3 | 822392.8 | 759219.2 | 6804.2 |
| jev | 2/5 | 5 | 5 | 302.1 | 631532.4 | 583910.4 | 4344.8 |

| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |
| --- | --- | --- | --- | ---: | ---: |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-01236bdc-ff8c-4a41-b419-3c3e794a4449 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-high-4bb082c1-e364-4ed0-ac01-e58d32e6fcde | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-20dd916f-70d8-4d61-b4bc-dccebc41feb8 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-jev-79c53a0c-9458-46ce-b6e6-c2450afd195b | True | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-jev-3826138c-a89c-4210-8f41-dfd364de6be4 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-fa5f80e9-9bc7-411c-b3f6-fbe07440dd87 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-high-50c446fd-4f10-49ba-9fa4-e39e12ce745d | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-29fcedb2-d4f0-47bc-b739-0db96ad1f638 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-high-390c670e-823d-4219-a3fd-a39ea97245b9 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-jev-96fe0d97-4be3-4cb3-b239-8d0f9dd8dc69 | True | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-b29e2aad-636b-4224-8519-b60cc3637496 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-e8da86ec-93d1-4cb1-993d-2724bdcbf35f | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-e178a7af-8e3a-48c5-82ed-2db46128a6a8 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-0c4f217f-02a4-4a64-beb5-2fea371a5f5a | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-jev-8696da9e-2fce-4ca0-9ed0-ec24418ebb8f | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-high-d8087def-c9a1-4904-9596-c2910dde6e22 | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-medium-0941ae27-fd84-47ac-91a5-628ec8727c2b | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-jev-02cb6ed7-e0da-4aed-a580-3801c58b1eac | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-high-a603b243-ea5b-4246-bc73-471ba124188e | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-7590-gpt-6-astra-xhigh-b60b37a7-f280-4e91-983f-b499ce5c9b78 | False | True | False | 0 | 0 |

## scikit-learn__scikit-learn-25102

Status: screen did not qualify

### screen

| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 2/2 | 2 | 2 | 84.2 | 137409.0 | 115712.0 | 1357.5 |
| xhigh | 1/2 | 2 | 2 | 249.9 | 430986.5 | 377472.0 | 4077.5 |

| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |
| --- | --- | --- | --- | ---: | ---: |
| scikit-learn__scikit-learn-25102-gpt-6-astra-medium-20a11f78-7ee2-4bce-bf3c-ac49a7164b90 | True | True | False | 0 | 0 |
| scikit-learn__scikit-learn-25102-gpt-6-astra-xhigh-033be741-d719-4812-aaf3-cae87eba0da0 | True | True | False | 0 | 0 |
| scikit-learn__scikit-learn-25102-gpt-6-astra-xhigh-32effe56-f6ab-434d-81aa-6aeabf201b4b | False | True | False | 0 | 0 |
| scikit-learn__scikit-learn-25102-gpt-6-astra-medium-a6e4b066-415c-4983-b61e-62ae54589201 | True | True | False | 0 | 0 |

## sphinx-doc__sphinx-11510

Status: screen did not qualify

### screen

| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 0/2 | 2 | 2 | 97.5 | 149084.5 | 119232.0 | 1694.0 |
| xhigh | 0/2 | 2 | 2 | 65.0 | 113180.5 | 83840.0 | 1082.0 |

| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |
| --- | --- | --- | --- | ---: | ---: |
| sphinx-doc__sphinx-11510-gpt-6-astra-medium-3afedc7b-a848-4bc5-8f12-4a158e5ec39f | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-11510-gpt-6-astra-xhigh-8adf5760-31e9-4008-99a2-de3b4ef85c7b | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-11510-gpt-6-astra-xhigh-219f39c6-fac5-4e6a-9f61-9762f9e41eff | False | True | False | 0 | 0 |
| sphinx-doc__sphinx-11510-gpt-6-astra-medium-52156959-21bc-4b48-80bc-ef37d22f3acc | False | True | False | 0 | 0 |

## pytest-dev__pytest-6197

Status: screen did not qualify

### screen

| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| medium | 2/2 | 2 | 2 | 116.0 | 160802.0 | 139136.0 | 1099.5 |
| xhigh | 2/2 | 2 | 2 | 352.4 | 946642.0 | 893312.0 | 5952.5 |

| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |
| --- | --- | --- | --- | ---: | ---: |
| pytest-dev__pytest-6197-gpt-6-astra-medium-88f43744-08a0-4c0d-9209-7ff2974e1b1f | True | True | False | 0 | 0 |
| pytest-dev__pytest-6197-gpt-6-astra-xhigh-0dbccb6b-84ea-4f35-900f-207b7b360ec5 | True | True | False | 0 | 0 |
| pytest-dev__pytest-6197-gpt-6-astra-xhigh-40c3e16a-29fd-401e-b53a-2a87190cec48 | True | True | False | 0 | 0 |
| pytest-dev__pytest-6197-gpt-6-astra-medium-85b1ff17-1fea-4e5f-87c7-c0c8751dd7ec | True | True | False | 0 | 0 |

## Interpretation limits

This deliberately selects effort-sensitive cases and cannot estimate broad workload savings. Five attempts per arm provide limited precision. Token means require valid evidence; elapsed time includes initiated failures. Cached input is part of input, not additional consumption. Output includes reasoning and auxiliary calls. Concurrent execution and shared upstream/host activity affect latency. A classification failure is an incomplete delivery, not a wrong patch.
