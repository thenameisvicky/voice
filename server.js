import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";

import { AudioFramer } from "./src/SST/VAD/framer.js";
import { VADInference } from "./src/SST/VAD/inference.js";
import { Voice } from "./src/voice/voice.js";
import { Endpointer } from "./src/SST/VAD/endpointer.js";
import { SST_CONFIG } from "./src/SST/config.js";
import { UtteranceBuffer } from "./src/SST/utterance/utteranceBuffer.js";
import { Transcriber } from "./src/SST/transcriber/transcriber.js";

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

    const endpointer = new Endpointer(SST_CONFIG);

    const utteranceBuffer = new UtteranceBuffer();

    const transcriber = new Transcriber({ url: "http://127.0.0.1:8080/inference" });

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
                    probability: event.probability,
                    text: event.text
                })
            );
        },
        utteranceBuffer: utteranceBuffer,
        transcriber: transcriber
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