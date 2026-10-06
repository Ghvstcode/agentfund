#!/usr/bin/env python3
"""Generate the README/docs diagrams as hand-laid-out SVG, one file per theme.

    python3 scripts/readme-diagrams.py

Writes docs/assets/how-it-works-{light,dark}.svg and docs/assets/pipeline-{light,dark}.svg.
GitHub serves repository SVGs under a CSP that blocks external fonts and scripts, and an SVG's
own prefers-color-scheme follows the OS rather than the GitHub theme, so: system font stacks,
no <style> media queries, and two files that the Markdown picks between with <picture>.
Colours are the web UI's tokens (web/src/index.css).
"""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parent.parent / "docs" / "assets"
SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
THEMES = {
    "light": dict(fg="#0a0a0b", muted="#62626a", border="#d9d9de", card="#ffffff", code="#f3f3f4", live="#bd3509", soft="#bd350914"),
    "dark": dict(fg="#f4f4f5", muted="#a0a0ab", border="#34343a", card="#0f0f12", code="#1b1b1f", live="#ff6a33", soft="#ff6a331f"),
}


def text(x, y, s, size=14, fill="fg", weight=400, family=SANS, anchor="start", t=None):
    return (f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
            f'fill="{t[fill]}" text-anchor="{anchor}">{escape(s)}</text>')


def arrow(x1, y, x2, t, color="muted"):
    return (f'<path d="M{x1} {y}H{x2 - 7}" stroke="{t[color]}" stroke-width="1.5" fill="none"/>'
            f'<path d="M{x2 - 8} {y - 5}l8 5-8 5" stroke="{t[color]}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')


def how_it_works(t):
    w, h, pw, gap, top = 1200, 334, 360, 60, 8
    panels = [
        ("1", "A maintainer signs the work", "Maintainer · in the project's repo",
         ["tasks/0302-csv.yaml", "tasks/MANIFEST.lock", "tasks/MANIFEST.lock.minisig"],
         ["Each task: a prompt, the files it may write,", "a verify command and a token cap.", "One signature covers every task."], False),
        ("2", "Your worker runs it, sandboxed", "Backer · on your machine",
         ["verify signature + hashes", "sandbox: no host mounts, non-root", "egress: the model API, nothing else"],
         ["Your own coding-agent login, your own caps.", "A change outside the task's write scope", "discards the whole run."], False),
        ("3", "CI decides what counts", "Public · CI and the ledger",
         ["pull request opened from a fork", "CI passes   → delivered", "PR merges   → merged"],
         ["The server is a scoreboard anyone can run.", "It can stall work. It cannot change what", "runs, and failed tokens never count."], True),
    ]
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
           f'aria-label="How AgentFund works: a maintainer signs task manifests; a backer\'s worker verifies and runs them in a sandbox; CI decides which tokens count as delivered.">']
    for i, (num, title, who, code, caption, accent) in enumerate(panels):
        x = i * (pw + gap)
        stroke = t["live"] if accent else t["border"]
        out.append(f'<rect x="{x + 0.75}" y="{top}" width="{pw - 1.5}" height="{h - top - 8}" rx="14" fill="{t["card"]}" stroke="{stroke}" stroke-width="1.5"/>')
        out.append(f'<circle cx="{x + 40}" cy="{top + 42}" r="15" fill="{t["live"] if accent else t["fg"]}"/>')
        out.append(text(x + 40, top + 47, num, 14, "card", 600, MONO, "middle", t))
        out.append(text(x + 66, top + 38, title, 17, "fg", 600, t=t))
        out.append(text(x + 66, top + 58, who, 12.5, "live" if accent else "muted", t=t))
        cy = top + 86
        out.append(f'<rect x="{x + 24}" y="{cy}" width="{pw - 48}" height="110" rx="8" fill="{t["code"]}"/>')
        for j, line in enumerate(code):
            hot = accent and j == 1
            out.append(text(x + 40, cy + 34 + j * 26, line, 13.5, "live" if hot else "fg", 600 if hot else 400, MONO, t=t))
        for j, line in enumerate(caption):
            out.append(text(x + 24, cy + 146 + j * 21, line, 14, "muted", t=t))
        if i < 2:
            out.append(arrow(x + pw + 12, top + 42, x + pw + gap - 12, t))
    out.append("</svg>")
    return "\n".join(out)


def pipeline(t):
    w, h = 1200, 236
    lanes = [
        ("In the repository · the maintainer", ["manifest", "lock", "signature"], False),
        ("On the backer's machine · the worker", ["claim", "sandbox", "pull request"], False),
        ("In public · CI and the server", ["CI", "ledger"], True),
    ]
    notes = {
        "manifest": "one task, as YAML", "lock": "SHA-256 of each", "signature": "minisign, Ed25519",
        "claim": "a lease, not a lock-in", "sandbox": "agent + verify", "pull request": "pushed from the host",
        "CI": "passes, or it doesn't", "ledger": "delivered, merged",
    }
    nw, ngap, lgap = 116, 22, 30
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
           f'aria-label="The path of one task: manifest, lock, signature in the repository; claim, sandbox, pull request on the backer\'s machine; CI and ledger in public.">']
    x = 0
    prev_end = None
    for label, nodes, accent in lanes:
        lw = len(nodes) * nw + (len(nodes) - 1) * ngap + 32
        stroke = t["live"] if accent else t["border"]
        out.append(f'<rect x="{x + 0.75}" y="34" width="{lw - 1.5}" height="150" rx="14" fill="none" stroke="{stroke}" stroke-width="1.5" stroke-dasharray="{"0" if accent else "5 5"}"/>')
        out.append(text(x + 4, 20, label, 13, "live" if accent else "muted", 500, t=t))
        nx = x + 16
        for i, node in enumerate(nodes):
            hot = accent and node == "ledger"
            out.append(f'<rect x="{nx}" y="66" width="{nw}" height="86" rx="10" fill="{t["soft"] if hot else t["card"]}" stroke="{t["live"] if hot else t["border"]}" stroke-width="1.5"/>')
            out.append(text(nx + nw / 2, 104, node, 13.5, "live" if hot else "fg", 600, MONO, "middle", t))
            out.append(text(nx + nw / 2, 127, notes[node], 11, "muted", t=t, anchor="middle"))
            if prev_end is not None:
                out.append(arrow(prev_end + 3, 109, nx - 3, t))
            prev_end = nx + nw
            nx += nw + ngap
        x += lw + lgap
    out.append(text(0, 216, "Everything left of CI can be re-checked from the repository and your own logs. Everything right of it links to the pull request and CI run that justify it.", 13, "muted", t=t))
    out.append("</svg>")
    return "\n".join(out)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, t in THEMES.items():
        (OUT / f"how-it-works-{name}.svg").write_text(how_it_works(t) + "\n")
        (OUT / f"pipeline-{name}.svg").write_text(pipeline(t) + "\n")
        print(f"how-it-works-{name}.svg pipeline-{name}.svg")
