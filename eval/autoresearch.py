"""Resumable quota-bounded Astra prompt search. Raw attempts live in ignored eval/runs.

Run: python3 -u eval/autoresearch.py [prepare|run]
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import time
from quota_guard import check, read_usage, permitted, DEADLINE

ROOT = Path(__file__).resolve().parent.parent
PARENT = Path('/home/robert/orca/workspaces/opencode-jev-router/jev-router-deeper-eval-discussion')
WORK = ROOT / 'eval/runs/quota-autoresearch-20260924'
REV = '78f471bf655a3137b2e8a75af1501690ec009ec3'
IMAGE = 'jev-research-agent:20260924'
DEV = ['pallets__flask-5014', 'pytest-dev__pytest-5787', 'django__django-14631', 'scikit-learn__scikit-learn-25102']
SOURCE = (ROOT / 'src/jev.ts').read_text()
ORIGINAL = re.search(r'const DESCRIPTIONS: Record<Effort, string> = \{.*?\n\};', SOURCE, re.S).group()
QUESTION = 'Select the reasoning effort for the next model call.'


def append(event, **fields):
    with (WORK / 'ledger.jsonl').open('a') as handle:
        handle.write(json.dumps({'at': int(time.time()), 'event': event, **fields}, sort_keys=True) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    print(event, fields, flush=True)


def events():
    return [json.loads(line) for line in (WORK / 'ledger.jsonl').read_text().splitlines()] if (WORK / 'ledger.jsonl').exists() else []


def environment():
    env = os.environ.copy()
    for line in (ROOT / '.env').read_text().splitlines():
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env.setdefault(k.strip(), v.strip().strip('"\''))
    for target, source in [('JEV_ROUTER_API_KEY', 'JEV_API_KEY'), ('JEV_ROUTER_BASE_URL', 'JEV_BASE_URL'),
                           ('JEV_ROUTER_UPSTREAM_BASE_URL', 'UPSTREAM_BASE_URL')]:
        if not env.get(target):
            env[target] = env.get(source, '')
    if not all(env.get(k) for k in ['JEV_ROUTER_API_KEY', 'JEV_ROUTER_BASE_URL', 'JEV_ROUTER_UPSTREAM_BASE_URL', 'CLIPROXY_KEY']):
        raise RuntimeError('required explicit endpoint/keys missing')
    env.update(EVAL_AGENT_IMAGE=IMAGE, SWE_BENCH_DATASET_PATH=str(WORK / 'dataset.json'),
               EVAL_DATASET_DIGEST_FILE=str(WORK / 'dataset.sha256'),
               SWE_BENCH_PYTHON=str(PARENT / 'eval/runs/swebench-venv/bin/python'))
    return env


def candidate(label, hypothesis, question=QUESTION, description=ORIGINAL):
    replacement = SOURCE.replace(ORIGINAL, description).replace(QUESTION, question)
    if replacement == SOURCE and label != 'current':
        raise RuntimeError('candidate did not alter routing surface')
    digest = hashlib.sha256(replacement.encode()).hexdigest()
    target = WORK / 'candidates' / digest
    if not target.exists():
        target.mkdir(parents=True)
        # Copy only build inputs; never expose optimizer/grades/other candidate output to agents.
        for folder in ['src']:
            shutil.copytree(ROOT / folder, target / folder)
        for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']:
            shutil.copy2(ROOT / name, target / name)
        (target / 'src/jev.ts').write_text(replacement)
        (target / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        subprocess.run(['/home/robert/.nvm/versions/node/v24.21.0/bin/npm', 'run', 'build'], cwd=target, check=True,
                       stdout=subprocess.DEVNULL)
        (target / 'hypothesis.json').write_text(json.dumps({'label': label, 'hypothesis': hypothesis, 'source_sha256': digest,
                                                             'question': question, 'descriptions': description}, indent=2) + '\n')
        append('candidate_frozen', label=label, hash=digest, hypothesis=hypothesis)
    elif hashlib.sha256((target / 'src/jev.ts').read_bytes()).hexdigest() != digest:
        raise RuntimeError('candidate source mutated')
    return digest


def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    if (WORK / 'schedule.json').exists():
        return
    check()
    # Pinned prior public rows are copied read-only, and holdout IDs are selected
    # deterministically before observing a single effort outcome.
    rows = {}
    for name in ['swebench-verified-pilot.json', 'swebench-astra.json']:
        for row in json.loads((PARENT / 'eval/runs' / name).read_text()):
            rows[row['instance_id']] = row
    # Fetch pinned public dataset with the already installed offline harness interpreter.
    script = 'from datasets import load_dataset; import json; d=load_dataset("SWE-bench/SWE-bench_Verified", split="test", revision=' + repr(REV) + '); print(json.dumps([dict(x) for x in d]))'
    proc = subprocess.run([str(PARENT / 'eval/runs/swebench-venv/bin/python'), '-c', script], capture_output=True, text=True, check=True)
    public = json.loads(proc.stdout)
    for row in public:
        rows.setdefault(row['instance_id'], row)
    known = set(DEV) | {'sphinx-doc__sphinx-7590', 'pytest-dev__pytest-6197', 'sphinx-doc__sphinx-11510',
        'sympy__sympy-13878', 'scikit-learn__scikit-learn-25102', 'django__django-15957', 'pydata__xarray-6992',
        'astropy__astropy-12907', 'astropy__astropy-13579'}
    # Fixed hash rank across distinct repositories, not selected on effort outcomes.
    ranked = sorted((r for r in public if r['instance_id'] not in known and len(r['problem_statement']) < 5000),
                    key=lambda r: hashlib.sha256(('holdout-20260924:' + r['instance_id']).encode()).hexdigest())
    holdout, repos = [], set()
    for row in ranked:
        if row['repo'] not in repos:
            holdout.append(row['instance_id']); repos.add(row['repo'])
        if len(holdout) == 6:
            break
    ids = DEV + holdout
    data = json.dumps([rows[i] for i in ids], ensure_ascii=False).encode() + b'\n'
    (WORK / 'dataset.json').write_bytes(data)
    (WORK / 'dataset.sha256').write_text(hashlib.sha256(data).hexdigest() + '\n')
    manifest = {'tasks': [{'id': i, 'repo': 'https://github.com/' + rows[i]['repo'] + '.git',
               'commit': rows[i]['base_commit'], 'grade': 'swebench', 'agentTimeoutMinutes': 15,
               'prompt': rows[i]['problem_statement'].replace('\r\n', '\n')} for i in ids]}
    (WORK / 'tasks.json').write_text(json.dumps(manifest))
    (WORK / 'schedule.json').write_text(json.dumps({'revision': REV, 'digest': hashlib.sha256(data).hexdigest(),
         'dev': DEV, 'holdout': holdout, 'image': IMAGE, 'reset': 1790410537, 'deadline': DEADLINE,
         'selection': 'sha256 holdout rank, one per repo; no effort outcomes observed'}, indent=2) + '\n')
    append('schedule_frozen', dev=DEV, holdout=holdout)


def preflight(ids):
    env = environment()
    rows = {r['instance_id']: r for r in json.loads((WORK / 'dataset.json').read_text())}
    for task in ids:
        for label, patch, expected in [('base', 'diff --git a/jev-marker b/jev-marker\nnew file mode 100644\n--- /dev/null\n+++ b/jev-marker\n@@ -0,0 +1 @@\n+base\n', 1),
                                        ('reference', rows[task]['patch'], 0)]:
            if any(e.get('event') == 'preflight' and e.get('task') == task and e.get('arm') == label for e in events()):
                continue
            path = WORK / 'preflight' / task / label
            path.mkdir(parents=True, exist_ok=True)
            (path / 'patch.diff').write_text(patch)
            with (path / 'grade.log').open('w') as log:
                result = subprocess.run(['node', str(ROOT / 'eval/grade-swebench.mjs'), task], cwd=path,
                    env={**env, 'EVAL_PATCH_PATH': str(path / 'patch.diff'), 'EVAL_TASK_COMMIT': rows[task]['base_commit']},
                    stdout=log, stderr=subprocess.STDOUT, timeout=1800)
            append('preflight', task=task, arm=label, exit=result.returncode)
            if result.returncode != expected:
                raise RuntimeError(f'preflight {task}/{label}: expected {expected}, got {result.returncode}')


def attempt(task, arm, phase, repeat, build=None):
    key = f'{phase}:{task}:{arm}:{repeat}'
    if any(e.get('key') == key and e['event'] == 'started' for e in events()):
        if not any(e.get('key') == key and e['event'] == 'completed' for e in events()):
            paths = [p for p in (ROOT / 'eval/runs').glob(f'{task}-gpt-6-astra-{arm}-*/result.json')
                     if json.loads(p.read_text()).get('run_set') == key]
            if len(paths) == 1:
                r = json.loads(paths[0].read_text())
                append('completed', key=key, exit=0, result=str(paths[0]), **{k: r.get(k) for k in
                    ['grade_passed', 'evidence_valid', 'input_tokens', 'cached_input_tokens', 'output_tokens',
                     'elapsed_ms', 'fallbacks', 'classification_errors', 'timed_out']})
            else:
                append('incomplete', key=key, reason='initiated attempt has no unique result; not replaced')
        return
    # Reserve margin for one concurrent in-flight attempt, plus other sessions.
    used = check(outstanding=1)
    env = environment()
    env['EVAL_RUN_SET'] = key
    if build:
        env['EVAL_BUILD_DIR'] = str(WORK / 'candidates' / build / 'dist')
    append('started', key=key, task=task, arm=arm, phase=phase, candidate=build, used=used)
    logpath = WORK / 'attempts' / (hashlib.sha256(key.encode()).hexdigest() + '.log')
    logpath.parent.mkdir(exist_ok=True)
    with logpath.open('x') as log:
        process = subprocess.Popen(['node', str(ROOT / 'eval/run.mjs'), '--manifest', str(WORK / 'tasks.json'), '--task', task,
                 '--model', 'gpt-6-astra', '--arm', arm], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                 start_new_session=True)
        while process.poll() is None:
            time.sleep(30)
            try:
                check(outstanding=1)
            except Exception as exc:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
                append('aborted', key=key, reason=str(exc)[:150])
                break
    paths = [p for p in (ROOT / 'eval/runs').glob(f'{task}-gpt-6-astra-{arm}-*/result.json')
             if json.loads(p.read_text()).get('run_set') == key]
    summary = {'key': key, 'exit': process.returncode, 'result': str(paths[0]) if len(paths) == 1 else None}
    if len(paths) == 1:
        r = json.loads(paths[0].read_text())
        summary.update({k: r.get(k) for k in ['grade_passed', 'evidence_valid', 'input_tokens', 'cached_input_tokens',
            'output_tokens', 'elapsed_ms', 'fallbacks', 'classification_errors', 'timed_out']})
    append('completed', **summary)
    return summary


def safe_attempt(*args):
    try:
        return attempt(*args)
    except Exception as exc:
        append('stopped', reason=str(exc)[:200])
        raise


def report():
    results = [e for e in events() if e['event'] == 'completed']
    lines = ['# Quota-bounded Astra autoresearch', '', 'Pinned schedule: `eval/runs/quota-autoresearch-20260924/schedule.json`.',
             'All started attempts, including short failures, are in the append-only ledger. Raw artifacts remain ignored.',
             '', '| Phase | Arm | Initiated | Solved | Incomplete | Valid usage | Input | Cached input | Output | Seconds (all) |',
             '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for phase in sorted({r['key'].split(':')[0] for r in results}):
        for arm in sorted({r['key'].split(':')[2] for r in results if r['key'].startswith(phase + ':')}):
            group = [r for r in results if r['key'].startswith(phase + ':') and r['key'].split(':')[2] == arm]
            good = [r for r in group if r.get('evidence_valid') and isinstance(r.get('output_tokens'), int)]
            avg = lambda values: round(sum(values)/len(values), 1) if values else '—'
            lines.append(f'| {phase} | {arm} | {len(group)} | {sum(r.get("grade_passed") is True for r in group)} | {sum(r.get("grade_passed") is None for r in group)} | {len(good)} | {avg([r["input_tokens"] for r in good])} | {avg([r["cached_input_tokens"] for r in good])} | {avg([r["output_tokens"] for r in good])} | {avg([r["elapsed_ms"]/1000 for r in group if r.get("elapsed_ms") is not None])} |')
    lines += ['', '## Individual attempts', '', '| Key | Grade | Evidence | Input | Cache | Output | Seconds | Error / fallback |',
              '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |']
    for r in results:
        lines.append('| ' + ' | '.join(str(x) for x in [r['key'], r.get('grade_passed'), r.get('evidence_valid'),
            r.get('input_tokens'), r.get('cached_input_tokens'), r.get('output_tokens'),
            round((r.get('elapsed_ms') or 0)/1000, 1), f"{r.get('classification_errors')}/{r.get('fallbacks')}"]) + ' |')
    lines += ['', f"Started without completed metadata: {sum(e['event']=='started' for e in events())-len(results)}. See ledger for abort/incomplete reasons.",
              '', 'This is a pilot; no equivalence inference from small samples. Cache input is included in input usage. '
              'Usage means exclude invalid evidence, but initiated failures remain in success denominators. Agent latency includes routing; '
              'the decision event log in each raw attempt records per-call Jev latency.']
    (ROOT / 'eval/results/quota-autoresearch-2026-09-24.md').write_text('\n'.join(lines) + '\n')


def main():
    prepare()
    if len(sys.argv) > 1 and sys.argv[1] == 'prepare':
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'extend':
        frozen = [e for e in events() if e['event'] == 'winner_frozen']
        if len(frozen) != 1 or not any(e['event'] == 'finished' for e in events()):
            raise RuntimeError('confirmation winner/initial schedule not frozen and complete')
        schedule = json.loads((WORK / 'schedule.json').read_text())
        base = hashlib.sha256(SOURCE.encode()).hexdigest()
        if not (WORK / 'candidates' / base / 'dist/plugin.js').exists():
            raise RuntimeError('baseline artifact missing')
        winner = frozen[0]['hash']
        if not (WORK / 'candidates' / winner / 'dist/plugin.js').exists():
            raise RuntimeError('winner artifact missing')
        append('extension_frozen', repeats=[4, 5, 6], arms=['high', 'current', 'winner'],
               tasks=schedule['holdout'], winner=winner,
               rationale='replicate frozen holdout comparison; no retuning on holdout')
        plan = [(task, arm, phase, repeat, build) for repeat in (4, 5, 6) for task in schedule['holdout']
            for arm, phase, build in [('high', 'confirmation-high', None),
                ('jev', 'confirmation-baseline', base), ('jev', 'confirmation-candidate', winner)]]
        random.Random(20260926).shuffle(plan)
        for item in plan:
            safe_attempt(*item)
            report()
        append('extension_finished', reason='frozen confirmation replication complete')
        return
    base = candidate('current', 'Existing Jev baseline')
    # The two initial hypotheses alter only the question; compile immutable artifacts.
    hypotheses = [
        ('lowest-sufficient', 'Reduce avoidable high calls by using the least effort sufficient for the next step, without skipping verification.',
         'Select the lowest reasoning effort sufficient to complete the NEXT model call correctly. Prefer low for mechanical edits, medium for routine implementation, high for complex debugging, design, or unresolved failures. Preserve verification.'),
        ('marginal-benefit', 'Prefer medium when additional reasoning is unlikely to change the next action; retain high for uncertainty or failing checks.',
         'Which reasoning effort has worthwhile expected marginal benefit on the NEXT model call? Choose low for obvious mechanical actions, medium when a straightforward plan is known, high when ambiguity, debugging, or failed verification needs deep reasoning.'),
    ]
    builds = [(label, candidate(label, hypothesis, question)) for label, hypothesis, question in hypotheses]
    schedule = json.loads((WORK / 'schedule.json').read_text())
    preflight(schedule['dev'])
    # Isolation shakedown: first real attempt is retained, never silently replaced.
    safe_attempt(schedule['dev'][0], 'high', 'development', 1)
    report()
    plan = [(t, a, 'development', r, b) for r in range(1, 3) for t in schedule['dev']
            for a, b in [('high', None), ('jev', base)]]
    plan += [(t, 'jev', f'screen-{label}', 1, build) for label, build in builds for t in schedule['dev']]
    random.Random(20260924).shuffle(plan)
    for t, a, phase, r, b in plan:
        if phase == 'development' and t == schedule['dev'][0] and a == 'high' and r == 1:
            continue
        safe_attempt(t, a, phase, r, b)
        report()
        if read_usage()['rate_limit']['primary_window']['used_percent'] >= 80:
            break
    # Reflect on graded development feedback. Each follow-up changes one
    # interpretable question factor and is screened on the same task mix.
    if len([e for e in events() if e['event'] == 'completed' and e['key'].startswith('screen-')]) == 8:
        observed = [e for e in events() if e['event'] == 'completed' and e['key'].startswith('screen-')]
        for label, question, hypothesis in [
            ('verify-explicit', 'Choose the lowest sufficient reasoning effort for the NEXT action. Low: mechanical actions. Medium: routine implementation with a clear plan. High: uncertain contracts, debugging, failed tests, or verification that needs diagnosis.',
             'Explicitly distinguish straightforward verification from diagnosing failures.'),
            ('next-step-only', 'Classify only the NEXT model call, not the total task difficulty. Low for simple inspection or edits, medium for known implementation steps, high for ambiguous design or investigating failures.',
             'Task-level complexity may be overapplied to simple next steps.'),
        ]:
            append('reflection', label=label, screened_successes=sum(e.get('grade_passed') is True for e in observed),
                   screened_outputs=sum(e.get('output_tokens') or 0 for e in observed), hypothesis=hypothesis)
            build = candidate(label, hypothesis, question)
            builds.append((label, build))
            for task in schedule['dev']:
                if read_usage()['rate_limit']['primary_window']['used_percent'] >= 78:
                    break
                safe_attempt(task, 'jev', 'screen-' + label, 1, build)
                report()
    # Select only independent graded outcomes; incomplete runs are losses.
    screens = [e for e in events() if e['event'] == 'completed' and e['key'].startswith('screen-')]
    ranking = sorted(builds, key=lambda item: (
        -sum(e.get('grade_passed') is True for e in screens if e['key'].startswith('screen-' + item[0] + ':')),
        sum(e.get('output_tokens') or 10**8 for e in screens if e['key'].startswith('screen-' + item[0] + ':'))))
    if len(screens) < len(builds) * len(schedule['dev']):
        append('stopped', reason='insufficient screen outcomes to freeze winner')
        return
    for label, build in ranking[:2]:
        for task in schedule['dev']:
            if read_usage()['rate_limit']['primary_window']['used_percent'] >= 80:
                break
            for repeat in (2, 3):
                if read_usage()['rate_limit']['primary_window']['used_percent'] >= 80:
                    break
                safe_attempt(task, 'jev', 'screen-' + label, repeat, build)
                report()
    screens = [e for e in events() if e['event'] == 'completed' and e['key'].startswith('screen-')]
    ranking = sorted(builds, key=lambda item: (
        -sum(e.get('grade_passed') is True for e in screens if e['key'].startswith('screen-' + item[0] + ':')) / max(1, sum(e['key'].startswith('screen-' + item[0] + ':') for e in screens)),
        sum(e.get('output_tokens') or 10**8 for e in screens if e['key'].startswith('screen-' + item[0] + ':')) / max(1, sum(e['key'].startswith('screen-' + item[0] + ':') for e in screens))))
    winner = ranking[0]
    append('winner_frozen', label=winner[0], hash=winner[1])
    preflight(schedule['holdout'])
    plan = [(t, arm, 'confirmation', r, build) for r in range(1, 4) for t in schedule['holdout']
            for arm, build in [('high', None), ('jev', base), ('jev', winner[1])]]
    random.Random(20260925).shuffle(plan)
    for t, arm, phase, r, build in plan:
        safe_attempt(t, arm, phase + ('-candidate' if build == winner[1] else '-baseline' if build else '-high'), r, build)
        report()
    append('finished', reason='confirmation schedule complete')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        if WORK.exists():
            append('blocked', reason=str(exc)[:300])
            report()
        raise
