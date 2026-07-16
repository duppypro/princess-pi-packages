# Universal Configuration Loading Standard (Spec)

## Problem

Tools in princess-pi-packages (`wtft`, `serve`, `merge`, etc.) have no persistent shared configuration. They rely on hardcoded defaults + CLI arguments passed per invocation. No way to set preferences once and have them apply everywhere.

## Design

### Format

JSON with comments — same pattern as Pi's `models.json`. Parsed with `stripJsonComments` for zero-dependency comment support and standard `JSON.parse`.

### File Layout

One file per tool — the tool name IS the filename:

```
~/.config/princess-pi-packages/wtft.json
~/.config/princess-pi-packages/serve.json
```

Per-project overrides at `$CWD/.princess-pi-packages/<tool>.json`.

### Resolution Order (Cascading)

1. **Local override:** `$CWD/.princess-pi-packages/<tool>.json`
2. **Directory walk:** Walk up from `$CWD` to `~/` looking for `.princess-pi-packages/<tool>.json` at each level, stop at home or root
3. **XDG global:** `$XDG_CONFIG_HOME/princess-pi-packages/<tool>.json` (fallback `~/.config/princess-pi-packages/<tool>.json`)
4. **Hardcoded defaults:** Fall back to the defaults passed by the tool

### Merge Strategy

**Deep merge** (field-level), applied from lowest priority to highest:

- **Scalars:** Higher-priority value overwrites
- **Objects:** Recursive deep merge
- **Arrays:** Higher-priority array replaces entirely (no concatenation)
- **`null`:** Explicitly unsets a key — clears the value, falls back to hardcoded default

### Responsibilities

| Concern | Owner |
|---|---|
| File discovery, parsing, merging | `config-loader.ts` |
| Schema validation, type coercion | Each tool (at use-time) |
| Debug/trace config resolution | dotfiles-doctor |

### API

```ts
export function loadConfig(toolName: string, defaults: Record<string, unknown>): Record<string, unknown>
```

Synchronous, pure filesystem. Zero dependencies. No validation.

### Scope

- This spec: `config-loader.ts` module + WTFT as first consumer
- Follow-up issues: wire `serve`, `merge`, etc. per tool

### Cross-repo compatibility

Watu (Rust) — specs should be compatible. Same file hierarchy, same merge semantics. Code not shared (Rust vs TypeScript), but a watu developer should recognize the format and resolution strategy.

## Roads Not Taken

- **YAML/TOML:** Rejected for zero-dependency requirement. JSON with `stripJsonComments` is universal and instant.
- **Single-file with tool namespaces:** Rejected for per-package modularity. One file per tool means watu and node packages each own their files with no namespace collisions.
- **Deep merge on arrays:** Rejected — concatenation is surprising when you want to replace an ignore list. Explicit replace is clearer.
- **Validation in loader:** Rejected — couples the loader to every tool's schema. Each tool validates its own keys at use-time.
