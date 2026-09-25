"""Fail-closed ChatGPT weekly-window guard; no credential or response logging."""
import glob
import json
import time
import urllib.request

RESET = 1790410537
DEADLINE = RESET - 1800


def permitted(usage, *, now=None, outstanding=0, margin=3, reserve=2):
    now = time.time() if now is None else now
    window = usage.get("rate_limit", {}).get("primary_window", {})
    used = window.get("used_percent")
    reset = window.get("reset_at")
    if (usage.get("plan_type") != "pro" or not isinstance(used, (int, float))
            or not 0 <= used <= 100 or not isinstance(reset, (int, float))
            or abs(reset - RESET) > 2 or now >= DEADLINE or reset <= now
            or usage["rate_limit"].get("limit_reached") or not usage["rate_limit"].get("allowed")):
        return False
    return 100 - used - outstanding * margin - margin > reserve


def read_usage():
    creds = []
    for path in glob.glob("/home/robert/.cli-proxy-api/*.json"):
        with open(path) as handle:
            item = json.load(handle)
        if item.get("type") == "codex" and item.get("access_token") and item.get("account_id") and not item.get("disabled"):
            creds.append(item)
    if len(creds) != 1:
        raise RuntimeError("expected exactly one active codex credential")
    request = urllib.request.Request("https://chatgpt.com/backend-api/wham/usage", headers={
        "Authorization": "Bearer " + creds[0]["access_token"],
        "ChatGPT-Account-Id": creds[0]["account_id"],
    })
    with urllib.request.urlopen(request, timeout=10) as response:
        usage = json.load(response)
    return usage


def check(outstanding=0, reserve=2):
    usage = read_usage()  # Any network, auth, parsing or deadline failure stops new work.
    if not permitted(usage, outstanding=outstanding, reserve=reserve):
        raise RuntimeError("quota/deadline guard stopped new generation")
    return usage["rate_limit"]["primary_window"]["used_percent"]
