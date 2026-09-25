/*
 * Native (Electron main) WebSocket server for AshenMacrosBridge.
 * Binds 127.0.0.1 only. No npm deps — minimal RFC6455 text frames via Node http.
 *
 * Renderer traffic uses PluginNative IPC (dequeueRequest / completeRequest), not
 * webContents.executeJavaScript — avoids compiling a new script per request and
 * keeps idle connections off the Discord UI thread.
 */

import { createHash, timingSafeEqual } from "crypto";
import { IpcMainInvokeEvent } from "electron";
import { createServer, IncomingMessage, Server } from "http";
import type { Duplex } from "net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HOST = "127.0.0.1";
/** Keep in sync with package.json — shown in Ashen Macros hub Bridge status.
 *  Must NOT be exported: Vencord registers every native export as ipcMain.handle().
 */
const BRIDGE_VERSION = "2026.38.0";

const MAX_SOCKET_BUFFER = 1024 * 1024;
const MAX_REQUEST_QUEUE = 32;
const RENDERER_REPLY_TIMEOUT_MS = 180_000;

let httpServer: Server | null = null;
let authToken = "";
const sockets = new Set<Duplex>();

type DequeueWaiter = {
    resolve: (req: unknown | null) => void;
    timer: ReturnType<typeof setTimeout>;
};

type ReplyWaiter = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

/** WS → renderer: queued until the renderer pump dequeues. */
const requestQueue: unknown[] = [];
const dequeueWaiters: DequeueWaiter[] = [];
/** id → promise waiting for renderer completeRequest. */
const replyWaiters = new Map<string, ReplyWaiter>();

function tokensEqual(a: string, b: string): boolean {
    if (!a || !b) return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    try {
        return timingSafeEqual(ba, bb);
    } catch {
        return false;
    }
}

function acceptKey(key: string): string {
    return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, "utf8");
    const len = payload.length;
    if (len < 126) {
        const frame = Buffer.allocUnsafe(2 + len);
        frame[0] = 0x81;
        frame[1] = len;
        payload.copy(frame, 2);
        return frame;
    }
    if (len < 65536) {
        const frame = Buffer.allocUnsafe(4 + len);
        frame[0] = 0x81;
        frame[1] = 126;
        frame.writeUInt16BE(len, 2);
        payload.copy(frame, 4);
        return frame;
    }
    const frame = Buffer.allocUnsafe(10 + len);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(len, 6);
    payload.copy(frame, 10);
    return frame;
}

function encodeCloseFrame(code = 1000, reason = ""): Buffer {
    const reasonBuf = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    const frame = Buffer.allocUnsafe(2 + payload.length);
    frame[0] = 0x88;
    frame[1] = payload.length;
    payload.copy(frame, 2);
    return frame;
}

interface Decoded {
    opcode: number;
    payload: Buffer;
    rest: Buffer;
}

function tryDecodeFrame(buf: Buffer): Decoded | null {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
        if (buf.length < 4) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buf.length < 10) return null;
        // only support lengths that fit in JS safe integer low 32 bits
        const high = buf.readUInt32BE(2);
        const low = buf.readUInt32BE(6);
        if (high !== 0) return null;
        len = low;
        offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
    }
    return {
        opcode,
        payload,
        rest: buf.subarray(offset + maskLen + len),
    };
}

function sendJson(socket: Duplex, obj: unknown) {
    if (socket.destroyed) return;
    try {
        socket.write(encodeTextFrame(JSON.stringify(obj)));
    } catch {
        /* ignore */
    }
}

function wakeDequeueWaiters(value: unknown | null) {
    while (dequeueWaiters.length) {
        const w = dequeueWaiters.shift()!;
        clearTimeout(w.timer);
        w.resolve(value);
    }
}

function clearReplyWaiters(reason: string) {
    for (const [, w] of replyWaiters) {
        clearTimeout(w.timer);
        w.reject(new Error(reason));
    }
    replyWaiters.clear();
}

function clearRequestQueue() {
    requestQueue.length = 0;
    wakeDequeueWaiters(null);
}

/**
 * Renderer pump: wait for the next WS request (or null on timeout / shutdown).
 * Idle = one pending IPC promise in main — no Discord UI work.
 */
export async function dequeueRequest(
    _event: IpcMainInvokeEvent,
    timeoutMs = 30_000
): Promise<unknown | null> {
    if (!httpServer) return null;
    if (requestQueue.length) return requestQueue.shift() ?? null;

    const waitMs = Math.max(1000, Math.min(120_000, Number(timeoutMs) || 30_000));
    return new Promise(resolve => {
        const waiter: DequeueWaiter = {
            resolve,
            timer: setTimeout(() => {
                const i = dequeueWaiters.indexOf(waiter);
                if (i >= 0) dequeueWaiters.splice(i, 1);
                resolve(null);
            }, waitMs),
        };
        dequeueWaiters.push(waiter);
    });
}

/** Renderer → main: finish a dequeued request so the WS client gets its response. */
export async function completeRequest(
    _event: IpcMainInvokeEvent,
    id: string,
    response: unknown
): Promise<void> {
    const key = String(id || "");
    const pending = replyWaiters.get(key);
    if (!pending) return;
    replyWaiters.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(response);
}

function enqueueForRenderer(request: unknown): Promise<unknown> {
    const id = String((request as { id?: unknown; })?.id ?? "");
    if (!id) {
        return Promise.reject(new Error("Missing request id"));
    }
    if (replyWaiters.has(id)) {
        return Promise.reject(new Error(`Duplicate in-flight request id: ${id}`));
    }
    if (requestQueue.length >= MAX_REQUEST_QUEUE && dequeueWaiters.length === 0) {
        return Promise.reject(new Error("Renderer request queue full — is the plugin pump running?"));
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            replyWaiters.delete(id);
            reject(new Error("Timed out waiting for renderer to handle bridge request"));
        }, RENDERER_REPLY_TIMEOUT_MS);

        replyWaiters.set(id, { resolve, reject, timer });

        if (dequeueWaiters.length) {
            const w = dequeueWaiters.shift()!;
            clearTimeout(w.timer);
            w.resolve(request);
        } else {
            requestQueue.push(request);
        }
    });
}

function parseTokenFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url, "http://127.0.0.1");
        return u.searchParams.get("token");
    } catch {
        return null;
    }
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer) {
    const key = req.headers["sec-websocket-key"];
    if (!key || typeof key !== "string") {
        socket.destroy();
        return;
    }

    const remote = req.socket.remoteAddress;
    if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
    }

    const queryToken = parseTokenFromUrl(req.url);
    let authenticated = !!(queryToken && tokensEqual(queryToken, authToken));

    const headers =
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        "\r\n";

    socket.write(headers);
    sockets.add(socket);

    sendJson(socket, {
        type: "hello",
        needsAuth: !authenticated,
        plugin: "AshenMacrosBridge",
        version: BRIDGE_VERSION,
    });

    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_SOCKET_BUFFER) {
            try {
                socket.write(encodeCloseFrame(1009, "buffer overflow"));
            } catch { /* ignore */ }
            socket.destroy();
            return;
        }
        while (true) {
            const frame = tryDecodeFrame(buffer);
            if (!frame) break;
            buffer = frame.rest;

            if (frame.opcode === 0x8) {
                try {
                    socket.write(encodeCloseFrame());
                } catch { /* ignore */ }
                socket.destroy();
                return;
            }
            if (frame.opcode === 0x9) {
                // ping → pong (protocol keepalive — never touches the renderer)
                const pong = Buffer.allocUnsafe(2 + frame.payload.length);
                pong[0] = 0x8a;
                pong[1] = frame.payload.length;
                frame.payload.copy(pong, 2);
                socket.write(pong);
                continue;
            }
            if (frame.opcode !== 0x1) continue;

            const text = frame.payload.toString("utf8");
            void handleClientMessage(socket, text, () => authenticated, v => {
                authenticated = v;
            });
        }
    };

    const onClose = () => {
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.off("error", onError);
        sockets.delete(socket);
    };
    const onError = () => {
        onClose();
        try { socket.destroy(); } catch { /* ignore */ }
    };

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
}

async function handleClientMessage(
    socket: Duplex,
    text: string,
    isAuthed: () => boolean,
    setAuthed: (v: boolean) => void
) {
    let msg: any;
    try {
        msg = JSON.parse(text);
    } catch {
        sendJson(socket, { id: null, ok: false, error: "Invalid JSON" });
        return;
    }

    const id = msg?.id ?? null;

    if (msg?.type === "auth") {
        if (tokensEqual(String(msg.token ?? ""), authToken)) {
            setAuthed(true);
            sendJson(socket, {
                id,
                ok: true,
                authenticated: true,
                version: BRIDGE_VERSION,
                plugin: "AshenMacrosBridge",
            });
        } else {
            setAuthed(false);
            sendJson(socket, { id, ok: false, error: "Invalid auth token" });
            try {
                socket.write(encodeCloseFrame(1008, "auth failed"));
            } catch { /* ignore */ }
            socket.destroy();
        }
        return;
    }

    const msgToken = msg?.token != null ? String(msg.token) : "";
    if (!isAuthed()) {
        if (msgToken && tokensEqual(msgToken, authToken)) {
            setAuthed(true);
        } else {
            sendJson(socket, { id, ok: false, error: "Unauthorized — send auth or include token" });
            return;
        }
    } else if (msgToken && !tokensEqual(msgToken, authToken)) {
        sendJson(socket, { id, ok: false, error: "Token mismatch" });
        return;
    }

    // Instant pong in main — no renderer / Discord UI involvement.
    // delayMs>0 still goes to the renderer so Bridge-tests cancel harness can abort mid-wait.
    if (msg?.type === "ping" && !(Number(msg.delayMs) > 0)) {
        sendJson(socket, {
            id,
            ok: true,
            pong: true,
            delayMs: 0,
            version: BRIDGE_VERSION,
            plugin: "AshenMacrosBridge",
        });
        return;
    }

    try {
        const result = await enqueueForRenderer(msg) as Record<string, unknown>;
        if (result && typeof result === "object" && "id" in result) {
            sendJson(socket, result);
        } else {
            sendJson(socket, { id, ...(result ?? { ok: false, error: "No result" }) });
        }
    } catch (err: any) {
        sendJson(socket, {
            id,
            ok: false,
            error: err?.message || String(err),
        });
    }
}

function closeAllSockets() {
    for (const s of sockets) {
        try {
            s.write(encodeCloseFrame(1001, "server stopping"));
        } catch { /* ignore */ }
        try {
            s.destroy();
        } catch { /* ignore */ }
    }
    sockets.clear();
}

export async function startServer(
    _event: IpcMainInvokeEvent,
    port: number,
    token: string
): Promise<{ port: number; host: string; }> {
    if (httpServer) {
        await stopServer(_event);
    }

    authToken = token || "";
    if (!authToken) {
        throw new Error("authToken is required");
    }

    httpServer = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            service: "AshenMacrosBridge",
            ok: true,
            hint: "Connect via WebSocket",
        }));
    });

    httpServer.on("upgrade", handleUpgrade);

    await new Promise<void>((resolve, reject) => {
        httpServer!.once("error", reject);
        httpServer!.listen(port, HOST, () => {
            httpServer!.off("error", reject);
            resolve();
        });
    });

    return { port, host: HOST };
}

export async function stopServer(_event: IpcMainInvokeEvent): Promise<void> {
    closeAllSockets();
    authToken = "";
    clearRequestQueue();
    clearReplyWaiters("Vencord bridge server stopped");

    if (!httpServer) return;

    const server = httpServer;
    httpServer = null;

    await new Promise<void>(resolve => {
        server.close(() => resolve());
        // Force-close if close hangs on open keep-alives
        setTimeout(() => resolve(), 1500);
    });
}

export async function updateAuthToken(_event: IpcMainInvokeEvent, token: string): Promise<void> {
    authToken = token || "";
}
