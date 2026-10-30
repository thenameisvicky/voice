import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";
import { Voice } from "./src/voice/voice.js";
import { handleExotelConnection } from "./src/telephony/exotel.js";
import {
    initTools,
    getCustomerProfile,
    getInventoryItem,
    createInvoice
} from "./src/LLM/reasoner/tools.js";

const MONGO_URI = "mongodb+srv://vignesh:vicky123@wai-main.bfxxlrn.mongodb.net";
const MONGO_DATABASE = "wai";
const COMPANY_ID = "6ae2de9b39b1e00bc23ce6ce";
const USER_ID = "6ae2de9b39b1e00bc23ce6cf";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:8082";
const PUBLIC_TOKEN_SECRET = "publik-token";

const server = http.createServer((req, res) => {

    let file = "index.html";

    if (req.url === "/audioProcessor.js") {
        file = "audioProcessor.js";
    }

    const content = fs.readFileSync(
        `./views/${file}`
    );

    res.writeHead(200, {
        "Content-Type":
            file.endsWith(".js")
                ? "text/javascript"
                : "text/html"
    });

    res.end(content);
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

    const { voice } = await Voice.createVoice({
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
        }
    });

    ws.on("close", () => {

        console.log(
            "[WS] Client disconnected"
        );
    });

    ws.on("error", (error) => {

        console.error(
            "[WS] Error:",
            error
        );
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

    server.listen(3000, () => {
        console.log(
            "Server running at http://localhost:3000"
        );
    });
}

start().catch((error) => {
    console.error("[SERVER] Failed to start:", error);
    process.exit(1);
});

export { getCustomerProfile, getInventoryItem, createInvoice };