/*
 * Native (Electron main) WebSocket server for AshenMacrosBridge.
 * Binds 127.0.0.1 only. No npm deps — minimal RFC6455 text frames via Node http.
 */

import { createHash, timingSafeEqual } from "crypto";
import { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { createServer, IncomingMessage, Server } from "http";
import type { Duplex } from "net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HOST = "127.0.0.1";
/** Keep in sync with package.json — shown in Ashen Macros hub Bridge status.
 *  Must NOT be exported: Vencord registers every native export as ipcMain.handle().
 */
const BRIDGE_VERSION = "2026.33.1";

let httpServer: Server | null = null;
let authToken = "";
const sockets = new Set<Duplex>();

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

function getDiscordWebContents() {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
        const wc = win.webContents;
        if (wc && !wc.isDestroyed()) return wc;
    }
    return null;
}

async function invokeRenderer(request: unknown): Promise<unknown> {
    const wc = getDiscordWebContents();
    if (!wc) throw new Error("No Discord renderer window available");

    const payload = JSON.stringify(request);
    const responseStr = await wc.executeJavaScript(`
        (async () => {
            if (typeof window.__AshenMacrosBridgeHandle !== "function") {
                return JSON.stringify({ ok: false, error: "Bridge handler not ready in renderer" });
            }
            try {
                const response = await window.__AshenMacrosBridgeHandle(${payload});
                return JSON.stringify(response ?? { ok: false, error: "Empty handler response" });
            } catch (error) {
                return JSON.stringify({
                    ok: false,
                    error: error && error.message ? error.message : String(error)
                });
            }
        })()
    `);

    try {
        return JSON.parse(responseStr);
    } catch {
        return { ok: false, error: "Invalid JSON from renderer handler" };
    }
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
                // ping → pong
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

    socket.on("data", onData);
    socket.on("close", () => {
        sockets.delete(socket);
    });
    socket.on("error", () => {
        sockets.delete(socket);
        try { socket.destroy(); } catch { /* ignore */ }
    });
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

    try {
        const result = await invokeRenderer(msg) as Record<string, unknown>;
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
