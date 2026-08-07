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
    | "slashCommand"
    | "autocomplete";

export interface EmojiRef {
    name: string;
    id?: string | null;
    animated?: boolean;
}

export interface SlashOption {
    name: string;
    /** Discord application-command option type (3=STRING, 5=BOOLEAN, 6=USER, …). Optional if inferred. */
    type?: number;
    value?: string | number | boolean;
    /** Nested options for SUB_COMMAND / SUB_COMMAND_GROUP (type 1 / 2). */
    options?: SlashOption[];
    /**
     * Force Discord autocomplete resolution for this option (query → choice value).
     * Usually unnecessary: options with autocomplete=true in the command schema are resolved automatically.
     */
    autocomplete?: boolean;
}

export interface AutocompleteChoice {
    name: string;
    value: string | number;
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

    // ping
    /** Artificial delay (ms) before pong — used by Bridge tests Escape/cancel harness. */
    delayMs?: number;

    // react / edit / send / switch / commands / autocomplete
    channelId?: string;
    messageId?: string;
    guildId?: string;
    content?: string;
    emoji?: EmojiRef | string;
    name?: string;
    options?: SlashOption[];

    // autocomplete
    /** Option name to focus (e.g. "target"). */
    optionName?: string;
    /** Text currently typed into the focused option (e.g. Discord user id). */
    query?: string;
    /** Prefer this choice index after autocomplete (default: best match / first). */
    choiceIndex?: number;
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
