#!/usr/bin/env python3
"""从 Codex rollout jsonl 提取干净的对话转录。"""
import json, sys, html

SRC = "/Users/z/.codex/sessions/2026/07/19/rollout-2026-07-19T22-08-39-019f7ab5-259b-7f61-a436-81a86d247b62.jsonl"
OUT = "/Users/z/code/ai project/.cc-tmp/codex-transcript-019f7ab5.md"

def gettext(p):
    txt = ""
    for c in p.get("content", []) or []:
        if isinstance(c, dict):
            txt += c.get("text", "") or ""
    return txt

def is_injected(t):
    s = t.strip()
    return (s.startswith("<environment_context>")
            or s.startswith("<permissions")
            or s.startswith("<user_instructions>")
            or s.startswith("<user_shell")
            or s.startswith("<current_")
            or s.startswith("[Attached"))

rows = []          # (role, text)
with open(SRC) as fh:
    for line in fh:
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type"); p = o.get("payload", {})
        if not isinstance(p, dict):
            continue
        if t == "response_item" and p.get("type") == "message":
            role = p.get("role")
            if role not in ("user", "assistant"):
                continue
            txt = gettext(p)
            if not txt.strip():
                continue
            if role == "user" and is_injected(txt):
                continue
            rows.append((role, txt))

with open(OUT, "w") as out:
    out.write("# Codex 会话转录\n\n")
    out.write("- 会话 ID: `019f7ab5-259b-7f61-a436-81a86d247b62`\n")
    out.write("- 开始时间: 2026-07-19 22:08:39 (Asia/Shanghai)\n")
    out.write("- 工作目录: /Users/z/code/ai project\n")
    out.write(f"- 消息段数: {len(rows)}\n\n---\n\n")
    n_user = 0
    for role, txt in rows:
        if role == "user":
            n_user += 1
            out.write(f"\n## 👤 用户 #{n_user}\n\n")
            out.write(txt.strip() + "\n")
        else:
            out.write(f"\n### 🤖 Codex\n\n")
            out.write(txt.strip() + "\n")

print("已写出:", OUT)
print("总段数:", len(rows))
