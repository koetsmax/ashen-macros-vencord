/*
 * Ashen Macros ↔ Vencord bridge protocol types.
 * Local shared-secret auth only — not Discord or Ashen API tokens.
 */

export type BridgeActionType =
    | "auth"
    | "ping"
    | "cancel"
    | "react"
    | "edit"
    | "send"
    | "switchChannel"
    | "messageCommand"
    | "slashCommand";

export interface EmojiRef {
    name: string;
    id?: string | null;
    animated?: boolean;
}

export interface SlashOption {
    name: string;
    /** Discord application-command option type (3=STRING, 5=BOOLEAN, 6=USER, …). Optional if inferred. */
    type?: number;
    value: string | number | boolean;
}

/** Client → plugin */
export interface BridgeRequest {
    id: string;
    type: BridgeActionType;
    /** Shared secret; required until the socket is authenticated (or on every message). */
    token?: string;

    // cancel
    /** Request id to cancel; defaults to this message's id if omitted where applicable. */
    targetId?: string;
    cancelId?: string;

    // react / edit / send / switch / commands
    channelId?: string;
    messageId?: string;
    guildId?: string;
    content?: string;
    emoji?: EmojiRef | string;
    name?: string;
    options?: SlashOption[];
}

/** Plugin → client */
export interface BridgeResponse {
    id: string;
    ok: boolean;
    error?: string;
    /** Present on successful ping */
    pong?: boolean;
    latencyMs?: number;
    /** Extra action-specific fields */
    [key: string]: unknown;
}

export interface HelloMessage {
    type: "hello";
    needsAuth: boolean;
    plugin: "AshenMacrosBridge";
    version: string;
}
