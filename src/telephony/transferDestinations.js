const HUMAN_ALIASES = [
    "human",
    "owner",
    "the owner",
    "agent",
    "person",
    "someone",
    "someone else",
    "anybody",
    "anyone",
    "anyone else",
    "another person",
    "operator",
    "representative",
    "staff"
];

// Voicebot stream Exotel opens: wss://813a-2401-4900-c98d-1c9d-3beb-b879-3cb0-7162.ngrok-free.app/exotel
export const EXOTEL_STREAM_URL =
    "wss://813a-2401-4900-c98d-1c9d-3beb-b879-3cb0-7162.ngrok-free.app/exotel";
export const EXOTEL_PUBLIC_BASE_URL =
    "https://813a-2401-4900-c98d-1c9d-3beb-b879-3cb0-7162.ngrok-free.app";
export const SUPPORT_TRANSFER_NUMBER = "+916369808395";

const HARDCODED_DESTINATIONS = [
    {
        id: "support",
        label: "support",
        aliases: [...HUMAN_ALIASES],
        numbers: [SUPPORT_TRANSFER_NUMBER]
    }
];

function envString(env, key, fallback = "") {
    const value = env[key];
    return value == null || value === "" ? fallback : String(value);
}

function envInteger(env, key, fallback) {
    const raw = env[key];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isInteger(value) ? value : fallback;
}

export function looksLikePhoneNumber(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    const digits = text.replace(/\D+/g, "");
    return digits.length >= 10 && /^[+0-9()\s-]+$/.test(text);
}

export function normalizeDepartmentKey(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function toE164(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const digits = raw.replace(/\D+/g, "");
    if (digits.length < 9) return null;
    if (raw.startsWith("+")) return `+${digits}`;
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
    return `+${digits}`;
}

function publicDepartment(entry) {
    return {
        id: entry.id,
        label: entry.label,
        aliases: [...entry.aliases]
    };
}

function normalizeEntry(raw, index) {
    if (!raw || typeof raw !== "object") return null;

    const id = normalizeDepartmentKey(raw.id || raw.department || raw.name);
    if (!id || looksLikePhoneNumber(id)) return null;

    const numbers = unique((Array.isArray(raw.numbers) ? raw.numbers : [raw.number, raw.to])
        .map(toE164));
    const trunk = raw.trunk ? String(raw.trunk).trim() : "";

    if (numbers.length === 0 && !trunk) return null;

    return {
        id,
        label: String(raw.label || raw.name || id).trim() || id,
        aliases: unique((Array.isArray(raw.aliases) ? raw.aliases : [])
            .map(normalizeDepartmentKey)
            .filter((alias) => alias && !looksLikePhoneNumber(alias))),
        numbers,
        trunk: trunk || null,
        index
    };
}

function parseJsonDestinations(text) {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.destinations || parsed.departments || [];
    return rows.map((row, index) => normalizeEntry(row, index)).filter(Boolean);
}

function parseListDestinations(text) {
    return String(text)
        .split(/[,\n]+/)
        .map((part, index) => {
            const trimmed = part.trim();
            if (!trimmed) return null;
            const [id, ...rest] = trimmed.split(":");
            const destination = rest.join(":").trim();
            if (!destination) return null;
            if (destination.startsWith("trunk:")) {
                return normalizeEntry({ id, trunk: destination.slice("trunk:".length) }, index);
            }
            return normalizeEntry({ id, numbers: [destination] }, index);
        })
        .filter(Boolean);
}

export function parseTransferDestinations(text) {
    const raw = String(text || "").trim();
    if (!raw) return [];

    if (raw.startsWith("[") || raw.startsWith("{")) {
        try {
            return parseJsonDestinations(raw);
        } catch {
            return [];
        }
    }

    return parseListDestinations(raw);
}

export function resolveTransferConfig(env = process.env) {
    const fromEnv = parseTransferDestinations(envString(env, "EXOTEL_TRANSFER_DESTINATIONS"));
    const destinations = fromEnv.length > 0
        ? fromEnv
        : HARDCODED_DESTINATIONS.map((entry, index) => normalizeEntry(entry, index)).filter(Boolean);
    const defaultId = normalizeDepartmentKey(envString(env, "EXOTEL_TRANSFER_DEFAULT", destinations[0]?.id || "support"));
    const defaultDepartment = destinations.find((entry) => entry.id === defaultId) ?? destinations[0] ?? null;

    if (defaultDepartment) {
        defaultDepartment.aliases = unique([...defaultDepartment.aliases, ...HUMAN_ALIASES]);
    }

    const ringSeconds = Math.min(60, Math.max(5, envInteger(env, "EXOTEL_TRANSFER_RING_SECONDS", 45)));
    const publicBaseUrl = envString(env, "EXOTEL_PUBLIC_BASE_URL", EXOTEL_PUBLIC_BASE_URL)
        .replace(/\/+$/, "")
        .replace(/\/exotel$/i, "")
        .replace(/^wss:/i, "https:")
        .replace(/^ws:/i, "http:");

    return {
        destinations,
        defaultDepartment,
        enabled: destinations.length > 0,
        timeoutMs: Math.max(1000, envInteger(env, "EXOTEL_TRANSFER_TIMEOUT_MS", (ringSeconds + 15) * 1000)),
        connectWaitMs: Math.max(1000, envInteger(env, "EXOTEL_TRANSFER_CONNECT_WAIT_MS", 8000)),
        ringSeconds,
        publicBaseUrl,
        streamUrl: EXOTEL_STREAM_URL,
        outgoingPhoneNumber: toE164(envString(env, "EXOTEL_TRANSFER_OUTGOING_PHONE"))
    };
}

export function listPublicDepartments(config) {
    return (config?.destinations || []).map(publicDepartment);
}

export function resolveDepartment(config, spoken) {
    const key = normalizeDepartmentKey(spoken);
    if (!key || !config?.destinations?.length) {
        return { status: "missing", error: "Say if you want me to transfer you to support." };
    }

    if (looksLikePhoneNumber(spoken)) {
        return { status: "forbidden", error: "Transfers can only go to a configured department, not a phone number." };
    }

    const exact = config.destinations.find((entry) =>
        entry.id === key || normalizeDepartmentKey(entry.label) === key
    );
    if (exact) return { status: "ok", department: exact };

    const aliased = config.destinations.find((entry) => entry.aliases.includes(key));
    if (aliased) return { status: "ok", department: aliased };

    if (config.defaultDepartment && HUMAN_ALIASES.includes(key)) {
        return { status: "ok", department: config.defaultDepartment };
    }

    return {
        status: "unknown",
        error: "That department is not available. Ask for one of the configured teams.",
        departments: listPublicDepartments(config)
    };
}
