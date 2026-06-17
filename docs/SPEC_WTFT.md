# Spec: `wtft` — Token Cost Auditing Widget

This specification defines the behavior and categorization logic for the `wtft` (Where The F***ing Tokens?!) extension, a local-only cost auditing tool for the Princess-Pi Coding Agent.

---

## 1. Goal
Provide real-time visibility into token consumption without incurring additional LLM costs.

## 2. Categorization Rules
Interactions are classified based on the file paths and tools accessed, following strict priority rules:

### Priority Rules (Writes over Reads)
If a turn contains multiple file accesses:
1.  **Writes take priority.**
2.  If **two or more distinct categories** are written, the turn is classified as `mixed`.
3.  If exactly **one category** is written, the turn is classified as that category (`spec`, `code`, or `test`).

### Read-Only Logic
If no files are written:
1.  If **two or more distinct categories** are read, the turn is `mixed`.
2.  If exactly **one category** is read, the turn is classified as that category.
3.  If **no files** are accessed but text/commands exist, it is `prompt`.
4.  Otherwise, `other`.

| Input | Classification |
| :--- | :--- |
| Read Spec, Read Code | `mixed` |
| Read Spec, Write Code | `code` |
| Write Spec, Read Code | `spec` |
| Write Spec, Write Code | `mixed` |
| Write Spec, Write Code, Read Test | `mixed` |
| Read Spec, Write Code, Read Test | `code` |
| Read Spec, Read Code, Write Test | `test` |

---

## 3. Command Reference
The extension provides:
- `/wtft`: Main widget (configure interval, limit, width, etc.).
- `/wtft-other`: Debug command (bash command histogram + cumulative cost).

---

## 4. Implementation
- Written in TypeScript.
- Runs locally (0 LLM tokens).
- Leverages `ctx.sessionManager.getBranch()` for retrospective analysis.
