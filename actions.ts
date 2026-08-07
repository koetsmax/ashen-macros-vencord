/*
 * Discord webpack helpers for AshenMacrosBridge.
 * No DOM. Prefer @webpack/common; finders only at module scope.
 */

import { findByPropsLazy } from "@webpack";
import {
    ApplicationCommandIndexStore,
    ChannelRouter,
    ChannelStore,
    MessageActions,
    NavigationRouter,
    RestAPI,
} from "@webpack/common";

import type { BridgeRequest, BridgeResponse, EmojiRef, SlashOption } from "./types";

/** Application command types */
const COMMAND_TYPE_CHAT_INPUT = 1;
const COMMAND_TYPE_MESSAGE = 3;

/** Interaction type: APPLICATION_COMMAND */
const INTERACTION_APPLICATION_COMMAND = 2;

/** Option type defaults when the client omits `type` */
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

function commandMatches(cmd: any, name: string, type: number): boolean {
    if (!cmd) return false;
    const n = (cmd.name ?? cmd.displayName ?? "").toLowerCase();
    if (n !== name.toLowerCase()) return false;
    const t = cmd.type ?? cmd.inputType;
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
            if (typeof opt.value === "boolean") type = OPTION_TYPE_BOOLEAN;
            else if (/^\d{16,20}$/.test(String(opt.value)) && /user|member|target/i.test(opt.name))
                type = OPTION_TYPE_USER;
            else type = OPTION_TYPE_STRING;
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

async function submitApplicationCommand(opts: {
    channelId: string;
    guildId?: string;
    name: string;
    commandType: number;
    targetId?: string;
    options?: SlashOption[];
}): Promise<BridgeResponse["data"] & object> {
    const cmd = findApplicationCommand(opts.channelId, opts.name, opts.commandType);
    const applicationId = cmd.application_id ?? cmd.applicationId;
    const commandId = cmd.id;
    const version = cmd.version;
    if (!applicationId || !commandId) {
        throw new Error("Resolved command is missing application_id or id");
    }

    const guildId = getGuildId(opts.channelId, opts.guildId);
    const sessionId = getSessionId();
    const options = buildOptions(opts.options, cmd);

    const data: Record<string, unknown> = {
        version,
        id: commandId,
        name: cmd.name ?? opts.name,
        type: opts.commandType,
        options,
        application_command: cmd,
    };
    if (opts.targetId) data.target_id = opts.targetId;

    const body: Record<string, unknown> = {
        type: INTERACTION_APPLICATION_COMMAND,
        application_id: applicationId,
        channel_id: opts.channelId,
        session_id: sessionId,
        nonce: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        analytics_location: null,
        data,
    };
    if (guildId) body.guild_id = guildId;

    await postApplicationCommand(body);
    return {
        applicationId,
        commandId,
        version,
        name: cmd.name ?? opts.name,
        commandType: opts.commandType,
    };
}

export async function handleAction(req: BridgeRequest): Promise<Omit<BridgeResponse, "id" | "ok" | "error">> {
    switch (req.type) {
        case "ping":
            return { pong: true };

        case "react": {
            if (!req.channelId || !req.messageId) throw new Error("channelId and messageId are required");
            const emoji = normalizeEmoji(req.emoji);
            await MessageActions.addReaction(req.channelId, req.messageId, emoji, { location: "Message" });
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
            await MessageActions.sendMessage(req.channelId, {
                content: req.content,
                invalidEmojis: [],
                tts: false,
                validNonShortcutEmojis: [],
            });
            return {};
        }

        case "switchChannel": {
            if (!req.channelId) throw new Error("channelId is required");
            if (typeof ChannelRouter?.transitionToChannel === "function") {
                ChannelRouter.transitionToChannel(req.channelId);
            } else {
                const guildId = getGuildId(req.channelId, req.guildId) ?? "@me";
                NavigationRouter.transitionTo(`/channels/${guildId}/${req.channelId}`);
            }
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
            });
            return meta;
        }

        default:
            throw new Error(`Unknown action type: ${(req as BridgeRequest).type}`);
    }
}

export { asErrorMessage, COMMAND_TYPE_CHAT_INPUT, COMMAND_TYPE_MESSAGE };
