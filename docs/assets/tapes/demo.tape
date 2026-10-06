# The README's terminal recording. Every line below is typed into a real shell and runs the real
# `agentfund` binary against a real local instance; only the coding agent is a mock, so no tokens
# are spent.
#
# Reproduce it (starts the instance, records, builds the GIFs, tears down):
#
#   make recording          # = sh scripts/record-demo.sh; needs vhs, ffmpeg, gifsicle
#
# By hand: `DEMO_DIR=/tmp/agentfund-demo NO_OPEN=1 sh scripts/demo.sh --manual` in one terminal,
# then `vhs docs/assets/tapes/demo.tape` from the repository root in another.

Output docs/assets/.raw/terminal.gif

Require minisign

Set Shell "bash"
Set FontSize 15
Set LineHeight 1.25
Set Width 1280
Set Height 640
Set Padding 28
Set TypingSpeed 28ms
Set CursorBlink false
# The web UI's own palette (web/src/index.css, .dark): background, foreground, and --live as the accent.
Set Theme { "name": "agentfund", "background": "#09090b", "foreground": "#e4e4e7", "cursor": "#ff6a33", "selection": "#27272a", "black": "#17171a", "red": "#ff6b5e", "green": "#7ccf9a", "yellow": "#e2b55a", "blue": "#8fb4ff", "magenta": "#c4a7f5", "cyan": "#7fd1d8", "white": "#d4d4d8", "brightBlack": "#71717a", "brightRed": "#ff8a7f", "brightGreen": "#9be0b3", "brightYellow": "#f0cb7e", "brightBlue": "#b0caff", "brightMagenta": "#d8c2fa", "brightCyan": "#a2e1e6", "brightWhite": "#f4f4f5" }

Hide
Type ". /tmp/agentfund-demo/env && export DEMO_DIR=/tmp/agentfund-demo DEMO_PACE=2 PAGER=less LESS=R LESSCHARSET=utf-8 LC_ALL=en_US.UTF-8 && PS1='\[\e[38;2;255;106;51m\]$\[\e[0m\] ' && clear"
Enter
Sleep 500ms
# Mark the moment the visible recording starts, so record-demo.sh can line the page capture up with it.
Type "perl -MTime::HiRes=time -e 'printf qq(%.3f\n), time' > /tmp/agentfund-demo/tape-start && clear"
Enter
Sleep 300ms
Show

# 1. Review before anything runs: the maintainer key's fingerprint, then every prompt, in a pager.
Type "agentfund approve http://localhost:8787/hello"
Sleep 400ms
Enter
Sleep 3.5s
Type "q"
Sleep 1.5s
Type "yes"
Sleep 300ms
Enter
Sleep 1s
Type "n"
Enter
Sleep 3s

Hide
Type "clear"
Enter
Show

# 2. What would run next. Nothing is claimed, nothing executes.
Type "agentfund dry-run hello -n 1 | tail -n 4"
Sleep 400ms
Enter
Sleep 3s

# 3. One task: claim, verify the signature, sandbox, verify command, scope check, push, report.
Type "agentfund work hello --once"
Sleep 400ms
Enter
Sleep 4s

# 4. The demo's stand-in for the CI provider: a passing run, then the maintainer's merge.
Type "sh scripts/demo.sh ci"
Sleep 400ms
Enter
Sleep 6.5s

Hide
Type "clear"
Enter
Show

# 5. Your side of the ledger.
Type "agentfund status"
Sleep 400ms
Enter
Sleep 5s
