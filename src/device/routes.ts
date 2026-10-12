// The HTTP surface of the device relay: pairing, and the per-device MCP URL.
//
// Pairing is the only unauthenticated endpoint, and it is protected by a code
// that lives ten minutes, dies on first use, and is guessable only five times
// from one source before that source is locked out.
import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import store from "./store.js";
import hub from "./hub.js";
import { handleDeviceMcp } from "./mcp.js";
import llm from "./llm.js";
import takeover from "./takeover.js";
import m from "../mongo.js";
import u from "../util.js";

/** Where OpenAI's hosted tool will call, and where the agent dials. */
export function deviceMcpUrl(connectorId: string): string {
    return `${u.publicBaseUrl()}/device/${connectorId}/mcp`;
}

function sourceOf(req: Request): string {
    // Behind Cloudflare and Traefik the socket address is the proxy's, so prefer
    // the forwarded client. Only used for rate limiting, never for authorisation.
    const fwd = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
    return fwd || req.ip || "unknown";
}

async function handlePair(req: Request, res: Response): Promise<void> {
    const source = sourceOf(req);
    if (store.attemptsLocked(source)) {
        res.status(429).json({ error: "too many attempts, try again later" });
        return;
    }
    const body: any = req.body || {};
    const redeemed = await store.redeemPairingCode(String(body.code || ""));
    if (!redeemed) {
        store.noteFailedAttempt(source);
        // Expired, already used, and never issued are one answer on purpose.
        res.status(401).json({ error: "that code is not valid" });
        return;
    }
    store.clearAttempts(source);

    try {
        const { deviceId, token } = await store.registerDevice(redeemed.chatId, {
            name: body.device_name, os: body.os, arch: body.arch,
            agent_version: body.agent_version, capabilities: body.capabilities,
        });
        // The connector is what makes the computer visible to the model. Its
        // bearer secret is what OpenAI's servers will present back to us.
        const secret = crypto.randomBytes(32).toString("base64url");
        const connector = await m.addDeviceConnector(redeemed.chatId, {
            label: "Computer",
            secret,
            description: "the person's own computer",
            urlFor: deviceMcpUrl,
        });
        await store.setDeviceConnector(deviceId, connector.connector_id);

        console.log(`device ${deviceId} paired to ${redeemed.chatId} (${body.device_name || "unnamed"})`);
        res.json({ device_id: deviceId, device_token: token, ws_url: `${u.publicBaseUrl().replace(/^http/, "ws")}${hub.WS_PATH}` });

        // Tell them in the chat, in fixed words — this is not a model reply.
        const { sayAndRemember } = await import("../say.js");
        const language = u.inferLanguage([redeemed.chatId]);
        await sayAndRemember(redeemed.chatId, u.deviceConnectedMessage(language))
            .catch((e: any) => console.error("pairing confirmation failed:", e?.message || e));
    } catch (e: any) {
        console.error("pairing failed:", e?.message || e);
        res.status(500).json({ error: "pairing failed" });
    }
}

/** The Mac's own way out: "Disconnect" in the menu-bar app, or
 *  `gepetel-agent unpair`. Deleting the local token alone would leave it valid
 *  here — a computer that thinks it is unpaired while its token still opens a
 *  socket — so the token is spent on revoking itself. Same effect as removing
 *  the connector from the chat: the device row, the connector and the socket
 *  all go. */
async function handleUnpair(req: Request, res: Response): Promise<void> {
    const hdr = String(req.get("authorization") || "");
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    const device = token ? await store.deviceForToken(token).catch(() => null) : null;
    if (!device) {
        // Already gone and never existed are one answer; the agent treats
        // both as "unpaired", which is what it wanted.
        res.status(401).json({ error: "not paired" });
        return;
    }
    try {
        // The token first: it is the thing that still opens a socket.
        await store.unpairDevice(device.chat_id);
        if (device.connector_id) await m.removeDeviceConnector(device.connector_id);
        hub.dropDevice(device.chat_id);
        console.log(`device ${device.device_id} unpaired itself from ${device.chat_id}`);
        res.json({ unpaired: true });
    } catch (e: any) {
        console.error("unpair failed:", e?.message || e);
        res.status(500).json({ error: "unpair failed" });
        return;
    }
    const { sayAndRemember } = await import("../say.js");
    const language = u.inferLanguage([device.chat_id]);
    await sayAndRemember(device.chat_id, u.deviceDisconnectedMessage(language))
        .catch((e: any) => console.error("unpair notice failed:", e?.message || e));
}

export function registerDeviceRoutes(app: Express): void {
    app.post("/device/pair", handlePair);
    app.post("/device/unpair", handleUnpair);
    llm.registerLlmRoute(app);
    takeover.registerTakeoverRoutes(app);
    app.post("/device/:connectorId/mcp", handleDeviceMcp);
    // The hosted tool sometimes probes with GET before posting; answer plainly
    // rather than with the HTML 404 the static host would serve.
    app.get("/device/:connectorId/mcp", (_req, res) => {
        res.status(405).json({ error: "POST only" });
    });
}

export function attachHub(server: Server): void {
    hub.attachDeviceHub(server);
    takeover.attachTakeover(server);
}

export default { registerDeviceRoutes, attachHub, deviceMcpUrl };
