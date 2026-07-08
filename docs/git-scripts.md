# git-scripts — Token-Efficient Git Workflow Scripts

Three shell scripts replacing the most common git command clusters that agents
repeat mechanically. Born from ax data: `git status` was called 229 times in 30
days; a single session had 199 git calls. Each raw git command is a full bash
turn — the agent types the command, reads output, then types the next. These
scripts collapse 2-5 turns into 1.

**Origin:** [btw/docs/research/finding-token-waste-with-ax.md](https://github.com/duppypro/btw/blob/main/docs/research/finding-token-waste-with-ax.md)

## Scripts

### git-snap

```
git-snap "your commit message"
```

Equivalent to: `git add -A && git commit -m "message 👑π🐱"`

Auto-appends the Princess Pi commit signature. If no message is given, opens
`$EDITOR` for interactive commit.

### git-ship

```
git-ship "your commit message"
```

Equivalent to: `git-snap "message" && git push`

The full commit-and-push cycle in one call. Requires a message.

### git-overview

```
git-overview
```

Equivalent to four separate commands:
```
git branch --show-current
git status --short
git diff --stat
git log --oneline -5
```

One call gives the agent the full repo picture it usually builds with 3-4
sequential bash turns.

## Discovery

Referenced in `~/git-projects/CLAUDE.md` (section 3, Git & GitHub Etiquette) so
agents discover them automatically. They are on `~/bin/` (in PATH).

## Installation

From the princess-pi-packages repo root:
```bash
ln -sf "$(pwd)/bin/git-snap" ~/bin/git-snap
ln -sf "$(pwd)/bin/git-ship" ~/bin/git-ship
ln -sf "$(pwd)/bin/git-overview" ~/bin/git-overview
```

Or via dotfiles-doctor: add `~/bin/` to a future `scripts/` or `bin/` Stow package
(low priority — the CLAUDE.md reference plus manual symlink is sufficient for now).

## Roads not taken

- **Git aliases instead of shell scripts:** A git alias (`git snap`) can't run
  `git add -A && git commit -m "..."` as an alias — git aliases don't chain
  commands natively without `!` shell-out syntax, which is fragile.
- **Makefile targets:** Overkill for these three — a Makefile implies a project
  context; these scripts work in any directory.
