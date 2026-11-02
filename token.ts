/*
 * Bridge shared-secret rules, shared by the renderer (index.tsx) and native.ts.
 * Not a native export, so Vencord does not register it as an IPC handler.
 */

/** Shortest token the bridge will serve with. Generated tokens are 64 hex chars. */
export const MIN_TOKEN_LENGTH = 16;

const KNOWN_DEFAULTS = new Set(["", "change-me", "changeme", "token", "password", "secret"]);

export function isWeakToken(token: string | null | undefined): boolean {
    const t = String(token ?? "").trim();
    return KNOWN_DEFAULTS.has(t.toLowerCase()) || t.length < MIN_TOKEN_LENGTH;
}
