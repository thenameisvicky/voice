import http from "http";
import fs from "fs";

const server = http.createServer((req, res) => {
    let file = "index.html";

    if (req.url === "/audioWorklet.js") {
        file = "audioWorklet.js";
    }

    const content = fs.readFileSync(`./views/${file}`);

    res.writeHead(200, {
        "Content-Type":
            file.endsWith(".js")
                ? "text/javascript"
                : "text/html"
    });

    res.end(content);
})

server.listen(3007, () => {
    console.log("Server running at http://localhost:3007");
});