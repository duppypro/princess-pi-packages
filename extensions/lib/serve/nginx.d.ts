// ---
// Type declarations for the handwritten nginx.js (kept as plain JS — it predates
// the TS7 typecheck, #97). If nginx.js is ever converted to .ts, delete this file.
// ---
export function parseAclFile(targetDir: string): string[];
export function updateNginxAcls(clientSlug: string, emails: string[]): boolean;
export function updateNginxPort(clientSlug: string, port: number | null): boolean;
export function reloadNginx(): boolean;
