import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";

import { AudioFramer } from "./src/SST/VAD/framer.js";
import { VADInference } from "./src/SST/VAD/inference.js";
import { Voice } from "./src/voice/voice.js";
import { Endpointer } from "./src/SST/VAD/endpointer.js";

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

const wss = new WebSocketServer({
    server
});

wss.on("connection", async (ws) => {

    console.log("[WS] Client connected");

    const framer = new AudioFramer(512);

    const vad = new VADInference();

    const endpointer = new Endpointer({
        startThreshold: 0.5,
        endThreshold: 0.3,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 300
    });

    await vad.init();

    const voice = new Voice({
        audioFramer: framer,
        vad: vad,
        endpointer: endpointer,
        onEvent: (event) => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            ws.send(
                JSON.stringify({
                    type: "voice_event",
                    event: event.type,
                    probability: event.probability
                })
            );
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

server.listen(3007, () => {

    console.log(
        "Server running at http://localhost:3007"
    );
});