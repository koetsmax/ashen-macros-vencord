/*
 * AshenMacrosBridge — Vencord userplugin
 * Localhost WebSocket bridge for Ashen Macros. Webpack modules only (no DOM).
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import { asErrorMessage, handleAction } from "./actions";
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

function cancelledResponse(id: string): BridgeResponse {
    return { id, ok: false, error: "cancelled" };
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
        const target = String(raw.targetId ?? raw.cancelId ?? "");
        if (!target) {
            // Cancel everything currently in flight
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
        return { id, ok: true, cancelled: target, note: "no matching in-flight op" };
    }

    if (raw.type === "ping") {
        const started = Date.now();
        return { id, ok: true, pong: true, latencyMs: Date.now() - started };
    }

    const ac = new AbortController();
    inflight.set(id, ac);

    try {
        const data = await handleAction(raw);
        if (ac.signal.aborted) {
            return cancelledResponse(id);
        }
        return { id, ok: true, ...data };
    } catch (err) {
        if (ac.signal.aborted) {
            return cancelledResponse(id);
        }
        return { id, ok: false, error: asErrorMessage(err) };
    } finally {
        inflight.delete(id);
    }
}

async function startBridge() {
    const native = getNative();
    if (!native) {
        logger.error("Native module unavailable — Discord Desktop / Vesktop required for the WS server");
        return;
    }

    (window as any).__AshenMacrosBridgeHandle = (req: BridgeRequest) => dispatchRequest(req);

    const port = Number(settings.store.port) || 47832;
    const token = String(settings.store.authToken || "change-me");
    if (token === "change-me") {
        logger.error(
            "authToken is still the default \"change-me\". Set a shared secret in plugin settings and Ashen Macros Experimental before production use."
        );
    }

    await native.startServer(port, token);
}

async function stopBridge() {
    for (const [, ac] of inflight) ac.abort();
    inflight.clear();

    delete (window as any).__AshenMacrosBridgeHandle;

    try {
        const native = getNative();
        await native?.stopServer();
    } catch (err) {
        logger.error("Failed to stop bridge server:", err);
    }
}

export default definePlugin({
    name: PLUGIN_NAME,
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
