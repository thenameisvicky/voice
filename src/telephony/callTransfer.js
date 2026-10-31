import telemetry from "../telemetry/telemetry.js";
import { parseCallbackBody, parseExotelCallRecord, readHttpBody } from "./exotelStatus.js";
import {
    listPublicDepartments,
    resolveDepartment,
    resolveTransferConfig
} from "./transferDestinations.js";

const DIAL_CONNECTED = new Set(["completed"]);
const DIAL_FAILED = new Set(["busy", "no-answer", "failed", "canceled", "cancelled", "incomplete"]);
const CALL_TERMINAL = new Set(["completed", "failed", "busy", "no-answer", "canceled", "cancelled"]);
const CONNECTING_CALL = new Set(["queued", "ringing", "in-progress"]);

const EMPTY_CONNECT_RESPONSE = {
    fetch_after_attempt: false,
    destination: { numbers: [] }
};

function lower(value) {
    return value == null ? null : String(value).trim().toLowerCase();
}

function clampSummary(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 320);
}

function publicSession(session) {
    if (!session) return null;

    return {
        callSid: session.callSid,
        status: session.status,
        department: session.department?.id ?? null,
        label: session.department?.label ?? null,
        summary: session.summary,
        reason: session.reason,
        dialCallStatus: session.dialCallStatus,
        initiatedAt: session.initiatedAt,
        connectingAt: session.connectingAt,
        connectedAt: session.connectedAt,
        failedAt: session.failedAt,
        callEnded: session.callEnded === true
    };
}

export class TransferRegistry {
    constructor({
        config = resolveTransferConfig(),
        now = Date.now,
        telemetryApi = telemetry,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    } = {}) {
        this.config = config;
        this.now = now;
        this.telemetry = telemetryApi;
        this.setTimer = setTimer;
        this.clearTimeoutFn = clearTimer;
        this.sessions = new Map();
    }

    listDepartments() {
        return listPublicDepartments(this.config);
    }

    resolve(spoken) {
        return resolveDepartment(this.config, spoken);
    }

    get(callSid) {
        return callSid ? this.sessions.get(String(callSid)) : null;
    }

    isInProgress(callSid) {
        const status = this.get(callSid)?.status;
        return status === "initiated" || status === "connecting";
    }

    shouldKeepTrace(callSid) {
        const session = this.get(callSid);
        if (!session) return false;
        if (session.callEnded || session.voicebotReturned) return false;
        return session.status === "initiated"
            || session.status === "connecting"
            || session.status === "connected";
    }

    initiate(callSid, { department, reason = null, summary, conversation } = {}) {
        if (!callSid) {
            return { ok: false, error: "This call has no Exotel CallSid, so it cannot be transferred." };
        }
        if (!this.config.enabled) {
            return { ok: false, error: "No transfer destinations are configured." };
        }

        const resolved = department?.id
            ? { status: "ok", department }
            : this.resolve(department);
        if (resolved.status !== "ok") {
            return {
                ok: false,
                code: resolved.status === "forbidden" ? "forbidden_destination" : "unknown_department",
                error: resolved.error,
                departments: this.listDepartments()
            };
        }

        const existing = this.get(callSid);
        if (existing && (existing.status === "initiated" || existing.status === "connecting")) {
            return {
                ok: false,
                code: "in_progress",
                error: "A transfer is already in progress on this call.",
                status: existing.status,
                department: existing.department.id
            };
        }

        const session = {
            callSid: String(callSid),
            department: resolved.department,
            summary: clampSummary(summary),
            conversation: conversation || null,
            status: "initiated",
            reason: reason || null,
            dialCallStatus: null,
            initiatedAt: this.now(),
            connectingAt: null,
            connectedAt: null,
            failedAt: null,
            callEnded: false,
            voicebotReturned: false,
            connectRequested: false,
            timer: null
        };

        this.sessions.set(session.callSid, session);
        this.armTimer(session, this.config.connectWaitMs, "connect_not_requested");
        this.record(session, "initiated", false);

        return {
            ok: true,
            status: "initiated",
            department: session.department.id,
            label: session.department.label,
            reason: session.reason,
            summary: session.summary,
            leave_stream: true,
            hangup: true,
            hangupReason: "transfer",
            message: `I'm connecting you to ${session.department.label} now.`
        };
    }

    onConnectQuery(record = {}, { eventUrl = null } = {}) {
        const callSid = record.callSid || record.CallSid;
        const session = this.get(callSid);
        const dialCallStatus = lower(record.dialCallStatus || record.DialCallStatus);

        if (!session || session.status === "failed" || session.status === "timeout") {
            return { ...EMPTY_CONNECT_RESPONSE };
        }

        if (dialCallStatus && DIAL_FAILED.has(dialCallStatus)) {
            this.fail(session, {
                reason: "dial_failed",
                dialCallStatus
            });
            return { ...EMPTY_CONNECT_RESPONSE };
        }

        if (dialCallStatus && DIAL_CONNECTED.has(dialCallStatus)) {
            this.connect(session, { dialCallStatus });
            return { ...EMPTY_CONNECT_RESPONSE };
        }

        session.connectRequested = true;
        if (session.status === "initiated") {
            session.status = "connecting";
            session.connectingAt = this.now();
            this.armTimer(session, this.config.timeoutMs, "ring_timeout");
            this.record(session, "connecting", false);
        }

        return this.buildConnectResponse(session, eventUrl);
    }

    buildConnectResponse(session, eventUrl) {
        const destination = session.department.trunk
            ? { trunk: session.department.trunk }
            : { numbers: [...session.department.numbers] };

        const response = {
            fetch_after_attempt: true,
            destination,
            record: false,
            max_ringing_duration: this.config.ringSeconds,
            music_on_hold: { type: "default_tone" }
        };

        if (this.config.outgoingPhoneNumber) {
            response.outgoing_phone_number = this.config.outgoingPhoneNumber;
        }

        if (eventUrl) {
            response.dial_passthru_event_url = eventUrl;
        }

        if (session.summary) {
            response.start_call_playback = {
                playback_to: "callee",
                type: "text",
                value: session.summary
            };
        }

        return response;
    }

    onDialEvent(record = {}) {
        const parsed = this.normalizeRecord(record);
        const session = this.get(parsed.callSid);
        if (!session) return null;

        if (parsed.dialCallStatus && DIAL_CONNECTED.has(parsed.dialCallStatus)) {
            return this.connect(session, parsed);
        }
        if (parsed.dialCallStatus && DIAL_FAILED.has(parsed.dialCallStatus)) {
            return this.fail(session, { reason: "dial_failed", ...parsed });
        }
        if (parsed.status && CONNECTING_CALL.has(parsed.status) && session.status === "initiated") {
            session.status = "connecting";
            session.connectingAt = this.now();
            this.armTimer(session, this.config.timeoutMs, "ring_timeout");
            this.record(session, "connecting", false);
        }

        return publicSession(session);
    }

    onCallRecord(record = {}) {
        const parsed = this.normalizeRecord(record);
        const session = this.get(parsed.callSid);
        if (!session) return null;

        if (parsed.dialCallStatus && DIAL_CONNECTED.has(parsed.dialCallStatus)) {
            this.connect(session, parsed);
        } else if (parsed.dialCallStatus && DIAL_FAILED.has(parsed.dialCallStatus)) {
            this.fail(session, { reason: "dial_failed", ...parsed });
        } else if (session.status === "connecting"
            && parsed.status
            && CALL_TERMINAL.has(parsed.status)
            && !parsed.dialCallStatus) {
            this.fail(session, {
                reason: "call_ended_before_dial_status",
                status: parsed.status
            });
        }

        if (parsed.status && CALL_TERMINAL.has(parsed.status)) {
            session.callEnded = true;
            this.clearTimer(session);
        }

        return publicSession(session);
    }

    onVoicebotStart(callSid) {
        const session = this.get(callSid);
        if (!session) return null;

        if (session.status === "initiated" || session.status === "connecting") {
            this.fail(session, { reason: "returned_to_voicebot" });
        }

        if (session.status === "failed" || session.status === "timeout") {
            session.voicebotReturned = true;
            return {
                status: session.status,
                department: session.department.id,
                label: session.department.label,
                reason: session.reason,
                summary: session.summary,
                speakOnReturn: this.failureSpeech(session)
            };
        }

        return null;
    }

    failureSpeech(session) {
        const label = session.department?.label || "that team";
        if (session.reason === "ring_timeout" || session.dialCallStatus === "no-answer") {
            return `I could not reach ${label}. I can keep helping you here.`;
        }
        if (session.dialCallStatus === "busy") {
            return `${label} is busy. I can keep helping you here.`;
        }
        return `The transfer to ${label} did not connect. I can keep helping you here.`;
    }

    snapshot(callSid) {
        return publicSession(this.get(callSid));
    }

    normalizeRecord(record = {}) {
        return {
            callSid: record.callSid || record.CallSid || record.sid || null,
            status: lower(record.status || record.Status || record.CallStatus),
            dialCallStatus: lower(record.dialCallStatus || record.DialCallStatus),
            dialWhomNumber: record.dialWhomNumber || record.DialWhomNumber || null,
            callType: record.callType || record.CallType || null
        };
    }

    connect(session, detail = {}) {
        if (session.status === "connected") return publicSession(session);

        session.status = "connected";
        session.connectedAt = this.now();
        session.dialCallStatus = detail.dialCallStatus || "completed";
        session.reason = null;
        this.clearTimer(session);
        this.record(session, "connected", true);
        return publicSession(session);
    }

    fail(session, detail = {}) {
        if (session.status === "connected") return publicSession(session);
        if (session.status === "failed" || session.status === "timeout") return publicSession(session);

        session.status = detail.reason === "ring_timeout" || detail.reason === "connect_not_requested"
            ? "timeout"
            : "failed";
        session.failedAt = this.now();
        session.reason = detail.reason || "failed";
        session.dialCallStatus = detail.dialCallStatus || session.dialCallStatus;
        this.clearTimer(session);
        this.record(session, session.status, false);
        return publicSession(session);
    }

    armTimer(session, delayMs, reason) {
        this.clearTimer(session);
        session.timer = this.setTimer(() => {
            const current = this.get(session.callSid);
            if (!current || current.status === "connected" || current.status === "failed" || current.status === "timeout") {
                return;
            }
            this.fail(current, { reason });
        }, delayMs);
        session.timer?.unref?.();
    }

    clearTimer(session) {
        if (session?.timer) {
            this.clearTimeoutFn(session.timer);
            session.timer = null;
        }
    }

    record(session, status, ok) {
        this.telemetry.recordTransfer?.(session.callSid, {
            status,
            ok,
            department: session.department.id,
            label: session.department.label,
            reason: session.reason,
            dialCallStatus: session.dialCallStatus,
            summary: session.summary,
            initiatedAt: session.initiatedAt,
            connectingAt: session.connectingAt,
            connectedAt: session.connectedAt,
            failedAt: session.failedAt
        });
    }
}

export const transfers = new TransferRegistry();

export function publicEventUrl(req, config = transfers.config) {
    if (config.publicBaseUrl) {
        return `${config.publicBaseUrl}/exotel/connect/events`;
    }

    const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
    if (!host) return null;

    const proto = req.headers?.["x-forwarded-proto"]
        || (req.socket?.encrypted ? "https" : "http");
    return `${proto}://${host}/exotel/connect/events`;
}

function sendJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function recordFromRequest(req, url, body = "") {
    if (req.method === "GET") {
        return Object.fromEntries(url.searchParams);
    }

    return parseCallbackBody(req.headers["content-type"], body);
}

export function handleExotelConnectRequest(req, res, registry = transfers) {
    const url = new URL(req.url, "http://localhost");
    const record = parseExotelCallRecord(recordFromRequest(req, url));
    const response = registry.onConnectQuery(record, {
        eventUrl: publicEventUrl(req, registry.config)
    });

    sendJson(res, 200, response);
}

export async function handleExotelDialEventRequest(req, res, registry = transfers) {
    const url = new URL(req.url, "http://localhost");
    const body = req.method === "GET" ? "" : await readHttpBody(req);
    const record = parseExotelCallRecord(recordFromRequest(req, url, body));
    const transfer = registry.onDialEvent(record);

    sendJson(res, 200, {
        ok: true,
        callSid: record.callSid,
        transfer: transfer?.status ?? null
    });
}
