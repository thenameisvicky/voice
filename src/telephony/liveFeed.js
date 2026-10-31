// Pushes live phone-call transcripts to every browser watching /live.
// No phone numbers are sent: the page is public. The text is what was said on the call.
const viewers = new Set();

export function addViewer(ws) {
    viewers.add(ws);
    ws.on("close", () => viewers.delete(ws));
    ws.on("error", () => viewers.delete(ws));
}

export function broadcast(message) {
    const payload = JSON.stringify({ type: "live", at: Date.now(), ...message });
    for (const ws of viewers) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
    }
}
