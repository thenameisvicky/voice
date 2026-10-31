import fs from "node:fs/promises";
import path from "node:path";

import { TELEMETRY_CONFIG, STAGES } from "./config.js";
import { attachCallCost, emptyTelephony } from "./cost.js";
import {
    hostInfo,
    measureIdleBaseline,
    memorySnapshot,
    openResourceWindow,
    systemCpuTimes
} from "./resources.js";
import { writeCallReport, writeOverviewReport } from "./report.js";
import { fetchExotelCallDetails } from "../telephony/exotelStatus.js";

export class Telemetry {
    constructor() {
        this.traces = new Map();
        this.completed = [];
        this.baseline = null;
        this.sampler = null;
        this.pendingWrites = new Set();
        this.peakConcurrency = 0;
        this.pendingTelephony = new Map();
        this.ledger = null;
        this.outputDir = TELEMETRY_CONFIG.outputDir;
    }

    async measureBaseline(durationMs = TELEMETRY_CONFIG.baselineDurationMs) {
        this.baseline = await measureIdleBaseline(durationMs);

        console.log(
            `[TELEMETRY] Baseline: ${this.baseline.idleUtilizationPct.toFixed(1)}% idle load, ` +
            `stack ${(this.baseline.stackRssBytes / 1024 ** 2).toFixed(0)} MiB`
        );

        return this.baseline;
    }

    startTrace(callId, metadata = {}) {
        if (!callId) return null;

        const existing = this.traces.get(callId);
        if (existing) {
            existing.metadata = { ...existing.metadata, ...metadata, resumedAt: Date.now() };
            console.log(`[TELEMETRY] Trace resumed: ${callId}`);
            return existing;
        }

        const trace = {
            callId,
            startedAt: Date.now(),
            endedAt: null,
            durationMs: null,
            status: "active",
            metadata,
            host: hostInfo(),
            baseline: this.baseline,
            turns: [],
            spans: [],
            vad: { count: 0, totalMs: 0, maxMs: 0 },
            samples: [],
            modelUsage: [],
            queueWaits: [],
            errors: [],
            businessActions: [],
            telephony: this.createTelephony(callId, metadata),
            cost: null,
            resource: null,
            peakConcurrency: this.traces.size + 1,

            openSpans: new Map(),
            activeTurn: null,
            lastSample: null,
            closeWindow: openResourceWindow()
        };

        this.traces.set(callId, trace);
        this.mergePendingTelephony(trace);
        this.markConcurrency();
        this.recordResourceSnapshot(callId);
        this.startSampler();

        console.log(`[TELEMETRY] Trace started: ${callId} (${this.traces.size} in flight)`);

        return trace;
    }

    markConcurrency() {
        const active = this.traces.size;

        this.peakConcurrency = Math.max(this.peakConcurrency, active);

        for (const trace of this.traces.values()) {
            trace.peakConcurrency = Math.max(trace.peakConcurrency, active);
        }

        return active;
    }

    startTurn(callId, metadata = {}) {
        const trace = this.traces.get(callId);
        if (!trace) return null;

        if (trace.activeTurn) this.endTurn(callId, { ok: false, reason: "superseded" });

        const turn = {
            index: trace.turns.length,
            startedAt: Date.now(),
            endedAt: null,
            durationMs: null,
            transcript: null,
            response: null,
            userAudioMs: metadata.userAudioMs ?? null,
            replyAudioMs: null,
            replyChars: null,
            tokens: { prompt: 0, completion: 0, total: 0 },
            toolCalls: [],
            errorCount: 0,
            ok: null,
            resource: null,
            closeWindow: openResourceWindow()
        };

        trace.turns.push(turn);
        trace.activeTurn = turn;

        return turn;
    }

    endTurn(callId, result = {}) {
        const trace = this.traces.get(callId);
        const turn = trace?.activeTurn;
        if (!turn) return null;

        turn.endedAt = Date.now();
        turn.durationMs = turn.endedAt - turn.startedAt;
        turn.resource = turn.closeWindow();
        delete turn.closeWindow;

        turn.transcript = result.transcript ?? turn.transcript;
        turn.response = result.response ?? turn.response;
        turn.userAudioMs = result.userAudioMs ?? turn.userAudioMs;
        turn.replyAudioMs = result.replyAudioMs ?? turn.replyAudioMs;
        turn.replyChars = result.replyChars ?? turn.replyChars;
        turn.ok = result.ok ?? turn.errorCount === 0;
        if (result.reason) turn.reason = result.reason;

        trace.activeTurn = null;

        console.log(
            `[TELEMETRY] Turn ${turn.index} of ${callId}: ${turn.durationMs} ms, ` +
            `${turn.resource.busyCpuMs.toFixed(0)} CPU-ms, ${turn.tokens.total} tokens`
        );

        return turn;
    }

    startSpan(callId, stage, metadata = {}) {
        const trace = this.traces.get(callId);
        if (!trace) return null;

        const span = {
            stage,
            turnIndex: trace.activeTurn?.index ?? null,
            metadata,
            startedAt: Date.now(),
            durationMs: null,
            ok: null,
            error: null,
            result: null
        };

        if (!trace.openSpans.has(stage)) trace.openSpans.set(stage, []);
        trace.openSpans.get(stage).push(span);

        return span;
    }

    endSpan(callId, stage, result = {}) {
        const trace = this.traces.get(callId);
        const span = trace?.openSpans.get(stage)?.pop();
        if (!span) return null;

        span.durationMs = Date.now() - span.startedAt;
        span.ok = result.ok !== false && !result.error;
        span.error = result.error ? String(result.error?.message ?? result.error) : null;
        span.result = { ...result };
        delete span.result.ok;
        delete span.result.error;

        if (stage === STAGES.VAD) {
            trace.vad.count += 1;
            trace.vad.totalMs += span.durationMs;
            trace.vad.maxMs = Math.max(trace.vad.maxMs, span.durationMs);
            return span;
        }

        trace.spans.push(span);

        const turn = trace.activeTurn;

        if (turn) {
            if (stage === STAGES.ASR && result.transcript) turn.transcript = result.transcript;
            if (stage === STAGES.TTS && result.audioMs != null) turn.replyAudioMs = result.audioMs;
            if (stage === STAGES.TOOL) {
                turn.toolCalls.push({
                    name: span.metadata.name ?? result.name ?? "unknown",
                    durationMs: span.durationMs,
                    ok: result.toolOk ?? span.ok
                });
            }
            if (!span.ok) turn.errorCount += 1;
        }

        if (!span.ok) {
            trace.errors.push({
                at: Date.now(),
                stage,
                turnIndex: span.turnIndex,
                message: span.error ?? "unknown error"
            });
        }

        return span;
    }

    recordResourceSnapshot(callId) {
        const trace = this.traces.get(callId);
        if (!trace) return null;

        const memory = memorySnapshot();
        const cpu = systemCpuTimes();
        const now = Date.now();
        const previous = trace.lastSample;

        let utilizationPct = null;

        if (previous) {
            const totalDelta = cpu.totalMs - previous.cpu.totalMs;
            const busyDelta = Math.max(0, totalDelta - (cpu.idleMs - previous.cpu.idleMs));
            if (totalDelta > 0) utilizationPct = (busyDelta / totalDelta) * 100;
        }

        const sample = {
            offsetMs: now - trace.startedAt,
            activeCalls: this.traces.size,
            utilizationPct,
            memoryUtilizationPct: memory.utilizationPct,
            stackRssBytes: memory.stackRssBytes,
            systemUsedBytes: memory.systemUsedBytes,
            systemTotalBytes: memory.systemTotalBytes
        };

        trace.lastSample = { cpu };
        trace.samples.push(sample);

        return sample;
    }

    recordQueueWait(callId, source, waitMs) {
        const trace = this.traces.get(callId);
        if (!trace || !Number.isFinite(waitMs)) return null;

        const record = {
            turnIndex: trace.activeTurn?.index ?? null,
            source,
            waitMs: Math.max(0, waitMs)
        };

        trace.queueWaits.push(record);

        return record;
    }

    recordModelUsage(callId, model, usage = {}) {
        const trace = this.traces.get(callId);
        if (!trace) return null;

        const record = {
            turnIndex: trace.activeTurn?.index ?? null,
            stage: usage.stage ?? null,
            provider: usage.provider ?? null,
            model,
            promptTokens: Number(usage.promptTokens ?? 0),
            completionTokens: Number(usage.completionTokens ?? 0),
            audioMs: usage.audioMs ?? null,
            durationMs: usage.durationMs ?? null,
            ttftMs: usage.ttftMs ?? null,
            retries: Number(usage.retries ?? 0),
            status: usage.status ?? null,
            errorCode: usage.errorCode ?? null
        };

        record.totalTokens = record.promptTokens + record.completionTokens;

        trace.modelUsage.push(record);

        const turn = trace.activeTurn;

        if (turn) {
            turn.tokens.prompt += record.promptTokens;
            turn.tokens.completion += record.completionTokens;
            turn.tokens.total += record.totalTokens;
        }

        return record;
    }

    recordBusinessAction(callId, action, detail = {}) {
        const trace = this.findTrace(callId);
        if (!trace) return null;

        const record = {
            turnIndex: trace.activeTurn?.index ?? null,
            action,
            ok: detail.ok === true,
            detail
        };

        trace.businessActions.push(record);

        return record;
    }

    recordTransfer(callId, update = {}) {
        const trace = this.findTrace(callId);
        if (!trace) return null;

        trace.transfer = {
            ...(trace.transfer || {}),
            ...update
        };

        this.recordBusinessAction(callId, "transfer_to_human", {
            ok: update.ok === true && update.status === "connected",
            status: update.status,
            department: update.department ?? null,
            label: update.label ?? null,
            reason: update.reason ?? null,
            dialCallStatus: update.dialCallStatus ?? null
        });

        return trace.transfer;
    }

    recordError(callId, stage, error) {
        const trace = this.traces.get(callId);
        if (!trace) return null;

        const record = {
            at: Date.now(),
            stage,
            turnIndex: trace.activeTurn?.index ?? null,
            message: String(error?.message ?? error)
        };

        trace.errors.push(record);
        if (trace.activeTurn) trace.activeTurn.errorCount += 1;

        return record;
    }

    endTrace(callId) {
        const trace = this.traces.get(callId);
        if (!trace) return null;

        if (trace.activeTurn) this.endTurn(callId, { ok: false, reason: "call ended mid-turn" });

        for (const [stage, spans] of trace.openSpans) {
            while (spans.length > 0) {
                this.endSpan(callId, stage, { ok: false, error: "span open at call end" });
            }
        }

        this.recordResourceSnapshot(callId);

        trace.endedAt = Date.now();
        trace.durationMs = trace.endedAt - trace.startedAt;
        trace.resource = trace.closeWindow();
        trace.status = "completed";

        delete trace.closeWindow;
        delete trace.openSpans;
        delete trace.activeTurn;
        delete trace.lastSample;

        this.finalizeTelephony(trace);
        attachCallCost(trace);

        this.traces.delete(callId);
        this.markConcurrency();
        this.completed.push(trace);

        if (this.completed.length > TELEMETRY_CONFIG.maxRetainedCalls) {
            this.completed.shift();
        }

        if (this.traces.size === 0) this.stopSampler();

        console.log(
            `[TELEMETRY] Trace ended: ${callId} - ${(trace.durationMs / 1000).toFixed(1)}s, ` +
            `${trace.turns.length} turns, ${(trace.resource.busyCpuMs / 1000).toFixed(2)} CPU-s`
        );

        this.track(writeCallReport(trace));
        this.track(writeOverviewReport(this.getAggregatedMetrics()));
        this.track(this.refreshAfterTelephony(trace));

        return trace;
    }

    createTelephony(callId, metadata) {
        if (metadata.channel !== "exotel") {
            return emptyTelephony({
                provider: metadata.channel ?? null,
                callSid: callId,
                costStatus: "not_applicable"
            });
        }

        return emptyTelephony({
            callSid: metadata.exotelCallSid ?? callId,
            direction: metadata.direction ?? "inbound",
            startedAt: Date.now(),
            status: "in-progress",
            from: metadata.from ?? null,
            to: metadata.to ?? null
        });
    }

    finalizeTelephony(trace) {
        const telephony = trace.telephony ?? emptyTelephony({ callSid: trace.callId });
        const appSeconds = Math.round((trace.durationMs ?? 0) / 1000);

        telephony.endedAt = telephony.endedAt ?? Date.now();
        telephony.appDurationSeconds = appSeconds;

        if (telephony.connectedDurationSeconds == null && trace.metadata?.channel === "exotel") {
            telephony.connectedDurationSeconds = appSeconds;
            telephony.durationSource = "application";
        }

        if (!telephony.status || telephony.status === "in-progress") {
            telephony.status = "completed";
        }

        trace.telephony = telephony;
        return telephony;
    }

    findTrace(callSid) {
        return this.traces.get(callSid)
            ?? this.completed.find((trace) =>
                trace.callId === callSid || trace.telephony?.callSid === callSid
            )
            ?? null;
    }

    mergePendingTelephony(trace) {
        const callSid = trace.telephony?.callSid ?? trace.callId;
        const pending = this.pendingTelephony.get(callSid);
        if (!pending) return;

        this.patchTelephony(trace, pending);
        this.pendingTelephony.delete(callSid);
    }

    patchTelephony(trace, update) {
        const telephony = trace.telephony ?? emptyTelephony({ callSid: update.callSid ?? trace.callId });
        const signature = JSON.stringify({
            callSid: update.callSid ?? telephony.callSid,
            duration: update.connectedDurationSeconds,
            status: update.status,
            actual: update.actualPaise,
            source: update.source
        });

        const duplicate = telephony.lastSignature === signature;

        if (update.callSid) telephony.callSid = update.callSid;
        if (update.direction) telephony.direction = update.direction;
        if (update.status) telephony.status = update.status;
        if (update.startedAt) telephony.startedAt = update.startedAt;
        if (update.endedAt) telephony.endedAt = update.endedAt;
        if (update.connectedDurationSeconds != null) {
            telephony.connectedDurationSeconds = update.connectedDurationSeconds;
            telephony.durationSource = update.durationSource ?? "exotel";
        }
        if (Number.isInteger(update.actualPaise)) {
            telephony.actualPaise = update.actualPaise;
            telephony.reconciliation = {
                source: update.source ?? "exotel",
                at: update.invoicedAt ?? Date.now(),
                currency: update.currency ?? "INR"
            };
        }

        telephony.lastSignature = signature;
        trace.telephony = telephony;
        attachCallCost(trace);

        return { trace, cost: trace.cost, duplicate };
    }

    async applyTelephonyUpdate(callSid, update) {
        const live = this.findTrace(callSid);

        if (!live) {
            const fromDisk = await this.loadTraceFromDisk(callSid);
            if (!fromDisk) {
                this.pendingTelephony.set(callSid, { ...update, callSid });
                return { cost: null, duplicate: false, pending: true };
            }
            return this.persistTelephonyUpdate(fromDisk, update);
        }

        return this.persistTelephonyUpdate(live, update);
    }

    async persistTelephonyUpdate(trace, update) {
        const result = this.patchTelephony(trace, update);
        await this.writeLedger(trace);
        if (trace.endedAt) {
            this.track(writeCallReport(trace));
            this.track(writeOverviewReport(this.getAggregatedMetrics()));
        }
        return result;
    }

    async reconcileTelephonyCost(callSid, { actualPaise, source, currency, invoicedAt }) {
        return this.applyTelephonyUpdate(callSid, {
            callSid,
            actualPaise,
            source,
            currency,
            invoicedAt
        });
    }

    ledgerPath() {
        return path.join(this.outputDir, "billing-ledger.json");
    }

    async readLedger() {
        if (this.ledger) return this.ledger;

        try {
            this.ledger = JSON.parse(await fs.readFile(this.ledgerPath(), "utf8"));
        } catch {
            this.ledger = {};
        }

        return this.ledger;
    }

    async writeLedger(trace) {
        const callSid = trace.telephony?.callSid ?? trace.callId;
        const ledger = await this.readLedger();
        const current = ledger[callSid] ?? {};
        const next = {
            ...current,
            callSid,
            connectedDurationSeconds: trace.telephony?.connectedDurationSeconds ?? current.connectedDurationSeconds,
            actualPaise: trace.telephony?.actualPaise ?? current.actualPaise,
            reconciliation: trace.telephony?.reconciliation ?? current.reconciliation,
            updatedAt: Date.now()
        };

        if (JSON.stringify(current) === JSON.stringify({ ...next, updatedAt: current.updatedAt })) {
            return next;
        }

        ledger[callSid] = next;
        await fs.mkdir(this.outputDir, { recursive: true });
        await fs.writeFile(this.ledgerPath(), JSON.stringify(ledger, null, 2));
        return next;
    }

    async applyLedger(trace) {
        const callSid = trace.telephony?.callSid ?? trace.callId;
        const entry = (await this.readLedger())[callSid];
        if (!entry) return;

        this.patchTelephony(trace, {
            callSid,
            connectedDurationSeconds: entry.connectedDurationSeconds,
            actualPaise: entry.actualPaise,
            source: entry.reconciliation?.source,
            currency: entry.reconciliation?.currency,
            invoicedAt: entry.reconciliation?.at,
            durationSource: entry.connectedDurationSeconds != null ? "exotel" : null
        });
    }

    async loadTraceFromDisk(callSid) {
        const existing = this.completed.find((trace) =>
            trace.callId === callSid || trace.telephony?.callSid === callSid
        );
        if (existing) return existing;

        const file = path.join(
            this.outputDir,
            "calls",
            String(callSid).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120),
            "raw.json"
        );

        try {
            const trace = JSON.parse(await fs.readFile(file, "utf8"));
            this.completed.push(trace);
            return trace;
        } catch {
            return null;
        }
    }

    async maybeFetchExotelDetails(trace) {
        const callSid = trace.telephony?.callSid;
        if (!callSid || trace.metadata?.channel !== "exotel") return null;
        if (Number.isInteger(trace.telephony?.actualPaise) && trace.telephony?.durationSource === "exotel") {
            return null;
        }

        try {
            const result = await fetchExotelCallDetails(callSid);
            if (!result.ok) return result;

            this.patchTelephony(trace, {
                ...result.record,
                durationSource: result.record.connectedDurationSeconds != null ? "exotel" : trace.telephony.durationSource,
                source: result.source,
                invoicedAt: result.fetchedAt
            });
            await this.writeLedger(trace);
            return result;
        } catch (error) {
            console.error("[TELEMETRY] Exotel call details fetch failed:", error);
            return { ok: false, reason: error.message };
        }
    }

    async refreshAfterTelephony(trace) {
        const before = JSON.stringify(trace.cost);
        await this.applyLedger(trace);
        await this.maybeFetchExotelDetails(trace);
        attachCallCost(trace);

        if (JSON.stringify(trace.cost) !== before) {
            await writeCallReport(trace);
            await writeOverviewReport(this.getAggregatedMetrics());
        }
    }

    getAggregatedMetrics() {
        return {
            generatedAt: Date.now(),
            host: hostInfo(),
            baseline: this.baseline,
            activeCalls: this.traces.size,
            peakConcurrency: this.peakConcurrency,
            calls: this.completed
        };
    }

    getTrace(callId) {
        return this.traces.get(callId) ?? null;
    }

    startSampler() {
        if (this.sampler) return;

        this.sampler = setInterval(() => {
            for (const callId of this.traces.keys()) {
                this.recordResourceSnapshot(callId);
            }
        }, TELEMETRY_CONFIG.sampleIntervalMs);

        this.sampler.unref?.();
    }

    stopSampler() {
        if (!this.sampler) return;
        clearInterval(this.sampler);
        this.sampler = null;
    }

    track(promise) {
        const settled = Promise.resolve(promise)
            .catch((error) => console.error("[TELEMETRY] Report write failed:", error))
            .finally(() => this.pendingWrites.delete(settled));

        this.pendingWrites.add(settled);

        return settled;
    }

    async flush() {
        while (this.pendingWrites.size > 0) {
            await Promise.all([...this.pendingWrites]);
        }
    }
}

const telemetry = new Telemetry();

export default telemetry;
