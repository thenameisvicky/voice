import {
    addPaise,
    applyPerMinuteRate,
    billableSeconds,
    dividePaise,
    paiseToRupees
} from "./money.js";
import {
    COST_CALCULATION_VERSION,
    rateForDirection,
    resolveExotelTariff,
    resolveInferenceRates,
    snapshotTariff
} from "./tariff.js";

const TELEPHONY_STATUSES = {
    ACTUAL: "actual",
    ESTIMATED: "estimated",
    PENDING: "pending",
    UNAVAILABLE: "unavailable",
    NOT_APPLICABLE: "not_applicable",
    NOT_BILLED: "not_billed"
};

function amount(paise) {
    return Number.isInteger(paise) ? paiseToRupees(paise) : null;
}

function usageTotals(trace) {
    const usage = trace.modelUsage ?? [];
    const turns = trace.turns ?? [];

    const tokens = usage
        .filter((record) => record.stage === "llm" && (record.totalTokens ?? 0) > 0)
        .reduce((total, record) => total + Number(record.totalTokens || 0), 0);

    const asrAudioMs = usage
        .filter((record) => record.stage === "asr" && Number.isFinite(record.audioMs))
        .reduce((total, record) => total + record.audioMs, 0);

    const ttsAudioMs = usage
        .filter((record) => record.stage === "tts" && Number.isFinite(record.audioMs))
        .reduce((total, record) => total + record.audioMs, 0);

    const userAudioMs = turns.reduce((total, turn) => total + (Number(turn.userAudioMs) || 0), 0);
    const replyAudioMs = turns.reduce((total, turn) => total + (Number(turn.replyAudioMs) || 0), 0);

    return {
        llmTokens: tokens,
        asrAudioMs: asrAudioMs || userAudioMs,
        ttsAudioMs: ttsAudioMs || replyAudioMs
    };
}

function inferenceComponent(ratePaisePerMinute, audioMs, rounding) {
    if (ratePaisePerMinute == null) return { paise: null, status: TELEPHONY_STATUSES.UNAVAILABLE };
    const seconds = Math.round((audioMs || 0) / 1000);
    return {
        paise: applyPerMinuteRate(ratePaisePerMinute, seconds, rounding) ?? 0,
        status: TELEPHONY_STATUSES.ESTIMATED
    };
}

function inferenceTokenComponent(ratePaisePer1k, tokens) {
    if (ratePaisePer1k == null) return { paise: null, status: TELEPHONY_STATUSES.UNAVAILABLE };
    const tokensUsed = tokens || 0;
    const paise = dividePaise(ratePaisePer1k * tokensUsed, 1000, "ceil") ?? 0;
    return { paise, status: TELEPHONY_STATUSES.ESTIMATED };
}

function telephonyStatus({ channel, tariff, rate, connectedSeconds, actualPaise }) {
    if (channel !== "exotel") return TELEPHONY_STATUSES.NOT_APPLICABLE;
    if (Number.isInteger(actualPaise)) return TELEPHONY_STATUSES.ACTUAL;
    if (!tariff?.configured || rate == null) return TELEPHONY_STATUSES.UNAVAILABLE;
    if (connectedSeconds == null) return TELEPHONY_STATUSES.PENDING;
    if (connectedSeconds === 0) return TELEPHONY_STATUSES.NOT_BILLED;
    return TELEPHONY_STATUSES.ESTIMATED;
}

export function emptyTelephony(overrides = {}) {
    return {
        provider: "exotel",
        callSid: null,
        direction: null,
        startedAt: null,
        endedAt: null,
        connectedDurationSeconds: null,
        appDurationSeconds: null,
        billableDurationSeconds: null,
        durationSource: null,
        status: null,
        tariff: null,
        currency: "INR",
        estimatedPaise: null,
        actualPaise: null,
        costStatus: TELEPHONY_STATUSES.UNAVAILABLE,
        reconciliation: null,
        ...overrides
    };
}

function tariffFromSnapshot(snapshot) {
    if (!snapshot) return null;

    return {
        ...snapshot,
        configured: snapshot.inboundPaisePerMinute != null || snapshot.outboundPaisePerMinute != null
    };
}

export function computeCallCost(trace, {
    tariff = tariffFromSnapshot(trace.telephony?.tariff) ?? resolveExotelTariff(),
    inferenceRates = resolveInferenceRates()
} = {}) {
    const channel = trace.metadata?.channel ?? null;
    const telephony = { ...(trace.telephony ?? emptyTelephony()) };

    if (telephony.connectedDurationSeconds == null && trace.durationMs != null && channel === "exotel") {
        telephony.connectedDurationSeconds = Math.round(trace.durationMs / 1000);
        telephony.appDurationSeconds = telephony.appDurationSeconds ?? telephony.connectedDurationSeconds;
        telephony.durationSource = telephony.durationSource ?? "application";
    }

    const direction = telephony.direction ?? "inbound";
    const rate = rateForDirection(tariff, direction);
    const connectedSeconds = telephony.connectedDurationSeconds;
    const billable = connectedSeconds == null
        ? null
        : billableSeconds(connectedSeconds, tariff.incrementSeconds, tariff.rounding);

    const estimatedPaise = channel === "exotel" && tariff.configured && rate != null && billable != null
        ? applyPerMinuteRate(rate, billable, tariff.rounding)
        : null;

    const costStatus = telephonyStatus({
        channel,
        tariff,
        rate,
        connectedSeconds,
        actualPaise: telephony.actualPaise
    });

    const nextTelephony = {
        ...telephony,
        direction,
        billableDurationSeconds: billable,
        tariff: snapshotTariff(tariff),
        currency: tariff.currency,
        estimatedPaise,
        costStatus
    };

    const usage = usageTotals(trace);
    const asr = inferenceComponent(inferenceRates.asrPaisePerAudioMinute, usage.asrAudioMs, tariff.rounding);
    const tts = inferenceComponent(inferenceRates.ttsPaisePerAudioMinute, usage.ttsAudioMs, tariff.rounding);
    const llm = inferenceTokenComponent(inferenceRates.llmPaisePer1kTokens, usage.llmTokens);

    const inferencePaise = addPaise(asr.paise, llm.paise, tts.paise);
    const inferenceStatus = [asr, llm, tts].every((part) => part.status === TELEPHONY_STATUSES.UNAVAILABLE)
        ? TELEPHONY_STATUSES.UNAVAILABLE
        : [asr, llm, tts].some((part) => part.status === TELEPHONY_STATUSES.UNAVAILABLE)
            ? TELEPHONY_STATUSES.PENDING
            : TELEPHONY_STATUSES.ESTIMATED;

    const telephonyForTotal = costStatus === TELEPHONY_STATUSES.ACTUAL
        ? nextTelephony.actualPaise
        : estimatedPaise;

    const estimatedTotalPaise = addPaise(estimatedPaise, inferencePaise);
    const actualTotalPaise = costStatus === TELEPHONY_STATUSES.ACTUAL
        ? addPaise(nextTelephony.actualPaise, inferencePaise)
        : null;

    return {
        estimated_telephony_cost: amount(estimatedPaise),
        actual_telephony_cost: amount(nextTelephony.actualPaise),
        telephony_cost_status: costStatus,
        asr_cost: amount(asr.paise),
        llm_cost: amount(llm.paise),
        tts_cost: amount(tts.paise),
        inference_cost: amount(inferencePaise),
        estimated_total_cost: amount(estimatedTotalPaise),
        actual_total_cost: amount(actualTotalPaise),
        currency: tariff.currency || "INR",
        cost_calculation_version: COST_CALCULATION_VERSION,
        paise: {
            estimatedTelephony: estimatedPaise,
            actualTelephony: nextTelephony.actualPaise,
            asr: asr.paise,
            llm: llm.paise,
            tts: tts.paise,
            inference: inferencePaise,
            estimatedTotal: estimatedTotalPaise,
            actualTotal: actualTotalPaise,
            telephonyForTotal
        },
        inference_cost_status: inferenceStatus,
        telephony: nextTelephony
    };
}

export function attachCallCost(trace, options) {
    const cost = computeCallCost(trace, options);
    trace.telephony = cost.telephony;
    trace.cost = cost;
    return cost;
}

export function summarizeSpend(traces) {
    let telephonyPaise = 0;
    let telephonyKnown = 0;
    let inferencePaise = 0;
    let inferenceKnown = 0;
    let estimatedTotalPaise = 0;
    let estimatedKnown = 0;
    let actualTotalPaise = 0;
    let actualKnown = 0;
    let connectedSeconds = 0;
    let successfulActions = 0;

    for (const trace of traces) {
        const cost = trace.cost ?? computeCallCost(trace);
        const telephony = cost.telephony ?? {};
        const paise = cost.paise ?? {};

        if (Number.isInteger(telephony.connectedDurationSeconds)) {
            connectedSeconds += telephony.connectedDurationSeconds;
        }

        successfulActions += (trace.businessActions ?? []).filter((action) => action.ok).length;

        if (Number.isInteger(paise.telephonyForTotal)) {
            telephonyPaise += paise.telephonyForTotal;
            telephonyKnown += 1;
        }

        if (Number.isInteger(paise.inference)) {
            inferencePaise += paise.inference;
            inferenceKnown += 1;
        }

        if (Number.isInteger(paise.estimatedTotal)) {
            estimatedTotalPaise += paise.estimatedTotal;
            estimatedKnown += 1;
        }

        if (Number.isInteger(paise.actualTotal)) {
            actualTotalPaise += paise.actualTotal;
            actualKnown += 1;
        }
    }

    const callCount = traces.length;
    const telephonySpend = telephonyKnown > 0 ? telephonyPaise : null;
    const inferenceSpend = inferenceKnown > 0 ? inferencePaise : null;
    const estimatedSpend = estimatedKnown > 0 ? estimatedTotalPaise : null;
    const actualSpend = actualKnown > 0 ? actualTotalPaise : null;
    const spendBasis = estimatedSpend ?? telephonySpend;
    const perCall = spendBasis != null && callCount > 0
        ? dividePaise(spendBasis, callCount, "nearest")
        : null;
    const perAction = spendBasis != null && successfulActions > 0
        ? dividePaise(spendBasis, successfulActions, "nearest")
        : null;
    const perConnectedMinute = telephonySpend != null && connectedSeconds > 0
        ? dividePaise(telephonySpend * 60, connectedSeconds, "nearest")
        : null;

    return {
        currency: "INR",
        calls: callCount,
        successfulBusinessActions: successfulActions,
        total_telephony_spend: amount(telephonySpend),
        total_inference_spend: amount(inferenceSpend),
        average_cost_per_call: amount(perCall),
        average_cost_per_successful_business_action: amount(perAction),
        cost_per_connected_minute: amount(perConnectedMinute),
        actual_total_spend: amount(actualSpend),
        paise: {
            telephony: telephonySpend,
            inference: inferenceSpend,
            estimatedTotal: estimatedSpend,
            actualTotal: actualSpend,
            perCall,
            perAction,
            perConnectedMinute
        }
    };
}

export { TELEPHONY_STATUSES };
