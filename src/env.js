import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Loads KEY=value lines from the repo's .env into process.env. Real env vars win.
// Imported first in server.js, before any config module reads process.env.
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
        if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
    }
}
