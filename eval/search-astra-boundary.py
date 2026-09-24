"""Bounded, predeclared search; prepare once, then run without replacing failures.

python eval/search-astra-boundary.py prepare|run UNIQUE_RUN_SET
Requires Node 24, built plugin, Docker and canonical eval credentials.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
IDS = ['sympy__sympy-13878', 'sphinx-doc__sphinx-7590', 'scikit-learn__scikit-learn-25102', 'sphinx-doc__sphinx-11510', 'pytest-dev__pytest-6197']
REVISION = '78f471bf655a3137b2e8a75af1501690ec009ec3'
mode, name = sys.argv[1:]
assert mode in ['prepare', 'run', 'supplementary'] and name and all(c.isalnum() or c in '-_' for c in name)
directory = ROOT / 'runs' / name
if mode == 'prepare':
    from datasets import load_dataset
    directory.mkdir()
    source = load_dataset('SWE-bench/SWE-bench_Verified', split='test', revision=REVISION)
    rows = [next(r for r in source if r['instance_id'] == id_) for id_ in IDS]
    contents = json.dumps(rows, ensure_ascii=False) + '\n'
    (directory / 'dataset.json').write_text(contents)
    (ROOT / 'swebench-boundary.sha256').write_text(hashlib.sha256(contents.encode()).hexdigest() + '\n')
    tasks = [{'id': r['instance_id'], 'repo': f"https://github.com/{r['repo']}.git", 'commit': r['base_commit'], 'grade': 'swebench', 'agentTimeoutMinutes': 15, 'prompt': r['problem_statement'].replace('\r\n', '\n')} for r in rows]
    (directory / 'tasks.json').write_text(json.dumps({'tasks': tasks}))
    print('Prepared pinned candidates:', ', '.join(IDS))
    sys.exit(0)

assert os.environ.get('JEV_ROUTER_API_KEY') and os.environ.get('CLIPROXY_KEY')
with (directory / ('supplementary-started' if mode == 'supplementary' else 'started')).open('x') as file:
    file.write('Do not restart: initiated attempts must not be replaced.\n')
rows = json.loads((directory / 'dataset.json').read_text())
env = {**os.environ, 'SWE_BENCH_DATASET_PATH': str(directory / 'dataset.json'), 'SWE_BENCH_PYTHON': sys.executable}
outcomes = json.loads((directory / 'outcomes.json').read_text()) if mode == 'supplementary' else []

def attempt(task, phase, round_, arm):
    run_set = f'{name}-{task}-{phase}-r{round_}'
    logpath = directory / f'{task}-{phase}-r{round_}-{arm}.log'
    print(f'START {task} {phase} r{round_} {arm}', flush=True)
    with logpath.open('x') as log:
        completed = subprocess.run(['node', 'eval/run.mjs', '--manifest', str(directory / 'tasks.json'), '--task', task, '--model', 'gpt-6-astra', '--arm', arm], cwd=ROOT.parent, env={**env, 'EVAL_RUN_SET': run_set}, stdout=log, stderr=subprocess.STDOUT)
    paths = []
    for path in (ROOT / 'runs').glob(f'{task}-gpt-6-astra-{arm}-*/result.json'):
        result = json.loads(path.read_text())
        if result.get('run_set') == run_set:
            paths.append((path, result))
    assert len(paths) == 1, f'Incomplete/missing runner result: {logpath}'
    path, result = paths[0]
    result['runner_exit'] = completed.returncode
    if arm == 'jev':
        config = json.loads((path.parent / 'opencode.json').read_text())['plugin'][0][1]
        assert (config['maxRetries'], config['fallbackMode'], config['jevTimeoutMs']) == (3, 'error', 10000)
    print(f"DONE {task} {phase} r{round_} {arm} solved={result['grade_passed']} evidence={result.get('evidence_valid')}", flush=True)
    return result

def matrix(task, phase, orders):
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(attempt, task, phase, i+1, arm) for i, order in enumerate(orders) for arm in order.split()]
        return [f.result() for f in futures]

def report():
    (directory / 'outcomes.json').write_text(json.dumps(outcomes, indent=2) + '\n')
    lines = ['# Astra effort-boundary search', '', f'Run set: `{name}`. Dataset revision: `{REVISION}`. Candidate order: ' + ', '.join(IDS) + '.', '',
             'Predeclared screen: medium 0/2 and xhigh 2/2, with all four runs graded and evidence-valid. Qualifying cases receive five fresh attempts per arm. Confirmation: medium at most 1/5, and high or xhigh at least 4/5, with all 20 runs graded and evidence-valid. Stop after the first confirmed fixed-effort boundary, independent of whether Jev wins, or after five candidates. Failed preflight consumes a candidate slot.', '',
             'At most two concurrent attempts, 15-minute agent cap. Screen orders: medium/xhigh, xhigh/medium. Full orders rotate across rounds. Strict Jev: three additional retries, 10-second total deadline, fallback disabled. No replacements; screen attempts are excluded from confirmation. Independent base/reference preflight is required. Raw prompts, patches and logs remain ignored.', '']
    if mode == 'supplementary':
        lines += ['After all five screens failed the strict qualification rule, Sphinx #7590 (medium 0/2, xhigh 1/2) was selected for an exploratory full matrix as the strongest observed fixed-effort contrast. This is a disclosed post-screen extension on an existing candidate, not a sixth candidate or a qualified screen. The full confirmation threshold is unchanged.', '']
    for outcome in outcomes:
        lines += [f"## {outcome['task']}", '', f"Status: {outcome['status']}", '']
        for phase in ['screen', 'full']:
            results = outcome.get(phase, [])
            if not results:
                continue
            lines += [f'### {phase}', '', '| Arm | Solved / initiated | Graded | Evidence valid | Mean seconds | Mean input | Mean cached input | Mean output |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
            for arm in ['medium', 'high', 'xhigh', 'jev']:
                group = [r for r in results if r['arm'] == arm]
                if not group:
                    continue
                def mean(field):
                    values = [r[field] for r in group if r.get(field) is not None and (field == 'elapsed_ms' or r.get('evidence_valid'))]
                    return round(statistics.mean(values)/(1000 if field == 'elapsed_ms' else 1), 1) if values else '—'
                lines.append('| ' + ' | '.join(str(x) for x in [arm, f"{sum(r['grade_passed'] is True for r in group)}/{len(group)}", sum(r['grade_passed'] is not None for r in group), sum(bool(r.get('evidence_valid')) for r in group), mean('elapsed_ms'), mean('input_tokens'), mean('cached_input_tokens'), mean('output_tokens')]) + ' |')
            lines += ['', '| Run ID | Solved | Evidence valid | Timeout | Classification errors | Fallbacks |', '| --- | --- | --- | --- | ---: | ---: |']
            for r in results:
                lines.append('| ' + ' | '.join(str(r.get(k)) for k in ['run_id', 'grade_passed', 'evidence_valid', 'timed_out', 'classification_errors', 'fallbacks']) + ' |')
            lines.append('')
    lines += ['## Interpretation limits', '', 'This deliberately selects effort-sensitive cases and cannot estimate broad workload savings. Five attempts per arm provide limited precision. Token means require valid evidence; elapsed time includes initiated failures. Cached input is part of input, not additional consumption. Output includes reasoning and auxiliary calls. Concurrent execution and shared upstream/host activity affect latency. A classification failure is an incomplete delivery, not a wrong patch.']
    (ROOT / 'results' / f'{name}.md').write_text('\n'.join(lines) + '\n')

for row in rows:
    task = row['instance_id']
    if mode == 'supplementary':
        if task != 'sphinx-doc__sphinx-7590':
            continue
        outcome = next(o for o in outcomes if o['task'] == task)
        full = outcome['full'] = matrix(task, 'full', ['medium high xhigh jev', 'jev xhigh high medium', 'high jev medium xhigh', 'xhigh medium jev high', 'medium jev high xhigh'])
        assert all(not r.get('fallbacks') for r in full if r['arm'] == 'jev')
        counts = {arm: sum(r['grade_passed'] is True for r in full if r['arm'] == arm) for arm in ['medium', 'high', 'xhigh']}
        confirmed = all(r['grade_passed'] is not None and r.get('evidence_valid') for r in full) and counts['medium'] <= 1 and max(counts['high'], counts['xhigh']) >= 4
        outcome['status'] = 'exploratory full matrix: confirmed fixed-effort boundary' if confirmed else 'exploratory full matrix: inconclusive'
        report()
        continue
    outcome = {'task': task, 'status': 'preflight'}
    outcomes.append(outcome)
    ok = True
    for label, patch, expected in [('base', 'diff --git a/jev-preflight-marker.txt b/jev-preflight-marker.txt\nnew file mode 100644\n--- /dev/null\n+++ b/jev-preflight-marker.txt\n@@ -0,0 +1 @@\n+baseline grader check\n', 1), ('gold', row['patch'], 0)]:
        target = directory / task / label
        target.mkdir(parents=True)
        (target / 'patch.diff').write_text(patch)
        with (target / 'grader.log').open('w') as log:
            grade = subprocess.run(['node', str(ROOT / 'grade-swebench.mjs'), task], cwd=target, env={**env, 'EVAL_TASK_COMMIT': row['base_commit'], 'EVAL_PATCH_PATH': str(target / 'patch.diff')}, stdout=log, stderr=subprocess.STDOUT)
        ok = ok and grade.returncode == expected
        print(f'PREFLIGHT {task} {label} exit={grade.returncode}', flush=True)
    if not ok:
        outcome['status'] = 'preflight failed; no agent attempts'
        report()
        continue
    screen = outcome['screen'] = matrix(task, 'screen', ['medium xhigh', 'xhigh medium'])
    qualifies = all(r['grade_passed'] is not None and r.get('evidence_valid') for r in screen) and all(r['grade_passed'] == (r['arm'] == 'xhigh') for r in screen)
    outcome['status'] = 'screen did not qualify'
    report()
    if not qualifies:
        continue
    full = outcome['full'] = matrix(task, 'full', ['medium high xhigh jev', 'jev xhigh high medium', 'high jev medium xhigh', 'xhigh medium jev high', 'medium jev high xhigh'])
    assert all(not r.get('fallbacks') for r in full if r['arm'] == 'jev')
    counts = {arm: sum(r['grade_passed'] is True for r in full if r['arm'] == arm) for arm in ['medium', 'high', 'xhigh']}
    confirmed = all(r['grade_passed'] is not None and r.get('evidence_valid') for r in full) and counts['medium'] <= 1 and max(counts['high'], counts['xhigh']) >= 4
    outcome['status'] = 'confirmed fixed-effort boundary' if confirmed else 'full confirmation inconclusive'
    report()
    if confirmed:
        break
print('COMPLETE', flush=True)
