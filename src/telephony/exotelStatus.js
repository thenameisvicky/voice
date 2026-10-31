import { rupeesToPaise } from "../telemetry/money.js";
import { resolveExotelApiConfig } from "../telemetry/tariff.js";

const DIRECTION_IN = new Set(["inbound", "incoming", "inbound-api"]);
const DIRECTION_OUT = new Set(["outbound", "outbound-api", "outbound-dial", "outgoing"]);

function first(record, keys) {
    for (const key of keys) {
        if (record[key] != null && record[key] !== "") return record[key];
    }
    return null;
}

export function parseFormBody(text) {
    const params = new URLSearchParams(text);
    const record = {};
    for (const [key, value] of params.entries()) {
        record[key] = value;
    }
    return record;
}

export function parseCallbackBody(contentType, text) {
    const type = String(contentType || "").toLowerCase();

    if (type.includes("application/json")) {
        const parsed = text ? JSON.parse(text) : {};
        return parsed.Call ?? parsed.call ?? parsed;
    }

    return parseFormBody(text);
}

export function normalizeDirection(value) {
    const direction = String(value || "").trim().toLowerCase();
    if (DIRECTION_OUT.has(direction)) return "outbound";
    if (DIRECTION_IN.has(direction) || direction === "") return direction ? "inbound" : null;
    return null;
}

export function parseExotelCallRecord(record = {}) {
    const callSid = first(record, ["CallSid", "call_sid", "Sid", "sid"]);
    const durationRaw = first(record, ["Duration", "duration", "ConversationDuration"]);
    const durationSeconds = durationRaw == null ? null : Number(durationRaw);
    const priceRaw = first(record, ["Price", "price"]);
    const actualPaise = priceRaw == null ? null : rupeesToPaise(priceRaw);
    const startRaw = first(record, ["StartTime", "start_time", "DateCreated"]);
    const endRaw = first(record, ["EndTime", "end_time", "DateUpdated"]);

    return {
        callSid: callSid ? String(callSid) : null,
        direction: normalizeDirection(first(record, ["Direction", "direction"])),
        status: first(record, ["Status", "CallStatus", "status", "DialCallStatus"]),
        dialCallStatus: first(record, ["DialCallStatus"]),
        dialWhomNumber: first(record, ["DialWhomNumber"]),
        callType: first(record, ["CallType"]),
        from: first(record, ["From", "CallFrom", "from"]),
        to: first(record, ["To", "CallTo", "to"]),
        startedAt: startRaw ? Date.parse(startRaw) || null : null,
        endedAt: endRaw ? Date.parse(endRaw) || null : null,
        connectedDurationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        actualPaise: Number.isInteger(actualPaise) ? actualPaise : null,
        raw: record
    };
}

export async function fetchExotelCallDetails(callSid, {
    config = resolveExotelApiConfig(),
    fetchImpl = fetch
} = {}) {
    if (!config.enabled || !callSid) {
        return { ok: false, reason: "exotel_api_not_configured" };
    }

    const url = `${config.baseUrl}/v1/Accounts/${encodeURIComponent(config.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
    const auth = Buffer.from(`${config.apiKey}:${config.apiToken}`).toString("base64");

    const response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Basic ${auth}` }
    });

    const text = await response.text();
    if (!response.ok) {
        return {
            ok: false,
            reason: "exotel_call_details_failed",
            status: response.status,
            body: text.slice(0, 400)
        };
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, reason: "exotel_call_details_not_json" };
    }

    return {
        ok: true,
        record: parseExotelCallRecord(parsed.Call ?? parsed.call ?? parsed),
        fetchedAt: Date.now(),
        source: "exotel-call-details"
    };
}

export async function readHttpBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

export async function handleExotelStatusRequest(req, res, telemetry, { onCallRecord } = {}) {
    const body = await readHttpBody(req);
    const record = parseCallbackBody(req.headers["content-type"], body);
    const parsed = parseExotelCallRecord(record);

    if (!parsed.callSid) {
        sendJson(res, 400, { ok: false, error: "CallSid is required" });
        return;
    }

    const result = await telemetry.applyTelephonyUpdate(parsed.callSid, {
        ...parsed,
        durationSource: parsed.connectedDurationSeconds != null ? "exotel" : null,
        source: "exotel-status-callback"
    });

    const transfer = onCallRecord?.(parsed) ?? null;
    if (transfer?.callEnded && telemetry.getTrace?.(parsed.callSid)) {
        telemetry.endTrace(parsed.callSid);
    }

    sendJson(res, 200, {
        ok: true,
        callSid: parsed.callSid,
        telephony_cost_status: result?.cost?.telephony_cost_status ?? null,
        duplicate: result?.duplicate === true,
        transfer: transfer?.status ?? null
    });
}

export async function handleExotelBillingRequest(req, res, telemetry) {
    const body = await readHttpBody(req);
    let payload;

    try {
        payload = body ? JSON.parse(body) : {};
    } catch {
        sendJson(res, 400, { ok: false, error: "JSON body required" });
        return;
    }

    const callSid = payload.callSid || payload.CallSid;
    const actualPaise = payload.actualPaise != null
        ? Number(payload.actualPaise)
        : rupeesToPaise(payload.actual_telephony_cost ?? payload.Price ?? payload.price);

    if (!callSid) {
        sendJson(res, 400, { ok: false, error: "callSid is required" });
        return;
    }

    if (!Number.isInteger(actualPaise)) {
        sendJson(res, 400, { ok: false, error: "actual cost is missing or not a paise/INR amount" });
        return;
    }

    const result = await telemetry.reconcileTelephonyCost(callSid, {
        actualPaise,
        source: payload.source || "billing-import",
        currency: payload.currency || "INR",
        invoicedAt: payload.invoicedAt ?? Date.now()
    });

    sendJson(res, 200, {
        ok: true,
        callSid,
        telephony_cost_status: result?.cost?.telephony_cost_status ?? null,
        actual_telephony_cost: result?.cost?.actual_telephony_cost ?? null,
        duplicate: result?.duplicate === true
    });
}
