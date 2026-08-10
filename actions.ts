/*
 * Discord webpack helpers for AshenMacrosBridge.
 * No DOM. Prefer @webpack/common; finders only at module scope.
 */

import { sendMessage as vencordSendMessage } from "@utils/discord";
import { findByPropsLazy } from "@webpack";
import {
    ApplicationCommandIndexStore,
    ChannelRouter,
    ChannelStore,
    Constants,
    FluxDispatcher,
    MessageActions,
    MessageStore,
    RestAPI,
    SnowflakeUtils,
    UserStore,
} from "@webpack/common";

import type {
    AutocompleteChoice,
    BridgeRequest,
    BridgeResponse,
    EmojiRef,
    FlattenedButton,
    SlashOption,
} from "./types";

/** Application command types */
const COMMAND_TYPE_CHAT_INPUT = 1;
const COMMAND_TYPE_MESSAGE = 3;

/** Interaction type: APPLICATION_COMMAND */
const INTERACTION_APPLICATION_COMMAND = 2;
/** Interaction type: MESSAGE_COMPONENT */
const INTERACTION_MESSAGE_COMPONENT = 3;
/** Interaction type: APPLICATION_COMMAND_AUTOCOMPLETE */
const INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE = 4;

/** Component type: BUTTON */
const COMPONENT_TYPE_BUTTON = 2;

/** Message flag: EPHEMERAL */
const MESSAGE_FLAG_EPHEMERAL = 64;

/** Interaction context: GUILD */
const INTERACTION_CONTEXT_GUILD = 0;

/** Application integration type: GUILD_INSTALL */
const INTEGRATION_TYPE_GUILD = 0;
/** Application integration type: USER_INSTALL */
const INTEGRATION_TYPE_USER = 1;

/** Option type defaults when the client omits `type` */
const OPTION_TYPE_SUB_COMMAND = 1;
const OPTION_TYPE_SUB_COMMAND_GROUP = 2;
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_BOOLEAN = 5;
const OPTION_TYPE_USER = 6;

const SessionStore = findByPropsLazy("getSessionId");

function asErrorMessage(err: unknown): string {
    if (err == null) return "Unknown error";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message || String(err);
    const anyErr = err as { message?: string; body?: { message?: string; }; };
    return anyErr.body?.message || anyErr.message || String(err);
}

function normalizeEmoji(emoji: EmojiRef | string | undefined): { name: string; id?: string | null; animated?: boolean; } {
    if (emoji == null) throw new Error("emoji is required");
    if (typeof emoji === "string") {
        // <:name:id> or <a:name:id> or name:id or unicode
        const custom = emoji.match(/^<a?:(\w+):(\d+)>$/);
        if (custom) {
            return { name: custom[1], id: custom[2], animated: emoji.startsWith("<a:") };
        }
        if (emoji.includes(":") && /^\w+:\d+$/.test(emoji)) {
            const [name, id] = emoji.split(":");
            return { name, id };
        }
        return { name: emoji, id: null };
    }
    if (!emoji.name) throw new Error("emoji.name is required");
    return {
        name: emoji.name,
        id: emoji.id ?? null,
        animated: emoji.animated,
    };
}

function getSessionId(): string {
    const id = SessionStore?.getSessionId?.();
    if (!id || typeof id !== "string") {
        throw new Error("Could not resolve Discord gateway session_id (SessionStore.getSessionId)");
    }
    return id;
}

function getGuildId(channelId: string, explicit?: string): string | undefined {
    if (explicit) return explicit;
    const channel = ChannelStore.getChannel(channelId);
    return channel?.guild_id ?? undefined;
}

function makeNonce(): string {
    return SnowflakeUtils.fromTimestamp(Date.now());
}

/** Same key shape Discord / WhoReacted use with Constants.Endpoints.REACTIONS */
function reactionEmojiKey(emoji: { name: string; id?: string | null; }): string {
    return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

/**
 * Add a reaction via Discord's create-reaction route:
 * PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me
 *
 * Constants.Endpoints.REACTIONS is the GET-users path (no @me) — appending /@me
 * is required or Discord returns 405 Method Not Allowed.
 */
async function addReaction(
    channelId: string,
    messageId: string,
    emoji: { name: string; id?: string | null; animated?: boolean; }
): Promise<void> {
    const key = reactionEmojiKey(emoji);
    const base = String(Constants.Endpoints.REACTIONS(channelId, messageId, key));
    const url = base.endsWith("/@me") ? base : `${base.replace(/\/$/, "")}/@me`;

    const res = await RestAPI.put({
        url,
        rejectWithError: false,
    } as any);

    const status = res?.status ?? res?.statusCode;
    if (status != null && status >= 400) {
        throw new Error(asErrorMessage(res?.body) || `addReaction HTTP ${status}`);
    }
}

/** Strip Flux/Proxy junk so RestAPI JSON matches a real client interaction body. */
function sanitizeApplicationCommand(cmd: any): Record<string, unknown> {
    const raw = cmd && typeof cmd === "object" ? cmd : {};
    const get = (...keys: string[]) => {
        for (const k of keys) {
            if (raw[k] !== undefined && raw[k] !== null) return raw[k];
        }
        return undefined;
    };

    const out: Record<string, unknown> = {};
    const id = get("id");
    const applicationId = get("application_id", "applicationId");
    const version = get("version");
    const type = get("type", "inputType");
    const name = get("name", "displayName");
    const description = get("description");
    const options = get("options");
    const integrationTypes = get("integration_types", "integrationTypes");
    const contexts = get("contexts");
    const guildId = get("guild_id", "guildId");
    const dmPermission = get("dm_permission", "dmPermission");
    const defaultMemberPermissions = get("default_member_permissions", "defaultMemberPermissions");
    const nsfw = get("nsfw");

    if (id != null) out.id = String(id);
    if (applicationId != null) out.application_id = String(applicationId);
    if (version != null) out.version = String(version);
    if (type != null) out.type = type;
    if (name != null) out.name = name;
    if (description != null) out.description = description;
    if (options != null) out.options = options;
    if (integrationTypes != null) out.integration_types = integrationTypes;
    if (contexts !== undefined) out.contexts = contexts;
    if (guildId != null) out.guild_id = String(guildId);
    if (dmPermission != null) out.dm_permission = dmPermission;
    if (defaultMemberPermissions !== undefined) out.default_member_permissions = defaultMemberPermissions;
    if (nsfw != null) out.nsfw = nsfw;
    return out;
}

function pickIntegrationType(cmd: any, guildId?: string): number {
    const types: number[] | undefined =
        cmd?.integration_types ??
        cmd?.integrationTypes ??
        undefined;
    if (Array.isArray(types) && types.length) {
        if (guildId != null && types.includes(INTEGRATION_TYPE_GUILD)) return INTEGRATION_TYPE_GUILD;
        if (types.includes(INTEGRATION_TYPE_USER)) return INTEGRATION_TYPE_USER;
        return Number(types[0]);
    }
    return guildId != null ? INTEGRATION_TYPE_GUILD : INTEGRATION_TYPE_USER;
}

function messageResolvedPayload(channelId: string, messageId: string): Record<string, unknown> | undefined {
    try {
        const msg = MessageStore.getMessage(channelId, messageId);
        if (!msg) return undefined;
        const author = msg.author ?? UserStore.getUser(msg.author?.id);
        return {
            messages: {
                [messageId]: {
                    id: String(msg.id),
                    channel_id: String(msg.channel_id ?? channelId),
                    content: msg.content ?? "",
                    author: author
                        ? {
                            id: String(author.id),
                            username: author.username,
                            discriminator: author.discriminator ?? "0",
                            avatar: author.avatar ?? null,
                            global_name: author.globalName ?? author.global_name ?? null,
                            bot: Boolean(author.bot),
                        }
                        : undefined,
                    timestamp: msg.timestamp?.toISOString?.() ?? msg.timestamp,
                    edited_timestamp: msg.editedTimestamp?.toISOString?.() ?? msg.edited_timestamp ?? null,
                    tts: Boolean(msg.tts),
                    mention_everyone: Boolean(msg.mentionEveryone ?? msg.mention_everyone),
                    mentions: [],
                    mention_roles: [],
                    attachments: [],
                    embeds: [],
                    pinned: Boolean(msg.pinned),
                    type: msg.type ?? 0,
                    flags: msg.flags ?? 0,
                },
            },
        };
    } catch {
        return undefined;
    }
}

function commandRootName(cmd: any): string {
    const root = cmd?.rootCommand ?? cmd?.root_command;
    return String(
        root?.name
        ?? root?.displayName
        ?? root?.untranslatedName
        ?? cmd?.rootName
        ?? cmd?.root_name
        ?? ""
    ).trim();
}

function commandLeafName(cmd: any): string {
    return String(
        cmd?.name ?? cmd?.displayName ?? cmd?.untranslatedName ?? ""
    ).trim();
}

function commandMatches(cmd: any, name: string, type: number): boolean {
    if (!cmd) return false;
    const want = name.toLowerCase();
    const leaf = commandLeafName(cmd).toLowerCase();
    const root = commandRootName(cmd).toLowerCase();
    // Parent command, or indexed subcommand leaf whose root is the parent
    // (Discord indexes `/message-store recall` as name="recall" + rootCommand).
    if (leaf !== want && root !== want) return false;
    const t = cmd.type ?? cmd.inputType ?? cmd.rootCommand?.type ?? cmd.root_command?.type;
    // MESSAGE / USER context commands must match type exactly — a null type is not good enough.
    if (type === COMMAND_TYPE_MESSAGE || type === 2) {
        return t === type;
    }
    return t == null || t === type;
}

/** Prefer the root application command when the index returned a subcommand leaf. */
function unwrapRootApplicationCommand(cmd: any): any {
    const root = cmd?.rootCommand ?? cmd?.root_command;
    if (!root || typeof root !== "object") return cmd;
    // Keep leaf options path if root lacks a full options schema.
    const merged = { ...root };
    if (merged.options == null && cmd.options != null) merged.options = cmd.options;
    if (merged.id == null && root.id != null) merged.id = root.id;
    // Some builds put the real snowflake on the leaf under applicationId / root.
    if (merged.application_id == null && merged.applicationId == null) {
        merged.application_id =
            root.application_id
            ?? root.applicationId
            ?? cmd.application_id
            ?? cmd.applicationId;
    }
    return merged;
}

/**
 * Resolve an application command from the client index.
 * Query shape varies across Discord builds — try several entry points.
 * For commands with subcommands, Discord often indexes the leaf (`recall`)
 * with ``rootCommand.name`` = parent (`message-store`).
 */
function findApplicationCommand(
    channelId: string,
    name: string,
    type: number,
    queryHints: string[] = []
): any {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const guildId = channel.guild_id;
    const contexts: any[] = [
        { type: "channel", channel },
        { channel, type: 0 },
        { channelId, guildId },
        channel,
    ];

    const texts = [
        name,
        ...queryHints.map(h => h.trim()).filter(Boolean),
        ...queryHints
            .map(h => h.trim())
            .filter(Boolean)
            .map(h => `${name} ${h}`),
    ];
    // de-dupe while preserving order
    const seenText = new Set<string>();
    const queryTexts = texts.filter(t => {
        const key = t.toLowerCase();
        if (seenText.has(key)) return false;
        seenText.add(key);
        return true;
    });

    const collectFromQuery = (result: any): any[] => {
        if (!result) return [];
        if (Array.isArray(result)) return result;
        if (Array.isArray(result.commands)) return result.commands;
        if (Array.isArray(result.applicationCommands)) return result.applicationCommands;
        if (result.sections && Array.isArray(result.sections)) {
            return result.sections.flatMap((s: any) => s.commands ?? s.applicationCommands ?? []);
        }
        return [];
    };

    const pick = (commands: any[]): any | undefined => {
        const hit = commands.find(c => commandMatches(c, name, type));
        return hit ? unwrapRootApplicationCommand(hit) : undefined;
    };

    for (const context of contexts) {
        for (const text of queryTexts) {
            try {
                const queried =
                    ApplicationCommandIndexStore.query?.(
                        context,
                        { text, commandTypes: [type], type },
                        { limit: 50 }
                    ) ??
                    ApplicationCommandIndexStore.query?.(
                        context,
                        { text, commandTypes: [type] },
                        { allowFetch: false }
                    ) ??
                    ApplicationCommandIndexStore.query?.(
                        context,
                        { text },
                        { limit: 50 }
                    );
                const hit = pick(collectFromQuery(queried));
                if (hit) return hit;
            } catch {
                /* try next */
            }
        }
    }

    // Scan cached guild / context state
    const states: any[] = [];
    try {
        if (guildId && typeof ApplicationCommandIndexStore.getGuildState === "function") {
            states.push(ApplicationCommandIndexStore.getGuildState(guildId));
        }
    } catch { /* ignore */ }
    try {
        if (typeof ApplicationCommandIndexStore.getContextState === "function") {
            states.push(ApplicationCommandIndexStore.getContextState({ type: "channel", channel }));
            states.push(ApplicationCommandIndexStore.getContextState({ channel, type: 0 }));
            states.push(ApplicationCommandIndexStore.getContextState({ channelId, guildId }));
        }
    } catch { /* ignore */ }
    try {
        if (typeof ApplicationCommandIndexStore.getApplicationStates === "function") {
            const map = ApplicationCommandIndexStore.getApplicationStates();
            if (map?.values) states.push(...map.values());
            else if (map && typeof map === "object") states.push(...Object.values(map));
        }
    } catch { /* ignore */ }

    for (const state of states) {
        if (!state) continue;
        const fromResult = state.result?.sections
            ? Object.values(state.result.sections as Record<string, any>).flatMap(
                (s: any) => Object.values(s.commands ?? {})
            )
            : [];
        const commands: any[] =
            fromResult.length
                ? fromResult
                : state.commands ??
                  state.applicationCommands ??
                  (state.descriptors ? Object.values(state.descriptors) : []) ??
                  [];
        const flat = Array.isArray(commands)
            ? commands
            : Object.values(commands as Record<string, any>);
        const hit = pick(flat);
        if (hit) return hit;
    }

    throw new Error(
        `Application command not found in index: name="${name}" type=${type}. ` +
        "Open the Apps / slash menu once in that channel so Discord loads the command index, then retry."
    );
}

/** Subcommand / group names from the slash payload — Discord often indexes those leaves. */
function subcommandQueryHints(options?: SlashOption[]): string[] {
    if (!options?.length) return [];
    const hints: string[] = [];
    for (const opt of options) {
        const isSub =
            opt.type === OPTION_TYPE_SUB_COMMAND
            || opt.type === OPTION_TYPE_SUB_COMMAND_GROUP
            || (opt.type == null && !!opt.options?.length);
        if (!isSub || !opt.name?.trim()) continue;
        hints.push(opt.name.trim());
        for (const child of opt.options ?? []) {
            const childIsSub =
                child.type === OPTION_TYPE_SUB_COMMAND
                || (child.type == null && !!child.options?.length);
            if (!childIsSub || !child.name?.trim()) continue;
            hints.push(child.name.trim());
            hints.push(`${opt.name.trim()} ${child.name.trim()}`);
        }
    }
    return hints;
}

/** Ask Discord to fetch the command index (same path the slash menu uses). Best-effort. */
async function tryWarmCommandIndex(
    channelId: string,
    name: string,
    type: number,
    signal?: AbortSignal,
    queryHints: string[] = []
): Promise<void> {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    const contexts: any[] = [
        { type: "channel", channel },
        { channel, type: 0 },
        { channelId, guildId: channel.guild_id },
    ];
    const texts = [
        name,
        ...queryHints,
        ...queryHints.map(h => `${name} ${h}`),
    ];
    const seen = new Set<string>();
    const queryTexts = texts.map(t => t.trim()).filter(t => {
        const key = t.toLowerCase();
        if (!t || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const fetchOpts = { allowFetch: true, placeholderCount: 0, allowEmptySections: true };

    for (const context of contexts) {
        for (const text of queryTexts) {
            if (signal?.aborted) throw new Error("cancelled");
            try {
                const filters = { text, commandTypes: [type] };
                let result = ApplicationCommandIndexStore.query?.(context, filters, fetchOpts);
                // Discord fills the index asynchronously when allowFetch is true.
                for (let i = 0; i < 25; i++) {
                    if (signal?.aborted) throw new Error("cancelled");
                    if (!result?.loading) break;
                    await new Promise(r => setTimeout(r, 120));
                    result = ApplicationCommandIndexStore.query?.(context, filters, fetchOpts);
                }
            } catch (err: any) {
                if (String(err?.message || err) === "cancelled") throw err;
                /* try next */
            }
        }
    }
    // Some builds never expose `.loading`; give the fetch a short settle window.
    if (!signal?.aborted) {
        await new Promise(r => setTimeout(r, 400));
    }
}

async function ensureApplicationCommand(
    channelId: string,
    name: string,
    type: number,
    signal?: AbortSignal,
    queryHints: string[] = []
): Promise<any> {
    try {
        return findApplicationCommand(channelId, name, type, queryHints);
    } catch (first) {
        await tryWarmCommandIndex(channelId, name, type, signal, queryHints);
        try {
            return findApplicationCommand(channelId, name, type, queryHints);
        } catch {
            throw first instanceof Error ? first : new Error(String(first));
        }
    }
}

function buildOptions(
    options: SlashOption[] | undefined,
    applicationCommand: any
): any[] | undefined {
    if (!options?.length) return undefined;

    const schema: any[] = applicationCommand?.options ?? [];
    return options.map(opt => {
        const def = schema.find((o: any) => o.name === opt.name);
        let type = opt.type ?? def?.type;
        if (type == null) {
            if (opt.options?.length) type = OPTION_TYPE_SUB_COMMAND;
            else if (typeof opt.value === "boolean") type = OPTION_TYPE_BOOLEAN;
            else if (/^\d{16,20}$/.test(String(opt.value)) && /user|member|target/i.test(opt.name))
                type = OPTION_TYPE_USER;
            else type = OPTION_TYPE_STRING;
        }
        // SUB_COMMAND / SUB_COMMAND_GROUP: nest child options (no top-level value).
        if (
            type === OPTION_TYPE_SUB_COMMAND ||
            type === OPTION_TYPE_SUB_COMMAND_GROUP ||
            opt.options?.length
        ) {
            const childSchema = def?.options ?? [];
            const nested = buildOptions(opt.options, { options: childSchema }) ?? [];
            return { type: type ?? OPTION_TYPE_SUB_COMMAND, name: opt.name, options: nested };
        }
        return { type, name: opt.name, value: opt.value };
    });
}

async function postApplicationCommand(body: Record<string, unknown>): Promise<void> {
    const res = await RestAPI.post({
        url: "/interactions",
        body,
        // Discord often returns 204 with empty body
        rejectWithError: false,
    } as any);

    const status = res?.status ?? res?.statusCode;
    if (status != null && status >= 400) {
        throw new Error(
            asErrorMessage(res?.body) || `interactions HTTP ${status}`
        );
    }
}

function extractAutocompleteChoices(event: any): AutocompleteChoice[] | null {
    const bags = [
        event?.choices,
        event?.data?.choices,
        event?.response?.choices,
        event?.data?.data?.choices,
        event?.data?.choices?.choices,
    ];
    for (const bag of bags) {
        if (!Array.isArray(bag)) continue;
        return bag
            .filter((c: any) => c != null && (c.name != null || c.label != null) && c.value != null)
            .map((c: any) => ({
                name: String(c.name ?? c.label ?? c.displayName ?? ""),
                value: c.value as string | number,
            }));
    }
    return null;
}

function eventNonce(event: any): string {
    return String(event?.nonce ?? event?.data?.nonce ?? event?.interactionNonce ?? "");
}

function flattenButtons(message: any): FlattenedButton[] {
    const out: FlattenedButton[] = [];

    const visit = (node: any): void => {
        if (node == null) return;
        if (Array.isArray(node)) {
            for (const child of node) visit(child);
            return;
        }
        const type = Number(node.type ?? node.componentType);
        if (type === COMPONENT_TYPE_BUTTON) {
            const label = String(node.label ?? "").trim();
            const customId = String(node.custom_id ?? node.customId ?? "").trim();
            if (label && customId) {
                out.push({
                    label,
                    customId,
                    style: node.style != null ? Number(node.style) : undefined,
                });
            }
            return;
        }
        // ACTION_ROW / containers / sections — walk children.
        if (Array.isArray(node.components)) visit(node.components);
        if (Array.isArray(node.children)) visit(node.children);
    };

    visit(message?.components);
    return out;
}

/** Last slash/interaction reply captured via waitForResponse (ephemerals have no Copy ID). */
let lastInteractionReply: {
    channelId: string;
    messageId: string;
    applicationId?: string;
    flags: number;
    buttons: FlattenedButton[];
    at: number;
} | null = null;

function rememberInteractionReply(
    summary: ReturnType<typeof summarizeInteractionMessage>
): void {
    const mid = String(summary.messageId || "").trim();
    const ch = String(summary.channelId || "").trim();
    if (!mid || !ch) return;
    lastInteractionReply = {
        channelId: ch,
        messageId: mid,
        applicationId: summary.applicationId,
        flags: Number(summary.flags ?? 0),
        buttons: Array.isArray(summary.buttons) ? summary.buttons : [],
        at: Date.now(),
    };
}

function channelMessagesNewestFirst(channelId: string): any[] {
    try {
        const bag = MessageStore.getMessages?.(channelId);
        if (!bag) return [];
        const arr =
            typeof bag.toArray === "function"
                ? bag.toArray()
                : Array.isArray(bag._array)
                  ? bag._array
                  : Array.isArray(bag)
                    ? bag
                    : [];
        return [...arr].reverse();
    } catch {
        return [];
    }
}

function findMessageWithButtonLabel(
    channelId: string,
    label: string,
    preferredMessageId?: string
): { message: any; resolvedFrom: "messageId" | "lastInteraction"; } | null {
    const want = label.trim();

    const fromLastInteraction = (): { message: any; resolvedFrom: "lastInteraction"; } | null => {
        if (
            !lastInteractionReply
            || lastInteractionReply.channelId !== channelId
            || !lastInteractionReply.buttons.some(b => b.label === want)
        ) {
            return null;
        }
        const cached = MessageStore.getMessage(channelId, lastInteractionReply.messageId);
        if (cached) return { message: cached, resolvedFrom: "lastInteraction" };
        // Ephemerals can drop out of MessageStore; waitForResponse cache is enough to click.
        if (!lastInteractionReply.applicationId) return null;
        return {
            message: {
                id: lastInteractionReply.messageId,
                channel_id: channelId,
                flags: lastInteractionReply.flags,
                application_id: lastInteractionReply.applicationId,
                components: [
                    {
                        type: 1,
                        components: lastInteractionReply.buttons.map(b => ({
                            type: COMPONENT_TYPE_BUTTON,
                            label: b.label,
                            custom_id: b.customId,
                            style: b.style,
                        })),
                    },
                ],
            },
            resolvedFrom: "lastInteraction",
        };
    };

    if (preferredMessageId) {
        const exact = MessageStore.getMessage(channelId, preferredMessageId);
        if (exact && flattenButtons(exact).some(b => b.label === want)) {
            return { message: exact, resolvedFrom: "messageId" };
        }
        // Explicit id + wait cache (MessageStore miss on ephemeral).
        if (lastInteractionReply?.messageId === preferredMessageId) {
            const hit = fromLastInteraction();
            if (hit) return { message: hit.message, resolvedFrom: "messageId" };
        }
        return null;
    }

    return fromLastInteraction();
}

function messageFromCreateEvent(event: any): any {
    return (
        event?.message
        ?? event?.data?.message
        ?? event?.data?.data?.message
        ?? event?.interaction?.message
        ?? event?.data
        ?? event
    );
}

function interactionMeta(message: any): any {
    return (
        message?.interaction
        ?? message?.interactionMetadata
        ?? message?.interaction_metadata
        ?? null
    );
}

function interactionCommandName(message: any): string {
    const meta = interactionMeta(message);
    return String(meta?.name ?? meta?.commandName ?? meta?.command_name ?? "").trim().toLowerCase();
}

function interactionUserId(message: any): string {
    const meta = interactionMeta(message);
    return String(
        meta?.user?.id
        ?? meta?.userId
        ?? meta?.user_id
        ?? ""
    );
}

function messageTimestampMs(message: any): number {
    const raw = message?.timestamp ?? message?.editedTimestamp ?? message?.edited_timestamp;
    if (raw == null) return 0;
    if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
    if (typeof raw?.valueOf === "function") {
        const n = Number(raw.valueOf());
        if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : 0;
}

function messageMatchesInteractionWait(
    message: any,
    opts: {
        channelId: string;
        nonce: string;
        commandName?: string;
        applicationId?: string;
        startedAtMs?: number;
    }
): boolean {
    if (!message?.id) return false;
    const channelId = String(message.channel_id ?? message.channelId ?? "");
    if (channelId && channelId !== opts.channelId) return false;

    // Ignore stale channel messages from earlier slash runs.
    if (opts.startedAtMs != null) {
        const ts = messageTimestampMs(message);
        if (ts > 0 && ts < opts.startedAtMs - 3000) return false;
    }

    const flags = Number(message.flags ?? 0);
    const ephemeral = (flags & MESSAGE_FLAG_EPHEMERAL) === MESSAGE_FLAG_EPHEMERAL;
    const buttons = flattenButtons(message);
    const hasUi = buttons.length > 0 || ephemeral;

    const msgAppId = String(
        message.application_id ?? message.applicationId ?? message.author?.id ?? ""
    );
    if (
        opts.applicationId
        && (message.application_id != null || message.applicationId != null)
        && msgAppId
        && msgAppId !== String(opts.applicationId)
    ) {
        return false;
    }

    // Rare on interaction replies, but definitive when Discord echoes it.
    const msgNonce = String(message.nonce ?? "");
    if (msgNonce && msgNonce === opts.nonce) return true;

    const iname = interactionCommandName(message);
    if (opts.commandName && iname && iname === opts.commandName.toLowerCase()) return true;

    // Own interaction reply (ephemeral and/or buttons). Command name is often
    // missing on newer interactionMetadata shapes.
    const interactionUser = interactionUserId(message);
    const selfId = String(UserStore.getCurrentUser()?.id ?? "");
    if (selfId && interactionUser && interactionUser === selfId && hasUi) return true;

    return false;
}

function summarizeInteractionMessage(message: any, channelId: string, applicationId?: string) {
    const mid = String(message.id);
    const ch = String(message.channel_id ?? message.channelId ?? channelId);
    const flags = Number(message.flags ?? 0);
    const buttons = flattenButtons(message);
    const appId = String(
        message.application_id
        ?? message.applicationId
        ?? message.author?.id
        ?? applicationId
        ?? ""
    );
    return {
        messageId: mid,
        channelId: ch,
        applicationId: appId || undefined,
        flags,
        buttons,
    };
}

function waitForInteractionMessage(
    opts: {
        channelId: string;
        nonce: string;
        commandName?: string;
        applicationId?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        /** When true (default), wait for buttons on ephemeral replies (Ashen edits them in). */
        requireButtons?: boolean;
    }
): Promise<any> {
    // Process /prep confirm UIs can take a few seconds; ephemerals do have ids.
    const timeoutMs = Math.max(500, opts.timeoutMs ?? 15000);
    const requireButtons = opts.requireButtons !== false;
    const startedAtMs = Date.now();
    const matchOpts = { ...opts, startedAtMs };
    return new Promise((resolve, reject) => {
        let settled = false;
        // Ephemeral create often lands without buttons; Ashen edits Confirm/Cancel in.
        let pendingWithoutButtons: any = null;
        // INTERACTION_SUCCESS often carries the ephemeral before MESSAGE_CREATE.
        const types = [
            "MESSAGE_CREATE",
            "MESSAGE_UPDATE",
            "INTERACTION_SUCCESS",
        ] as const;

        const cleanup = () => {
            if (settled) return;
            settled = true;
            for (const t of types) {
                try {
                    FluxDispatcher.unsubscribe(t, onEvent);
                } catch { /* ignore */ }
            }
            opts.signal?.removeEventListener("abort", onAbort);
            clearTimeout(timer);
            clearInterval(poll);
        };

        const finish = (message: any) => {
            if (settled) return;
            cleanup();
            resolve(message);
        };

        const tryResolve = (message: any) => {
            if (settled || !message?.id) return;
            if (!messageMatchesInteractionWait(message, matchOpts)) return;

            const buttons = flattenButtons(message);
            if (requireButtons && buttons.length === 0) {
                // Keep waiting for MESSAGE_UPDATE that adds action rows.
                pendingWithoutButtons = message;
                rememberInteractionReply(
                    summarizeInteractionMessage(message, opts.channelId, opts.applicationId)
                );
                return;
            }
            finish(message);
        };

        const scanStore = () => {
            for (const msg of channelMessagesNewestFirst(opts.channelId).slice(0, 40)) {
                tryResolve(msg);
                if (settled) return;
            }
            if (pendingWithoutButtons?.id) {
                const mid = String(pendingWithoutButtons.id);
                try {
                    const fresh = MessageStore.getMessage(opts.channelId, mid);
                    if (fresh) tryResolve(fresh);
                } catch { /* ignore */ }
            }
        };

        const onEvent = (event: any) => {
            const message = messageFromCreateEvent(event);
            if (
                pendingWithoutButtons?.id
                && message?.id
                && String(message.id) === String(pendingWithoutButtons.id)
            ) {
                // MESSAGE_UPDATE may be sparse — keep create fields, overlay update.
                tryResolve({ ...pendingWithoutButtons, ...message });
                return;
            }
            tryResolve(message);
        };

        const onAbort = () => {
            cleanup();
            reject(new Error("cancelled"));
        };

        // MessageStore poll — some ephemeral creates are easy to miss on the bus.
        const poll = setInterval(() => {
            if (settled) return;
            scanStore();
        }, 200);

        const timer = setTimeout(() => {
            scanStore();
            if (settled) return;
            // Prefer the pending ephemeral even without buttons over a hard timeout
            // with nothing — caller may still click after a short follow-up wait.
            if (pendingWithoutButtons?.id) {
                finish(pendingWithoutButtons);
                return;
            }
            cleanup();
            const recent = channelMessagesNewestFirst(opts.channelId).slice(0, 8).map(m => ({
                id: m?.id,
                flags: m?.flags,
                name: interactionCommandName(m),
                user: interactionUserId(m),
                buttons: flattenButtons(m).length,
                app: m?.application_id ?? m?.applicationId,
            }));
            reject(new Error(
                "Timed out waiting for interaction response message " +
                `(channel=${opts.channelId}, command=${opts.commandName ?? "?"}, ` +
                `app=${opts.applicationId ?? "?"}). ` +
                "Ephemeral replies do have message ids — matching failed or bot was slow. " +
                `Recent channel msgs: ${JSON.stringify(recent)}`
            ));
        }, timeoutMs);

        for (const t of types) FluxDispatcher.subscribe(t, onEvent);
        // Immediate scan in case the reply already landed.
        scanStore();
        if (opts.signal) {
            if (opts.signal.aborted) {
                onAbort();
                return;
            }
            opts.signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}

async function submitMessageComponent(opts: {
    channelId: string;
    messageId: string;
    customId: string;
    applicationId: string;
    guildId?: string;
    messageFlags?: number;
}): Promise<void> {
    const guildId = getGuildId(opts.channelId, opts.guildId);
    const body: Record<string, unknown> = {
        type: INTERACTION_MESSAGE_COMPONENT,
        application_id: opts.applicationId,
        channel_id: opts.channelId,
        message_id: opts.messageId,
        session_id: getSessionId(),
        nonce: makeNonce(),
        analytics_location: null,
        data: {
            component_type: COMPONENT_TYPE_BUTTON,
            custom_id: opts.customId,
        },
    };
    if (opts.messageFlags != null) body.message_flags = opts.messageFlags;
    if (guildId) body.guild_id = guildId;
    await postApplicationCommand(body);
}

async function waitForButtonLabelOnMessage(opts: {
    channelId: string;
    messageId: string;
    label: string;
    timeoutMs?: number;
}): Promise<any | null> {
    const want = opts.label.trim();
    const timeoutMs = Math.max(200, opts.timeoutMs ?? 8000);
    const started = Date.now();

    const read = (): any | null => {
        try {
            const msg = MessageStore.getMessage(opts.channelId, opts.messageId);
            if (msg && flattenButtons(msg).some(b => b.label === want)) return msg;
        } catch { /* ignore */ }
        if (
            lastInteractionReply?.messageId === opts.messageId
            && lastInteractionReply.channelId === opts.channelId
            && lastInteractionReply.buttons.some(b => b.label === want)
        ) {
            return {
                id: lastInteractionReply.messageId,
                channel_id: opts.channelId,
                flags: lastInteractionReply.flags,
                application_id: lastInteractionReply.applicationId,
                components: [
                    {
                        type: 1,
                        components: lastInteractionReply.buttons.map(b => ({
                            type: COMPONENT_TYPE_BUTTON,
                            label: b.label,
                            custom_id: b.customId,
                            style: b.style,
                        })),
                    },
                ],
            };
        }
        return null;
    };

    const immediate = read();
    if (immediate) return immediate;

    return new Promise(resolve => {
        let settled = false;
        const done = (msg: any | null) => {
            if (settled) return;
            settled = true;
            try {
                FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onUpdate);
            } catch { /* ignore */ }
            clearInterval(poll);
            clearTimeout(timer);
            resolve(msg);
        };
        const onUpdate = (event: any) => {
            const message = messageFromCreateEvent(event);
            if (!message?.id || String(message.id) !== opts.messageId) return;
            if (flattenButtons(message).some(b => b.label === want)) {
                rememberInteractionReply(
                    summarizeInteractionMessage(message, opts.channelId)
                );
                done(message);
            }
        };
        const poll = setInterval(() => {
            const hit = read();
            if (hit) done(hit);
        }, 150);
        const timer = setTimeout(() => done(null), Math.max(0, timeoutMs - (Date.now() - started)));
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onUpdate);
    });
}

async function clickButtonByLabel(opts: {
    channelId: string;
    messageId?: string;
    label: string;
    guildId?: string;
}): Promise<Record<string, unknown>> {
    const want = opts.label.trim();
    const preferred = String(opts.messageId || "").trim() || undefined;
    let found = findMessageWithButtonLabel(opts.channelId, want, preferred);

    // Ashen often creates the ephemeral empty, then edits Confirm/Cancel in.
    if (!found && preferred) {
        const waited = await waitForButtonLabelOnMessage({
            channelId: opts.channelId,
            messageId: preferred,
            label: want,
            timeoutMs: 8000,
        });
        if (waited) {
            found = { message: waited, resolvedFrom: "messageId" };
        }
    } else if (
        !found
        && lastInteractionReply
        && lastInteractionReply.channelId === opts.channelId
        && lastInteractionReply.messageId
    ) {
        const waited = await waitForButtonLabelOnMessage({
            channelId: opts.channelId,
            messageId: lastInteractionReply.messageId,
            label: want,
            timeoutMs: 8000,
        });
        if (waited) {
            found = { message: waited, resolvedFrom: "lastInteraction" };
        }
    }

    if (!found) {
        const hint = lastInteractionReply
            ? ` Last slash reply was ${lastInteractionReply.messageId} ` +
              `with buttons: ${lastInteractionReply.buttons.map(b => b.label).join(", ") || "(none)"}.`
            : " Run slashCommand with waitForResponse first (ephemeral Message IDs cannot be copied in Discord).";
        throw new Error(
            preferred
                ? `No message ${preferred} with button labeled ${JSON.stringify(want)}.` + hint
                : `No last slash ephemeral with button labeled ${JSON.stringify(want)} in channel ${opts.channelId}.` +
                  hint
        );
    }
    const { message, resolvedFrom } = found;
    const messageId = String(message.id);
    const buttons = flattenButtons(message);
    const button = buttons.find(b => b.label === want);
    if (!button) {
        const available = buttons.map(b => b.label).join(", ") || "(none)";
        throw new Error(
            `No button labeled ${JSON.stringify(want)} on message ${messageId}. ` +
            `Available: ${available}`
        );
    }
    const applicationId = String(
        (message as any).application_id
        ?? (message as any).applicationId
        ?? (message as any).author?.id
        ?? lastInteractionReply?.applicationId
        ?? ""
    );
    if (!applicationId) {
        throw new Error("Could not resolve application_id for button click");
    }
    const flags = Number((message as any).flags ?? 0);
    await submitMessageComponent({
        channelId: opts.channelId,
        messageId,
        customId: button.customId,
        applicationId,
        guildId: opts.guildId,
        messageFlags: flags,
    });
    return {
        messageId,
        channelId: opts.channelId,
        label: button.label,
        customId: button.customId,
        flags,
        applicationId,
        resolvedFrom,
    };
}

function waitForAutocompleteChoices(
    nonce: string,
    signal: AbortSignal | undefined,
    timeoutMs = 4500
): Promise<AutocompleteChoice[]> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const types = [
            "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE",
            "INTERACTION_SUCCESS",
            "INTERACTION_DATA_SUCCESS",
        ] as const;

        const cleanup = () => {
            if (settled) return;
            settled = true;
            for (const t of types) {
                try {
                    FluxDispatcher.unsubscribe(t, onEvent);
                } catch { /* ignore */ }
            }
            signal?.removeEventListener("abort", onAbort);
            clearTimeout(timer);
        };

        const onEvent = (event: any) => {
            if (eventNonce(event) && eventNonce(event) !== nonce) return;
            const choices = extractAutocompleteChoices(event);
            if (!choices) return;
            // Some INTERACTION_SUCCESS events are for other interactions — require nonce match when present.
            if (eventNonce(event) && eventNonce(event) !== nonce) return;
            if (!eventNonce(event)) {
                // Accept only autocomplete-shaped payloads without nonce.
                if (!Array.isArray(event?.choices) && !Array.isArray(event?.data?.choices)) return;
            }
            cleanup();
            resolve(choices);
        };

        const onAbort = () => {
            cleanup();
            reject(new Error("cancelled"));
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(
                "Autocomplete timed out waiting for Discord choices. " +
                "Open /prep once in that channel so the command index is warm, then retry."
            ));
        }, timeoutMs);

        for (const t of types) FluxDispatcher.subscribe(t, onEvent);
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}

function pickAutocompleteChoice(
    choices: AutocompleteChoice[],
    query: string,
    choiceIndex?: number
): AutocompleteChoice {
    if (!choices.length) throw new Error("No autocomplete choices returned");
    if (choiceIndex != null && choices[choiceIndex]) return choices[choiceIndex];

    const q = String(query ?? "").trim().toLowerCase();
    if (q) {
        const exactValue = choices.find(c => String(c.value).toLowerCase() === q);
        if (exactValue) return exactValue;
        const exactName = choices.find(c => c.name.toLowerCase() === q);
        if (exactName) return exactName;
        // Prefer longest name containment (e.g. query "Ships requiring crew queue message"
        // vs short labels like "Ships full").
        const containing = choices
            .filter(
                c =>
                    c.name.toLowerCase().includes(q)
                    || q.includes(c.name.toLowerCase())
                    || String(c.value).toLowerCase().includes(q)
            )
            .sort((a, b) => b.name.length - a.name.length);
        if (containing.length) return containing[0];
    }
    // Tab in Discord typically selects the first suggestion.
    return choices[0];
}

function wrapOptionsInPath(
    path: Array<{ name: string; type?: number }>,
    leafOptions: any[]
): any[] {
    let current = leafOptions;
    for (let i = path.length - 1; i >= 0; i--) {
        const parent = path[i];
        current = [
            {
                type: parent.type ?? OPTION_TYPE_SUB_COMMAND,
                name: parent.name,
                options: current,
            },
        ];
    }
    return current;
}

async function fetchAutocompleteChoices(opts: {
    channelId: string;
    guildId?: string;
    commandName: string;
    optionName: string;
    query: string;
    otherOptions?: SlashOption[];
    /** Parent SUB_COMMAND / GROUP path from the root (e.g. ``[{name:"recall"}]``). */
    optionPath?: Array<{ name: string; type?: number }>;
    /** Full root command options schema (for typing siblings at nested levels). */
    rootCommand?: any;
    signal?: AbortSignal;
    choiceIndex?: number;
}): Promise<{ choices: AutocompleteChoice[]; picked: AutocompleteChoice; commandId: string; }> {
    const pathHints = (opts.optionPath ?? []).map(p => p.name);
    const cmd = await ensureApplicationCommand(
        opts.channelId,
        opts.commandName,
        COMMAND_TYPE_CHAT_INPUT,
        opts.signal,
        [...pathHints, ...subcommandQueryHints(opts.otherOptions)]
    );
    const applicationCommand = sanitizeApplicationCommand(cmd);
    const applicationId = String(
        applicationCommand.application_id ?? cmd.application_id ?? cmd.applicationId ?? ""
    );
    const commandId = String(applicationCommand.id ?? cmd.id ?? "");
    const version = applicationCommand.version != null
        ? String(applicationCommand.version)
        : cmd.version != null
            ? String(cmd.version)
            : undefined;
    if (!applicationId || !commandId) {
        throw new Error("Resolved command is missing application_id or id");
    }

    // Walk root schema along optionPath to the focused option's parent.
    let levelSchema: any[] = cmd?.options ?? [];
    for (const segment of opts.optionPath ?? []) {
        const parentDef = levelSchema.find((o: any) => o.name === segment.name);
        levelSchema = parentDef?.options ?? [];
    }
    const focusedDef = levelSchema.find((o: any) => o.name === opts.optionName);
    const focusedType = focusedDef?.type ?? OPTION_TYPE_STRING;

    const siblingSchemaCmd = { options: levelSchema };
    const leafPayload: any[] = [];
    for (const opt of opts.otherOptions ?? []) {
        if (opt.name === opts.optionName) continue;
        const built = buildOptions([opt], siblingSchemaCmd);
        if (built?.[0]) leafPayload.push(built[0]);
    }
    leafPayload.push({
        type: focusedType,
        name: opts.optionName,
        value: opts.query,
        focused: true,
    });
    const optionPayload = wrapOptionsInPath(opts.optionPath ?? [], leafPayload);

    const guildId = getGuildId(opts.channelId, opts.guildId);
    const integrationType = pickIntegrationType(cmd, guildId);
    const nonce = makeNonce();
    const localAbort = new AbortController();
    const onOuterAbort = () => localAbort.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    if (opts.signal?.aborted) localAbort.abort();

    applicationCommand.id = commandId;
    applicationCommand.application_id = applicationId;
    applicationCommand.type = COMMAND_TYPE_CHAT_INPUT;
    if (version != null) applicationCommand.version = version;
    applicationCommand.name = opts.commandName;

    const body: Record<string, unknown> = {
        type: INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE,
        application_id: applicationId,
        channel_id: opts.channelId,
        session_id: getSessionId(),
        nonce,
        analytics_location: null,
        context: guildId != null ? INTERACTION_CONTEXT_GUILD : 1,
        integration_type: integrationType,
        data: {
            version,
            id: commandId,
            name: opts.commandName,
            type: COMMAND_TYPE_CHAT_INPUT,
            options: optionPayload,
            application_command: applicationCommand,
            attachments: [],
        },
    };
    if (guildId) body.guild_id = guildId;

    const pending = waitForAutocompleteChoices(nonce, localAbort.signal);
    try {
        await postApplicationCommand(body);
        const choices = await pending;
        const picked = pickAutocompleteChoice(choices, opts.query, opts.choiceIndex);
        return { choices, picked, commandId };
    } catch (err) {
        localAbort.abort();
        throw err;
    } finally {
        opts.signal?.removeEventListener("abort", onOuterAbort);
    }
}

async function resolveSlashOptions(
    channelId: string,
    guildId: string | undefined,
    commandName: string,
    cmd: any,
    options: SlashOption[] | undefined,
    signal?: AbortSignal,
    choiceIndex?: number,
    optionPath: Array<{ name: string; type?: number }> = []
): Promise<{ options: SlashOption[]; resolutions: Record<string, AutocompleteChoice>; }> {
    const built = buildOptions(options, cmd) ?? [];
    if (!built.length) return { options: [], resolutions: {} };

    const schema: any[] = cmd?.options ?? [];
    const resolutions: Record<string, AutocompleteChoice> = {};
    const out: SlashOption[] = [];

    for (const opt of built) {
        const def = schema.find((o: any) => o.name === opt.name);
        // Preserve SUB_COMMAND nesting; resolve autocomplete on leaf options only.
        if (
            opt.type === OPTION_TYPE_SUB_COMMAND ||
            opt.type === OPTION_TYPE_SUB_COMMAND_GROUP ||
            Array.isArray(opt.options)
        ) {
            const nestedIn = (options?.find(o => o.name === opt.name)?.options
                ?? opt.options) as SlashOption[] | undefined;
            const nested = await resolveSlashOptions(
                channelId,
                guildId,
                commandName,
                { options: def?.options ?? [] },
                nestedIn,
                signal,
                choiceIndex,
                [
                    ...optionPath,
                    {
                        name: opt.name,
                        type: opt.type ?? OPTION_TYPE_SUB_COMMAND,
                    },
                ]
            );
            Object.assign(resolutions, nested.resolutions);
            out.push({
                name: opt.name,
                type: opt.type ?? OPTION_TYPE_SUB_COMMAND,
                options: nested.options,
            });
            continue;
        }

        const wantsAuto =
            options?.find(o => o.name === opt.name)?.autocomplete === true ||
            def?.autocomplete === true;

        if (!wantsAuto) {
            out.push({ name: opt.name, type: opt.type, value: opt.value });
            continue;
        }

        const { picked } = await fetchAutocompleteChoices({
            channelId,
            guildId,
            commandName,
            optionName: opt.name,
            query: String(opt.value ?? ""),
            otherOptions: options?.filter(o => o.name !== opt.name),
            optionPath,
            signal,
            choiceIndex,
        });
        resolutions[opt.name] = picked;
        // Discord STRING options must be strings — choice values may be numbers.
        out.push({ name: opt.name, type: opt.type, value: String(picked.value) });
    }

    return { options: out, resolutions };
}

async function submitApplicationCommand(opts: {
    channelId: string;
    guildId?: string;
    name: string;
    commandType: number;
    targetId?: string;
    options?: SlashOption[];
    signal?: AbortSignal;
    choiceIndex?: number;
    waitForResponse?: boolean;
    waitMs?: number;
}): Promise<Record<string, unknown>> {
    const queryHints = subcommandQueryHints(opts.options);
    const cmd = await ensureApplicationCommand(
        opts.channelId,
        opts.name,
        opts.commandType,
        opts.signal,
        queryHints
    );
    const applicationCommand = sanitizeApplicationCommand(cmd);
    const applicationId = String(
        applicationCommand.application_id ?? cmd.application_id ?? cmd.applicationId ?? ""
    );
    const commandId = String(applicationCommand.id ?? cmd.id ?? "");
    const version = applicationCommand.version != null
        ? String(applicationCommand.version)
        : cmd.version != null
            ? String(cmd.version)
            : undefined;
    if (!applicationId || !commandId) {
        throw new Error("Resolved command is missing application_id or id");
    }

    const guildId = getGuildId(opts.channelId, opts.guildId);
    const sessionId = getSessionId();
    const integrationType = pickIntegrationType(cmd, guildId);

    let resolvedOptions = opts.options;
    let resolutions: Record<string, AutocompleteChoice> = {};
    if (opts.commandType === COMMAND_TYPE_CHAT_INPUT && opts.options?.length) {
        const resolved = await resolveSlashOptions(
            opts.channelId,
            guildId,
            opts.name,
            cmd,
            opts.options,
            opts.signal,
            opts.choiceIndex
        );
        resolvedOptions = resolved.options;
        resolutions = resolved.resolutions;
    }

    const options = buildOptions(resolvedOptions, cmd);

    applicationCommand.id = commandId;
    applicationCommand.application_id = applicationId;
    applicationCommand.type = opts.commandType;
    if (version != null) applicationCommand.version = version;
    // Always use the requested root name (index may have matched a subcommand leaf).
    applicationCommand.name = opts.name;

    const data: Record<string, unknown> = {
        version,
        id: commandId,
        name: opts.name,
        type: opts.commandType,
        options: options ?? [],
        application_command: applicationCommand,
        attachments: [],
    };
    if (opts.targetId) {
        data.target_id = String(opts.targetId);
        const resolved = messageResolvedPayload(opts.channelId, String(opts.targetId));
        if (resolved) data.resolved = resolved;
    }

    const nonce = makeNonce();
    const body: Record<string, unknown> = {
        type: INTERACTION_APPLICATION_COMMAND,
        application_id: applicationId,
        channel_id: opts.channelId,
        session_id: sessionId,
        nonce,
        analytics_location: null,
        context: guildId != null ? INTERACTION_CONTEXT_GUILD : 1,
        integration_type: integrationType,
        data,
    };
    if (guildId) body.guild_id = guildId;

    const commandName = String(applicationCommand.name ?? opts.name);
    const waitAbort = new AbortController();
    const onOuterAbort = () => waitAbort.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    if (opts.signal?.aborted) waitAbort.abort();

    let pendingMessage: Promise<any> | null = null;
    if (opts.waitForResponse) {
        pendingMessage = waitForInteractionMessage({
            channelId: opts.channelId,
            nonce,
            commandName,
            applicationId,
            signal: waitAbort.signal,
            timeoutMs: opts.waitMs ?? 15000,
        });
    }

    try {
        await postApplicationCommand(body);
        const meta: Record<string, unknown> = {
            applicationId,
            commandId,
            version,
            name: commandName,
            commandType: opts.commandType,
            integrationType,
            options: options ?? [],
            resolutions,
            nonce,
        };
        if (pendingMessage) {
            const message = await pendingMessage;
            const summary = summarizeInteractionMessage(message, opts.channelId, applicationId);
            rememberInteractionReply(summary);
            Object.assign(meta, summary);
            if (!meta.messageId) {
                throw new Error("Interaction response message missing id");
            }
        }
        return meta;
    } catch (err) {
        waitAbort.abort();
        throw err;
    } finally {
        opts.signal?.removeEventListener("abort", onOuterAbort);
    }
}

export async function handleAction(
    req: BridgeRequest,
    signal?: AbortSignal
): Promise<Omit<BridgeResponse, "id" | "ok" | "error">> {
    switch (req.type) {
        case "ping": {
            const delayMs = Math.max(0, Number(req.delayMs) || 0);
            if (delayMs > 0) {
                const step = 50;
                const end = Date.now() + delayMs;
                while (Date.now() < end) {
                    if (signal?.aborted) throw new Error("cancelled");
                    await new Promise(r => setTimeout(r, Math.min(step, end - Date.now())));
                }
            }
            return { pong: true, delayMs, version: "2026.33.4", plugin: "AshenMacrosBridge" };
        }

        case "react": {
            if (!req.channelId || !req.messageId) throw new Error("channelId and messageId are required");
            const emoji = normalizeEmoji(req.emoji);
            await addReaction(req.channelId, req.messageId, emoji);
            return { emoji };
        }

        case "edit": {
            if (!req.channelId || !req.messageId) throw new Error("channelId and messageId are required");
            if (req.content == null) throw new Error("content is required");
            await MessageActions.editMessage(req.channelId, req.messageId, { content: req.content });
            return {};
        }

        case "send": {
            if (!req.channelId) throw new Error("channelId is required");
            if (req.content == null) throw new Error("content is required");
            // Must pass options (4th arg); Discord reads options.nonce and crashes if options is undefined.
            await vencordSendMessage(req.channelId, { content: req.content });
            return {};
        }

        case "switchChannel": {
            if (!req.channelId) throw new Error("channelId is required");
            ChannelRouter.transitionToChannel(req.channelId);
            return { channelId: req.channelId };
        }

        case "messageCommand": {
            if (!req.channelId || !req.messageId) throw new Error("channelId and messageId are required");
            const name = req.name?.trim() || "update bonus";
            const meta = await submitApplicationCommand({
                channelId: req.channelId,
                guildId: req.guildId,
                name,
                commandType: COMMAND_TYPE_MESSAGE,
                targetId: req.messageId,
                signal,
            });
            return meta;
        }

        case "slashCommand": {
            if (!req.channelId) throw new Error("channelId is required");
            if (!req.name?.trim()) throw new Error("name is required");
            const waitForResponse =
                req.waitForResponse === true
                || req.waitForResponse === 1
                || String(req.waitForResponse).toLowerCase() === "true";
            const meta = await submitApplicationCommand({
                channelId: req.channelId,
                guildId: req.guildId,
                name: req.name.trim(),
                commandType: COMMAND_TYPE_CHAT_INPUT,
                options: req.options,
                signal,
                choiceIndex: req.choiceIndex,
                waitForResponse,
                waitMs: req.waitMs != null ? Number(req.waitMs) : undefined,
            });
            if (waitForResponse && !String(meta.messageId || "").trim()) {
                throw new Error(
                    "slashCommand waitForResponse was set but messageId is missing — " +
                    "ephemeral match failed after submit"
                );
            }
            return meta;
        }

        case "clickButton": {
            if (!req.channelId) throw new Error("channelId is required");
            if (!req.label?.trim()) throw new Error("label is required");
            // messageId optional: uses last waitForResponse ephemeral (Copy ID unavailable).
            return await clickButtonByLabel({
                channelId: req.channelId,
                messageId: req.messageId ? String(req.messageId) : undefined,
                label: req.label.trim(),
                guildId: req.guildId,
            });
        }

        case "autocomplete": {
            if (!req.channelId) throw new Error("channelId is required");
            if (!req.name?.trim()) throw new Error("name (command) is required");
            if (!req.optionName?.trim()) throw new Error("optionName is required");
            const query = req.query != null ? String(req.query) : "";
            const result = await fetchAutocompleteChoices({
                channelId: req.channelId,
                guildId: req.guildId,
                commandName: req.name.trim(),
                optionName: req.optionName.trim(),
                query,
                otherOptions: req.options,
                signal,
                choiceIndex: req.choiceIndex,
            });
            return {
                choices: result.choices,
                picked: result.picked,
                commandId: result.commandId,
                optionName: req.optionName.trim(),
                query,
            };
        }

        default:
            throw new Error(`Unknown action type: ${(req as BridgeRequest).type}`);
    }
}

export { asErrorMessage, COMMAND_TYPE_CHAT_INPUT, COMMAND_TYPE_MESSAGE };
