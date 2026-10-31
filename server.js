import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";
import { Voice } from "./src/voice/voice.js";
import { handleExotelConnection } from "./src/telephony/exotel.js";
import telemetry from "./src/telemetry/telemetry.js";
import { TELEMETRY_CONFIG } from "./src/telemetry/config.js";
import {
    initTools,
    getCustomerProfile,
    getInventoryItem,
    createInvoice
} from "./src/LLM/reasoner/tools.js";
import { INFERENCE_CONFIG, logInferenceConfig } from "./src/inference/config.js";

const MONGO_URI = "mongodb+srv://vignesh:vicky123@wai-main.bfxxlrn.mongodb.net";
const MONGO_DATABASE = "wai";
const COMPANY_ID = "6ae2de9b39b1e00bc23ce6ce";
const USER_ID = "6ae2de9b39b1e00bc23ce6cf";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:8082";
const PUBLIC_TOKEN_SECRET = "publik-token";

const CONTENT_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png"
};

const TELEMETRY_ROOT = path.resolve(TELEMETRY_CONFIG.outputDir);

function resolveTelemetry(urlPath) {
    const relative = urlPath.replace(/^\/telemetry\/?/, "") || "index.html";
    const target = path.resolve(TELEMETRY_ROOT, relative);

    if (target !== TELEMETRY_ROOT && !target.startsWith(TELEMETRY_ROOT + path.sep)) {
        return null;
    }

    try {
        return fs.statSync(target).isDirectory() ? path.join(target, "index.html") : target;
    } catch {
        return null;
    }
}

const server = http.createServer((req, res) => {

    const { pathname } = new URL(req.url, "http://localhost");

    const file = pathname.startsWith("/telemetry")
        ? resolveTelemetry(pathname)
        : path.join("./views", pathname === "/audioProcessor.js" ? "audioProcessor.js" : "index.html");

    if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("No telemetry report yet. Finish a call and reload.");
        return;
    }

    try {
        const content = fs.readFileSync(file);

        res.writeHead(200, {
            "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
        });

        res.end(content);
    } catch (error) {
        console.error("[SERVER] Static read failed:", error);
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    }
});

const wss = new WebSocketServer({ noServer: true });
const exotelWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");

    const target =
        pathname === "/exotel" ? exotelWss :
        pathname === "/" ? wss :
        null;

    if (!target) {
        socket.destroy();
        return;
    }

    target.handleUpgrade(req, socket, head, (ws) => {
        target.emit("connection", ws, req);
    });
});

exotelWss.on("connection", (ws) => {

    console.log("[EXOTEL] Stream connected");

    handleExotelConnection(ws);
});

wss.on("connection", async (ws) => {

    console.log("[WS] Client connected");

    const callId = `browser-${randomUUID().slice(0, 8)}`;

    telemetry.startTrace(callId, {
        channel: "browser",
        from: "localhost",
        inferenceMode: INFERENCE_CONFIG.mode,
        llmProvider: INFERENCE_CONFIG.llm.provider,
        asrProvider: INFERENCE_CONFIG.asr.provider,
        ttsProvider: INFERENCE_CONFIG.tts.provider
    });

    const { voice } = await Voice.createVoice({
        callId,
        onEvent: (event) => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            ws.send(
                JSON.stringify({
                    type: "voice_event",
                    event: event.type,
                    probability: event.probability,
                    text: event.text
                })
            );
        },
        onAudio: (audioBuffer) => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(audioBuffer, { binary: true });
        },
        onHangup: ({ afterMs } = {}) => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: "hangup" }));
            const waitMs = Math.max(2500, (afterMs ?? 4000) + 400);
            setTimeout(() => {
                if (ws.readyState === ws.OPEN) ws.close();
            }, waitMs);
        }
    });

    ws.on("message", async (data, isBinary) => {

        if (!isBinary) return;

        try {

            await voice.voice(data);

        } catch (error) {

            console.error(
                "[VOICE] Error:",
                error
            );

            telemetry.recordError(callId, "pipeline", error);
        }
    });

    ws.on("close", () => {

        console.log(
            "[WS] Client disconnected"
        );

        telemetry.endTrace(callId);
    });

    ws.on("error", (error) => {

        console.error(
            "[WS] Error:",
            error
        );

        telemetry.recordError(callId, "transport", error);
    });
});

async function start() {
    if (!MONGO_URI) {
        console.warn("[SERVER] MONGO_URI is not set; voice DB tools will be unavailable");
    } else {
        await initTools({
            mongoUri: MONGO_URI,
            mongoDatabase: MONGO_DATABASE,
            companyId: COMPANY_ID,
            userId: USER_ID,
            appBaseUrl: APP_BASE_URL,
            publicTokenSecret: PUBLIC_TOKEN_SECRET
        });
    }

    logInferenceConfig(INFERENCE_CONFIG);

    await telemetry.measureBaseline();

    server.listen(3000, () => {
        console.log(
            "Server running at http://localhost:3000"
        );
        console.log(
            "Telemetry reports at http://localhost:3000/telemetry"
        );
    });
}

async function shutdown(signal) {
    console.log(`[SERVER] ${signal} received, flushing telemetry`);

    for (const callId of [...telemetry.traces.keys()]) {
        telemetry.endTrace(callId);
    }

    await telemetry.flush();
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((error) => {
    console.error("[SERVER] Failed to start:", error);
    process.exit(1);
});

export { getCustomerProfile, getInventoryItem, createInvoice };