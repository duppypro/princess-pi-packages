# Spec Draft: Auto-seed local .serve-acl and Ignore Globally

## Goal
Simplify the dynamic `/serve` workflow by automatically creating/seeding a local `.serve-acl` file if missing, using a global user default or falling back to the user's Git email, and ensuring that `.serve-acl` is ignored globally.

## Detailed Plan

### 1. Global Gitignore Configuration
- Append `.serve-acl` to `~/.config/git/ignore` if it is not already present.

### 2. Auto-Seeding Logic
Modify `parseAclFile(targetDir)` in `extensions/lib/serve/nginx.js` to do the following if `targetDir/.serve-acl` does not exist:
- Search for a global default at `~/.config/princess-pi/default-acl`.
- If the global default file exists, copy it to `targetDir/.serve-acl`.
- If it doesn't exist:
  - Query the local git config email: `git config user.email`.
  - Fallback to standard admin emails if no git email exists (e.g. `david@princess-pi.dev`).
  - Create directory `~/.config/princess-pi/` if missing.
  - Write this email to the new global default file `~/.config/princess-pi/default-acl`.
  - Copy/write this email as a single entry to `targetDir/.serve-acl`.
- Proceed with standard parsing.

## Verification Plan
1. Delete local `.serve-acl` in a test directory.
2. Run `/serve` on that directory.
3. Verify that a local `.serve-acl` was automatically created, containing the user's Git email.
4. Verify that `~/.config/git/ignore` contains `.serve-acl`.
