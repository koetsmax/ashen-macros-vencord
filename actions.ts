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
    SlashOption,
} from "./types";

/** Application command types */
const COMMAND_TYPE_CHAT_INPUT = 1;
const COMMAND_TYPE_MESSAGE = 3;

/** Interaction type: APPLICATION_COMMAND */
const INTERACTION_APPLICATION_COMMAND = 2;
/** Interaction type: APPLICATION_COMMAND_AUTOCOMPLETE */
const INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE = 4;

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

function commandMatches(cmd: any, name: string, type: number): boolean {
    if (!cmd) return false;
    const n = (cmd.name ?? cmd.displayName ?? "").toLowerCase();
    if (n !== name.toLowerCase()) return false;
    const t = cmd.type ?? cmd.inputType;
    // MESSAGE / USER context commands must match type exactly — a null type is not good enough.
    if (type === COMMAND_TYPE_MESSAGE || type === 2) {
        return t === type;
    }
    return t == null || t === type;
}

/**
 * Resolve an application command from the client index.
 * Query shape varies across Discord builds — try several entry points.
 */
function findApplicationCommand(channelId: string, name: string, type: number): any {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const guildId = channel.guild_id;
    const contexts: any[] = [
        { channel, type: 0 },
        { channelId, guildId },
        channel,
    ];

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

    for (const context of contexts) {
        try {
            const queried =
                ApplicationCommandIndexStore.query?.(
                    context,
                    { text: name, commandTypes: [type], type },
                    { limit: 50 }
                ) ??
                ApplicationCommandIndexStore.query?.(
                    context,
                    { text: name },
                    { limit: 50 }
                );
            const hit = collectFromQuery(queried).find(c => commandMatches(c, name, type));
            if (hit) return hit;
        } catch {
            /* try next context shape */
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
        const commands: any[] =
            state.commands ??
            state.applicationCommands ??
            (state.descriptors ? Object.values(state.descriptors) : []) ??
            [];
        const flat = Array.isArray(commands)
            ? commands
            : Object.values(commands as Record<string, any>);
        const hit = flat.find(c => commandMatches(c, name, type));
        if (hit) return hit;
    }

    throw new Error(
        `Application command not found in index: name="${name}" type=${type}. ` +
        "Open the Apps / slash menu once in that channel so Discord loads the command index, then retry."
    );
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
        const containing = choices.filter(
            c => c.name.toLowerCase().includes(q) || String(c.value).toLowerCase().includes(q)
        );
        if (containing.length) return containing[0];
    }
    // Tab in Discord typically selects the first suggestion.
    return choices[0];
}

async function fetchAutocompleteChoices(opts: {
    channelId: string;
    guildId?: string;
    commandName: string;
    optionName: string;
    query: string;
    otherOptions?: SlashOption[];
    signal?: AbortSignal;
    choiceIndex?: number;
}): Promise<{ choices: AutocompleteChoice[]; picked: AutocompleteChoice; commandId: string; }> {
    const cmd = findApplicationCommand(opts.channelId, opts.commandName, COMMAND_TYPE_CHAT_INPUT);
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

    const schema: any[] = cmd?.options ?? [];
    const focusedDef = schema.find((o: any) => o.name === opts.optionName);
    const focusedType = focusedDef?.type ?? OPTION_TYPE_STRING;

    const optionPayload: any[] = [];
    for (const opt of opts.otherOptions ?? []) {
        if (opt.name === opts.optionName) continue;
        const built = buildOptions([opt], cmd);
        if (built?.[0]) optionPayload.push(built[0]);
    }
    optionPayload.push({
        type: focusedType,
        name: opts.optionName,
        value: opts.query,
        focused: true,
    });

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
    if (applicationCommand.name == null) applicationCommand.name = cmd.name ?? opts.commandName;

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
            name: applicationCommand.name ?? opts.commandName,
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
    choiceIndex?: number
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
                choiceIndex
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
            signal,
            choiceIndex,
        });
        resolutions[opt.name] = picked;
        out.push({ name: opt.name, type: opt.type, value: picked.value });
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
}): Promise<BridgeResponse["data"] & object> {
    const cmd = findApplicationCommand(opts.channelId, opts.name, opts.commandType);
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
    if (applicationCommand.name == null) applicationCommand.name = cmd.name ?? opts.name;

    const data: Record<string, unknown> = {
        version,
        id: commandId,
        name: applicationCommand.name ?? opts.name,
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

    const body: Record<string, unknown> = {
        type: INTERACTION_APPLICATION_COMMAND,
        application_id: applicationId,
        channel_id: opts.channelId,
        session_id: sessionId,
        nonce: makeNonce(),
        analytics_location: null,
        context: guildId != null ? INTERACTION_CONTEXT_GUILD : 1,
        integration_type: integrationType,
        data,
    };
    if (guildId) body.guild_id = guildId;

    await postApplicationCommand(body);
    return {
        applicationId,
        commandId,
        version,
        name: applicationCommand.name ?? opts.name,
        commandType: opts.commandType,
        integrationType,
        options: options ?? [],
        resolutions,
    };
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
            return { pong: true, delayMs };
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
            const meta = await submitApplicationCommand({
                channelId: req.channelId,
                guildId: req.guildId,
                name: req.name.trim(),
                commandType: COMMAND_TYPE_CHAT_INPUT,
                options: req.options,
                signal,
                choiceIndex: req.choiceIndex,
            });
            return meta;
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
