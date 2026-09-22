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
    | "autocomplete"
    | "clickButton";

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
     * Autocomplete resolution for this option (query → choice value).
     * - `true`: always POST an autocomplete interaction
     * - `false`: never (even if the command schema marks the option autocomplete)
     * - omitted: follow the command schema
     */
    autocomplete?: boolean;
    /**
     * Display name / nickname hint for Ashen queue member autocomplete.
     * Used when choice labels are `5: Max -- … with @Friend` (no `<@id>`),
     * so mutual "with" pairs do not resolve to the partner's UUID.
     */
    matchHint?: string;
}

export interface AutocompleteChoice {
    name: string;
    value: string | number;
}

export interface FlattenedButton {
    label: string;
    customId: string;
    style?: number;
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

    // react / edit / send / switch / commands / autocomplete / clickButton
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
    /** Optional display-name hint when resolving member/target autocomplete alone. */
    matchHint?: string;

    // slashCommand — wait for ephemeral / interaction response message
    waitForResponse?: boolean;
    /** Timeout for waitForResponse (ms). Default 8000. */
    waitMs?: number;

    // clickButton — exact button label; messageId optional (last slash ephemeral)
    label?: string;
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
