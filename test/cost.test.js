import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { attachCallCost, computeCallCost, summarizeSpend } from "../src/telemetry/cost.js";
import { billableSeconds, paiseToRupees, rupeesToPaise } from "../src/telemetry/money.js";
import { resolveExotelTariff } from "../src/telemetry/tariff.js";
import { Telemetry } from "../src/telemetry/telemetry.js";
import { parseCallbackBody, parseExotelCallRecord } from "../src/telephony/exotelStatus.js";

const inboundTariff = {
    configured: true,
    currency: "INR",
    inboundPaisePerMinute: 80,
    outboundPaisePerMinute: 150,
    incrementSeconds: 60,
    rounding: "ceil",
    version: "1"
};

function traceFor({
    callId = "CA123",
    channel = "exotel",
    direction = "inbound",
    connectedDurationSeconds = 90,
    durationSource = "exotel",
    businessActions = [],
    tokens = 0,
    actualPaise = null
} = {}) {
    return {
        callId,
        durationMs: connectedDurationSeconds * 1000,
        metadata: { channel, direction },
        businessActions,
        modelUsage: tokens
            ? [{ stage: "llm", totalTokens: tokens, promptTokens: tokens, completionTokens: 0 }]
            : [],
        turns: [],
        telephony: {
            provider: "exotel",
            callSid: callId,
            direction,
            connectedDurationSeconds,
            durationSource,
            status: "completed",
            actualPaise,
            reconciliation: null
        }
    };
}

test("money uses integer paise, not floats", () => {
    assert.equal(rupeesToPaise("1.20"), 120);
    assert.equal(rupeesToPaise("0.6"), 60);
    assert.equal(paiseToRupees(80), "0.80");
    assert.equal(billableSeconds(5, 60, "ceil"), 60);
    assert.equal(billableSeconds(61, 60, "ceil"), 120);
});

test("1. normal inbound call", () => {
    const cost = computeCallCost(traceFor({ connectedDurationSeconds: 90, direction: "inbound" }), {
        tariff: inboundTariff,
        inferenceRates: {}
    });

    assert.equal(cost.estimated_telephony_cost, "1.60");
    assert.equal(cost.actual_telephony_cost, null);
    assert.equal(cost.telephony_cost_status, "estimated");
    assert.equal(cost.currency, "INR");
    assert.equal(cost.cost_calculation_version, 1);
    assert.equal(cost.telephony.billableDurationSeconds, 120);
    assert.equal(cost.telephony.direction, "inbound");
});

test("2. outbound call uses the outbound rate", () => {
    const cost = computeCallCost(traceFor({
        direction: "outbound",
        connectedDurationSeconds: 30
    }), { tariff: inboundTariff, inferenceRates: {} });

    assert.equal(cost.estimated_telephony_cost, "1.50");
    assert.equal(cost.telephony.direction, "outbound");
    assert.equal(cost.telephony.billableDurationSeconds, 60);
});

test("3. call shorter than one billing increment rounds up", () => {
    const cost = computeCallCost(traceFor({ connectedDurationSeconds: 5 }), {
        tariff: inboundTariff,
        inferenceRates: {}
    });

    assert.equal(cost.telephony.billableDurationSeconds, 60);
    assert.equal(cost.estimated_telephony_cost, "0.80");
});

test("4. call spanning multiple billing increments", () => {
    const cost = computeCallCost(traceFor({ connectedDurationSeconds: 61 }), {
        tariff: inboundTariff,
        inferenceRates: {}
    });

    assert.equal(cost.telephony.billableDurationSeconds, 120);
    assert.equal(cost.estimated_telephony_cost, "1.60");
});

test("5. missing tariff is unavailable, never zero", () => {
    const tariff = resolveExotelTariff({});
    const cost = computeCallCost(traceFor({ connectedDurationSeconds: 90 }), {
        tariff,
        inferenceRates: {}
    });

    assert.equal(tariff.configured, false);
    assert.equal(cost.estimated_telephony_cost, null);
    assert.equal(cost.telephony_cost_status, "unavailable");
    assert.notEqual(cost.estimated_telephony_cost, "0.00");
    assert.equal(cost.paise.estimatedTelephony, null);
});

test("6. duplicate Exotel completion callbacks are idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yuga-cost-"));
    const telemetry = new Telemetry();
    telemetry.outputDir = dir;

    telemetry.startTrace("CA123", { channel: "exotel", direction: "inbound" });

    const first = await telemetry.applyTelephonyUpdate("CA123", {
        callSid: "CA123",
        connectedDurationSeconds: 90,
        status: "completed",
        source: "exotel-status-callback"
    });
    const second = await telemetry.applyTelephonyUpdate("CA123", {
        callSid: "CA123",
        connectedDurationSeconds: 90,
        status: "completed",
        source: "exotel-status-callback"
    });

    assert.equal(second.duplicate, true);
    assert.equal(first.trace.telephony.connectedDurationSeconds, 90);
    assert.equal(second.trace.telephony.connectedDurationSeconds, 90);
    assert.equal(telemetry.completed.length, 0);
});

test("7. failed business action is still a billable call", () => {
    const failed = traceFor({
        connectedDurationSeconds: 90,
        businessActions: [{ action: "create_invoice", ok: false }]
    });
    const succeeded = traceFor({
        callId: "CA999",
        connectedDurationSeconds: 60,
        businessActions: [{ action: "create_invoice", ok: true }]
    });

    attachCallCost(failed, { tariff: inboundTariff, inferenceRates: {} });
    attachCallCost(succeeded, { tariff: inboundTariff, inferenceRates: {} });

    const spend = summarizeSpend([failed, succeeded]);

    assert.equal(failed.cost.estimated_telephony_cost, "1.60");
    assert.equal(spend.successfulBusinessActions, 1);
    assert.equal(spend.calls, 2);
    assert.ok(spend.total_telephony_spend);
    assert.ok(spend.average_cost_per_successful_business_action);
    assert.equal(spend.paise.telephony, 160 + 80);
});

test("8. estimated cost later reconciled with actual billing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yuga-cost-"));
    const telemetry = new Telemetry();
    telemetry.outputDir = dir;

    const live = telemetry.startTrace("CA123", { channel: "exotel", direction: "inbound" });
    live.telephony.connectedDurationSeconds = 90;
    live.telephony.durationSource = "exotel";
    attachCallCost(live, { tariff: inboundTariff, inferenceRates: {} });

    assert.equal(live.cost.telephony_cost_status, "estimated");
    assert.equal(live.cost.estimated_telephony_cost, "1.60");
    assert.equal(live.cost.actual_telephony_cost, null);
    assert.equal(live.cost.actual_total_cost, null);

    const reconciled = await telemetry.reconcileTelephonyCost("CA123", {
        actualPaise: 250,
        source: "exotel-cdr-import",
        currency: "INR",
        invoicedAt: 1
    });

    assert.equal(reconciled.duplicate, false);
    assert.equal(reconciled.cost.telephony_cost_status, "actual");
    assert.equal(reconciled.cost.estimated_telephony_cost, "1.60");
    assert.equal(reconciled.cost.actual_telephony_cost, "2.50");
    assert.equal(reconciled.cost.telephony.reconciliation.source, "exotel-cdr-import");
    assert.equal(reconciled.cost.telephony.reconciliation.at, 1);
});

test("9. missing actual billing keeps the estimate", () => {
    const cost = computeCallCost(traceFor({ connectedDurationSeconds: 90 }), {
        tariff: inboundTariff,
        inferenceRates: {}
    });

    assert.equal(cost.telephony_cost_status, "estimated");
    assert.equal(cost.actual_telephony_cost, null);
    assert.equal(cost.actual_total_cost, null);
    assert.equal(cost.estimated_telephony_cost, "1.60");
});

test("status callback parser only uses documented Exotel fields", () => {
    const record = parseCallbackBody(
        "application/x-www-form-urlencoded",
        "CallSid=CA123&Status=completed&Direction=inbound&Duration=45&From=098&To=099"
    );
    const parsed = parseExotelCallRecord(record);

    assert.equal(parsed.callSid, "CA123");
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.direction, "inbound");
    assert.equal(parsed.connectedDurationSeconds, 45);
    assert.equal(parsed.actualPaise, null);
});

test("Price is stored as actual only when the official field is present", () => {
    const parsed = parseExotelCallRecord({
        CallSid: "CA123",
        Duration: "60",
        Price: "0.80"
    });

    assert.equal(parsed.actualPaise, 80);
});

test("LLM retries with zero tokens are not double-counted", () => {
    const trace = traceFor({ connectedDurationSeconds: 60 });
    trace.modelUsage = [
        { stage: "llm", totalTokens: 0, retries: 1 },
        { stage: "llm", totalTokens: 1000, retries: 1 }
    ];

    const cost = computeCallCost(trace, {
        tariff: inboundTariff,
        inferenceRates: { llmPaisePer1kTokens: 10, asrPaisePerAudioMinute: null, ttsPaisePerAudioMinute: null }
    });

    assert.equal(cost.llm_cost, "0.10");
    assert.equal(cost.inference_cost, null);
});
