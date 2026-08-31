/*
 * AshenMacrosBridge — Vencord userplugin
 * Localhost WebSocket bridge for Ashen Macros. Webpack modules only (no DOM).
 *
 * Main↔renderer uses PluginNative IPC (dequeue/complete), not executeJavaScript.
 * Follows Vencord lifecycle: start/stop balance, abort in-flight work on stop.
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import { asErrorMessage, handleAction, resetBridgeState } from "./actions";
import type { BridgeRequest, BridgeResponse } from "./types";

const PLUGIN_NAME = "AshenMacrosBridge";
const logger = new Logger(PLUGIN_NAME);

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Localhost WebSocket port (must match Ashen Macros Experimental bridge port)",
        default: 47832,
        restartNeeded: true,
    },
    authToken: {
        type: OptionType.STRING,
        description:
            "Shared secret for Ashen Macros ↔ plugin auth. NOT your Discord token or Ashen API token.",
        default: "change-me",
        restartNeeded: true,
    },
});

type NativeApi = PluginNative<typeof import("./native")>;

function getNative(): NativeApi | null {
    try {
        const helpers = (VencordNative as any)?.pluginHelpers?.[PLUGIN_NAME];
        return (helpers as NativeApi) ?? null;
    } catch {
        return null;
    }
}

/** In-flight request ids → AbortController for cancel cooperation */
const inflight = new Map<string, AbortController>();

/** Stops the renderer dequeue pump */
let pumpAbort: AbortController | null = null;

function cancelledResponse(id: string): BridgeResponse {
    return { id, ok: false, error: "cancelled", cancelled: true };
}

async function dispatchRequest(raw: BridgeRequest): Promise<BridgeResponse> {
    const id = raw?.id != null ? String(raw.id) : "";
    if (!id) {
        return { id: "", ok: false, error: "Missing request id" };
    }

    if (raw.type === "auth") {
        // Auth is handled in native.ts; renderer should not see bare auth often.
        return { id, ok: true, authenticated: true };
    }

    if (raw.type === "cancel") {
        // Python sends {"id": <targetRequestId>, "type": "cancel"} — treat id as target
        // when targetId/cancelId are omitted.
        const target = String(raw.targetId ?? raw.cancelId ?? id);
        if (!target) {
            for (const [, ac] of inflight) ac.abort();
            inflight.clear();
            return { id, ok: true, cancelled: "all" };
        }
        const ac = inflight.get(target);
        if (ac) {
            ac.abort();
            inflight.delete(target);
            return { id, ok: true, cancelled: target };
        }
        // Still report success so the client unblocks; nothing may be in-flight anymore.
        return { id, ok: true, cancelled: target, note: "no matching in-flight op" };
    }

    const ac = new AbortController();
    inflight.set(id, ac);

    try {
        const data = await handleAction(raw, ac.signal);
        if (ac.signal.aborted) {
            return cancelledResponse(id);
        }
        return { id, ok: true, ...data };
    } catch (err) {
        if (ac.signal.aborted || asErrorMessage(err) === "cancelled") {
            return cancelledResponse(id);
        }
        return { id, ok: false, error: asErrorMessage(err) };
    } finally {
        inflight.delete(id);
    }
}

/**
 * Pull requests from native (WS server) via IPC. Concurrent handlers are OK —
 * dequeue is serialized, work is not. Idle = waiting on dequeueRequest only.
 */
async function runRequestPump(native: NativeApi, signal: AbortSignal) {
    while (!signal.aborted) {
        let req: BridgeRequest | null = null;
        try {
            req = (await native.dequeueRequest(30_000)) as BridgeRequest | null;
        } catch (err) {
            if (signal.aborted) break;
            logger.warn("dequeueRequest failed:", err);
            await new Promise(r => setTimeout(r, 250));
            continue;
        }
        if (signal.aborted) break;
        if (!req || typeof req !== "object") continue;

        const id = req.id != null ? String(req.id) : "";
        void (async () => {
            let response: BridgeResponse;
            try {
                response = await dispatchRequest(req);
            } catch (err) {
                response = { id, ok: false, error: asErrorMessage(err) };
            }
            try {
                await native.completeRequest(id, response);
            } catch (err) {
                if (!signal.aborted) {
                    logger.warn("completeRequest failed:", err);
                }
            }
        })();
    }
}

async function startBridge() {
    const native = getNative();
    if (!native) {
        logger.error("Native module unavailable — Discord Desktop / Vesktop required for the WS server");
        return;
    }

    const port = Number(settings.store.port) || 47832;
    const token = String(settings.store.authToken || "change-me");
    if (token === "change-me") {
        logger.error(
            "authToken is still the default \"change-me\". Set a shared secret in plugin settings and Ashen Macros Experimental before production use."
        );
    }

    await native.startServer(port, token);

    pumpAbort?.abort();
    pumpAbort = new AbortController();
    const signal = pumpAbort.signal;
    void runRequestPump(native, signal).catch(err => {
        if (!signal.aborted) logger.error("Request pump crashed:", err);
    });
}

async function stopBridge() {
    pumpAbort?.abort();
    pumpAbort = null;

    for (const [, ac] of inflight) ac.abort();
    inflight.clear();
    resetBridgeState();

    try {
        const native = getNative();
        await native?.stopServer();
    } catch (err) {
        logger.error("Failed to stop bridge server:", err);
    }
}

export default definePlugin({
    name: "AshenMacrosBridge",
    description:
        "Localhost WebSocket bridge for Ashen Macros — react/edit/send/channel switch and app commands via webpack modules (no DOM).",
    authors: [{ name: "koetsmax", id: 0n }],
    settings,

    async start() {
        try {
            await startBridge();
        } catch (err) {
            logger.error("Failed to start bridge:", err);
        }
    },

    async stop() {
        await stopBridge();
    },
});
