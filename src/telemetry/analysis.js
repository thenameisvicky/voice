import fs from "node:fs";
import path from "node:path";

import { attachCallCost, summarizeSpend } from "./cost.js";
import {
    BENCHMARK_LEVELS,
    COST_MODEL,
    INFERENCE_STAGES,
    MODEL_INVENTORY,
    SLO_TARGETS,
    STAGES,
    STAGE_ORDER
} from "./config.js";

const GIB = 1024 ** 3;

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    if (sorted.length === 1) return sorted[0];

    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    if (lower === upper) return sorted[lower];

    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarize(values) {
    const clean = values.filter((value) => Number.isFinite(value));

    if (clean.length === 0) {
        return { count: 0, total: 0, mean: null, p50: null, p95: null, min: null, max: null };
    }

    const sorted = [...clean].sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);

    return {
        count: sorted.length,
        total,
        mean: total / sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        min: sorted[0],
        max: sorted.at(-1)
    };
}

const sum = (values) =>
    values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

function netCpuMs(resource, trace) {
    if (!resource) return 0;

    const idleCost = (trace.baseline?.idleCoresBusy ?? 0) * resource.wallMs;

    return Math.max(0, resource.busyCpuMs - idleCost);
}

export function boxCostPerHour() {
    const capex =
        COST_MODEL.hardwareCapex /
        (COST_MODEL.hardwareLifetimeMonths * COST_MODEL.availableHoursPerMonth);

    const power = (COST_MODEL.machineWatts / 1000) * COST_MODEL.electricityPerKwh;

    return { capex, power, total: capex + power };
}

export function modeledCallCost(durationMs) {
    if (!(durationMs > 0)) {
        return { available: false, compute: null, telephony: null, perCall: null };
    }

    const box = boxCostPerHour();
    const hours = durationMs / 3_600_000;
    const minutes = durationMs / 60_000;
    const compute = box.total * hours;
    const telephony = minutes * COST_MODEL.telephonyPerMinute;

    return {
        available: true,
        compute,
        telephony,
        perCall: compute + telephony
    };
}

export function costPerCompletedCall({ callsPerHour, successfulCallsPerHour, callMinutes }) {
    if (!(successfulCallsPerHour > 0)) {
        return { available: false, compute: null, telephony: null, perCompletedCall: null };
    }

    const box = boxCostPerHour();

    const compute = box.total / successfulCallsPerHour;
    const telephonyPerHour = (callsPerHour ?? 0) * (callMinutes ?? 0) * COST_MODEL.telephonyPerMinute;
    const telephony = telephonyPerHour / successfulCallsPerHour;

    return {
        available: true,
        boxCostPerHour: box.total,
        compute,
        telephony,
        perCompletedCall: compute + telephony,
        managedEquivalent: (callMinutes ?? 0) * COST_MODEL.managedVoiceAiPerMinute
    };
}

export function analyzeInferences(traces) {
    const spans = traces.flatMap((trace) => trace.spans);

    const stages = [...INFERENCE_STAGES, STAGES.TOOL]
        .map((stage) => {
            const stageSpans = spans.filter((span) => span.stage === stage);
            if (stageSpans.length === 0) return null;

            const failures = stageSpans.filter((span) => !span.ok).length;
            const audioMs = sum(stageSpans.map((span) =>
                span.result?.audioMs ?? span.metadata?.audioMs ?? 0
            ));

            const completionTokens = sum(traces.flatMap((trace) =>
                trace.modelUsage
                    .filter((usage) => usage.stage === stage)
                    .map((usage) => usage.completionTokens)
            ));

            const wallSeconds = sum(stageSpans.map((span) => span.durationMs)) / 1000;

            return {
                stage,
                calls: stageSpans.length,
                failures,
                errorRatePct: (failures / stageSpans.length) * 100,
                latencyMs: summarize(stageSpans.map((span) => span.durationMs)),
                audioSeconds: audioMs / 1000,
                completionTokens,
                tokensPerSecond: wallSeconds > 0 && completionTokens > 0
                    ? completionTokens / wallSeconds
                    : null,
                realtimeFactor: wallSeconds > 0 && audioMs > 0
                    ? (audioMs / 1000) / wallSeconds
                    : null
            };
        })
        .filter(Boolean);

    const vadCount = sum(traces.map((trace) => trace.vad?.count ?? 0));
    const failures = spans.filter((span) => !span.ok).length;

    return {
        stages,
        vad: vadCount > 0
            ? {
                count: vadCount,
                meanMs: sum(traces.map((trace) => trace.vad.totalMs)) / vadCount,
                maxMs: Math.max(...traces.map((trace) => trace.vad?.maxMs ?? 0))
            }
            : null,
        totalInferences: spans.length,
        failures,
        errorRatePct: spans.length > 0 ? (failures / spans.length) * 100 : 0
    };
}

export function describeTurn(turn, trace) {
    const spans = trace.spans.filter((span) => span.turnIndex === turn.index);

    const byStage = {};
    for (const stage of STAGE_ORDER) {
        byStage[stage] = sum(
            spans.filter((span) => span.stage === stage).map((span) => span.durationMs)
        );
    }

    const accountedMs = sum(Object.values(byStage));
    const cpuMs = netCpuMs(turn.resource, trace);

    const userAudioMs = turn.userAudioMs ?? 0;
    const replyAudioMs = turn.replyAudioMs ?? 0;

    return {
        index: turn.index,
        offsetMs: turn.startedAt - trace.startedAt,
        e2eLatencyMs: turn.durationMs,
        byStage,
        overheadMs: Math.max(0, (turn.durationMs ?? 0) - accountedMs),
        cpuSeconds: cpuMs / 1000,
        coresBusy: turn.resource?.coresBusy ?? null,
        tokens: turn.tokens,
        userAudioMs,
        replyAudioMs,
        cycleMs: userAudioMs + (turn.durationMs ?? 0) + replyAudioMs,
        toolCalls: turn.toolCalls,
        errorCount: turn.errorCount,
        ok: turn.ok !== false,
        transcript: turn.transcript,
        response: turn.response
    };
}

export function analyzeTurns(traces) {
    const turns = traces.flatMap((trace) =>
        trace.turns.filter((turn) => turn.endedAt).map((turn) => describeTurn(turn, trace))
    );

    if (turns.length === 0) return { turns: [], count: 0, empty: true };

    const stageLatency = {};
    for (const stage of STAGE_ORDER) {
        stageLatency[stage] = summarize(turns.map((turn) => turn.byStage[stage]));
    }

    const failed = turns.filter((turn) => !turn.ok).length;

    return {
        turns,
        count: turns.length,
        empty: false,
        e2eLatencyMs: summarize(turns.map((turn) => turn.e2eLatencyMs)),
        cpuSeconds: summarize(turns.map((turn) => turn.cpuSeconds)),
        coresBusy: summarize(turns.map((turn) => turn.coresBusy)),
        cycleMs: summarize(turns.map((turn) => turn.cycleMs)),
        userAudioMs: summarize(turns.map((turn) => turn.userAudioMs)),
        replyAudioMs: summarize(turns.map((turn) => turn.replyAudioMs)),
        completionTokens: summarize(turns.map((turn) => turn.tokens.completion)),
        overheadMs: summarize(turns.map((turn) => turn.overheadMs)),
        stageLatency,
        failedTurns: failed,
        errorRatePct: (failed / turns.length) * 100
    };
}

export function describeCall(trace) {
    const turns = trace.turns
        .filter((turn) => turn.endedAt)
        .map((turn) => describeTurn(turn, trace));

    const samples = trace.samples ?? [];
    const cpu = summarize(samples.map((sample) => sample.utilizationPct));
    const memory = summarize(samples.map((sample) => sample.memoryUtilizationPct));

    const peakStackRssBytes = samples.length > 0
        ? Math.max(...samples.map((sample) => sample.stackRssBytes ?? 0))
        : null;

    const baselineStackRss = trace.baseline?.stackRssBytes ?? null;
    const latency = summarize(turns.map((turn) => turn.e2eLatencyMs));
    const failures = trace.spans.filter((span) => !span.ok).length;

    const durationMinutes = (trace.durationMs ?? 0) / 60000;
    const completed = trace.businessActions.some((action) => action.ok);
    const accounting = trace.cost ?? attachCallCost(trace);

    const cost = costPerCompletedCall({
        callsPerHour: durationMinutes > 0 ? 60 / durationMinutes : 0,
        successfulCallsPerHour: completed && durationMinutes > 0 ? 60 / durationMinutes : 0,
        callMinutes: durationMinutes
    });

    return {
        callId: trace.callId,
        startedAt: trace.startedAt,
        durationMs: trace.durationMs,
        durationMinutes,
        metadata: trace.metadata,
        host: trace.host,
        baseline: trace.baseline,
        peakConcurrency: trace.peakConcurrency ?? 1,

        turnCount: turns.length,
        turns,

        cpuUtilizationPct: cpu,
        peakCpuUtilizationPct: cpu.max,
        memoryUtilizationPct: memory,
        peakStackRssBytes,
        stackRssDeltaBytes: peakStackRssBytes != null && baselineStackRss != null
            ? Math.max(0, peakStackRssBytes - baselineStackRss)
            : null,
        gpu: trace.host?.gpu ?? { present: false },
        p50LatencyMs: latency.p50,
        p95LatencyMs: latency.p95,
        successfulCallsPerMinute: completed && durationMinutes > 0 ? 1 / durationMinutes : 0,
        errorRatePct: trace.spans.length > 0 ? (failures / trace.spans.length) * 100 : 0,
        costPerCompletedCall: cost.perCompletedCall,
        cost,
        modeledCallCost: modeledCallCost(trace.durationMs),
        costPerCall: accounting.actual_total_cost
            ?? accounting.estimated_total_cost
            ?? accounting.actual_telephony_cost
            ?? accounting.estimated_telephony_cost
            ?? null,

        cpuSeconds: netCpuMs(trace.resource, trace) / 1000,
        coresBusy: trace.resource?.coresBusy ?? null,
        tokens: {
            prompt: sum(trace.modelUsage.map((usage) => usage.promptTokens)),
            completion: sum(trace.modelUsage.map((usage) => usage.completionTokens)),
            total: sum(trace.modelUsage.map((usage) => usage.totalTokens))
        },
        audioMs: {
            user: sum(turns.map((turn) => turn.userAudioMs)),
            reply: sum(turns.map((turn) => turn.replyAudioMs))
        },
        queueWaitMs: summarize((trace.queueWaits ?? []).map((wait) => wait.waitMs)),
        toolCalls: turns.flatMap((turn) => turn.toolCalls),
        businessActions: trace.businessActions,
        transfer: trace.transfer ?? null,
        completed,
        errors: trace.errors,
        accounting,
        telephony: accounting.telephony,
        spanCount: trace.spans.length,
        spanFailures: failures,
        samples
    };
}

export function analyzeCalls(traces) {
    const calls = traces.map(describeCall);

    if (calls.length === 0) return { calls: [], count: 0, empty: true };

    const completed = calls.filter((call) => call.completed).length;

    return {
        calls,
        count: calls.length,
        empty: false,
        completedCalls: completed,
        completionRatePct: (completed / calls.length) * 100,
        durationSeconds: summarize(calls.map((call) => call.durationMs / 1000)),
        cpuSeconds: summarize(calls.map((call) => call.cpuSeconds)),
        coresBusy: summarize(calls.map((call) => call.coresBusy)),
        turnsPerCall: summarize(calls.map((call) => call.turnCount)),
        tokensPerCall: summarize(calls.map((call) => call.tokens.total)),
        stackRssDeltaBytes: summarize(calls.map((call) => call.stackRssDeltaBytes)),
        errorRatePct: summarize(calls.map((call) => call.errorRatePct)),
        spend: summarizeSpend(traces)
    };
}

function measureLevel(level, traces) {
    if (traces.length === 0) return { level, tested: false, calls: 0 };

    const turns = traces.flatMap((trace) =>
        trace.turns.filter((turn) => turn.endedAt).map((turn) => describeTurn(turn, trace))
    );

    const samples = traces.flatMap((trace) => trace.samples ?? []);
    const spans = traces.flatMap((trace) => trace.spans);
    const failures = spans.filter((span) => !span.ok).length;
    const queueWaits = traces.flatMap((trace) => trace.queueWaits ?? []);

    const startedAt = Math.min(...traces.map((trace) => trace.startedAt));
    const endedAt = Math.max(...traces.map((trace) => trace.endedAt ?? trace.startedAt));
    const windowMinutes = Math.max(endedAt - startedAt, 1) / 60000;

    const completedCalls = traces.filter((trace) =>
        trace.businessActions.some((action) => action.ok)
    ).length;

    const attemptedBusiness = traces.some((trace) => trace.businessActions.length > 0);

    const callsPerMinute = traces.length / windowMinutes;
    const successfulCallsPerMinute = completedCalls / windowMinutes;
    const callMinutes = sum(traces.map((trace) => trace.durationMs)) / traces.length / 60000;

    const cpu = summarize(samples.map((sample) => sample.utilizationPct));
    const memory = summarize(samples.map((sample) => sample.memoryUtilizationPct));
    const latency = summarize(turns.map((turn) => turn.e2eLatencyMs));

    const cost = costPerCompletedCall({
        callsPerHour: callsPerMinute * 60,
        successfulCallsPerHour: successfulCallsPerMinute * 60,
        callMinutes
    });

    const gpu = traces[0]?.host?.gpu ?? { present: false };

    const metrics = {
        level,
        tested: true,
        calls: traces.length,
        completedCalls,
        turns: turns.length,
        windowMinutes,

        cpuUtilizationPct: cpu.mean,
        peakCpuUtilizationPct: cpu.max,
        memoryUtilizationPct: memory.max,
        stackRssBytes: samples.length > 0
            ? Math.max(...samples.map((sample) => sample.stackRssBytes ?? 0))
            : null,
        gpu,
        gpuUtilizationPct: gpu.present && gpu.totalBytes > 0
            ? (gpu.usedBytes / gpu.totalBytes) * 100
            : null,
        p50LatencyMs: latency.p50,
        p95LatencyMs: latency.p95,
        callsPerMinute,
        successfulCallsPerMinute,
        completionRatePct: attemptedBusiness ? (completedCalls / traces.length) * 100 : null,
        errorRatePct: spans.length > 0 ? (failures / spans.length) * 100 : 0,
        costPerCompletedCall: cost.perCompletedCall,
        cost,

        queueWaitP95Ms: queueWaits.length > 0
            ? summarize(queueWaits.map((wait) => wait.waitMs)).p95
            : null,
        cpuSecondsPerTurn: summarize(turns.map((turn) => turn.cpuSeconds)).mean
    };

    return { ...metrics, meetsTargets: meetsTargets(metrics) };
}

function meetsTargets(metrics) {
    const checks = [
        [metrics.p50LatencyMs, SLO_TARGETS.p50LatencyMs, "max"],
        [metrics.p95LatencyMs, SLO_TARGETS.p95LatencyMs, "max"],
        [metrics.errorRatePct, SLO_TARGETS.maxErrorRatePct, "max"],
        [metrics.completionRatePct, SLO_TARGETS.minCompletionRatePct, "min"],
        [metrics.cpuUtilizationPct, SLO_TARGETS.maxCpuUtilizationPct, "max"],
        [metrics.memoryUtilizationPct, SLO_TARGETS.maxMemoryUtilizationPct, "max"],
        [metrics.queueWaitP95Ms, SLO_TARGETS.maxQueueWaitP95Ms, "max"]
    ];

    const failed = checks.filter(([value, target, compare]) =>
        Number.isFinite(value) && (compare === "max" ? value > target : value < target)
    );

    return failed.length === 0;
}

export function benchmark(traces) {
    const grouped = new Map(BENCHMARK_LEVELS.map((level) => [level, []]));

    for (const trace of traces) {
        const level = trace.peakConcurrency ?? 1;
        if (grouped.has(level)) grouped.get(level).push(trace);
    }

    const levels = BENCHMARK_LEVELS.map((level) => measureLevel(level, grouped.get(level)));
    const tested = levels.filter((entry) => entry.tested);
    const passing = tested.filter((entry) => entry.meetsTargets);

    const untracked = traces.filter((trace) =>
        !BENCHMARK_LEVELS.includes(trace.peakConcurrency ?? 1)
    ).length;

    return {
        levels,
        tested: tested.length,
        untracked,
        maxSupportedConcurrency: passing.length > 0
            ? Math.max(...passing.map((entry) => entry.level))
            : null,
        highestTested: tested.length > 0 ? Math.max(...tested.map((entry) => entry.level)) : null,
        ceilingNotReached: tested.length > 0 && passing.length === tested.length,
        targets: SLO_TARGETS
    };
}

function directorySize(target) {
    let total = 0;

    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const full = path.join(target, entry.name);
        if (entry.isDirectory()) total += directorySize(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
    }

    return total;
}

export function modelFootprint() {
    const models = MODEL_INVENTORY.map((model) => {
        try {
            if (model.path && fs.existsSync(model.path)) {
                const stat = fs.statSync(model.path);

                return {
                    ...model,
                    bytes: stat.isDirectory() ? directorySize(model.path) : stat.size,
                    measured: true
                };
            }
        } catch {
        }

        return { ...model, bytes: model.fallbackBytes, measured: false };
    });

    return { models, totalBytes: sum(models.map((model) => model.bytes)) };
}

function answerCompute({ turnStats, host }) {
    if (turnStats.empty) return { available: false };

    const cpuSeconds = turnStats.cpuSeconds;
    const audioSeconds = (turnStats.userAudioMs.mean + turnStats.replyAudioMs.mean) / 1000;

    return {
        available: true,
        cpuSecondsPerTurn: cpuSeconds,
        machineSharePct: turnStats.coresBusy.mean != null
            ? (turnStats.coresBusy.mean / host.cores) * 100
            : null,
        coresBusyDuringTurn: turnStats.coresBusy,
        e2eLatencyMs: turnStats.e2eLatencyMs,
        stageLatencyMs: turnStats.stageLatency,
        audioSecondsPerTurn: audioSeconds,
        realtimeFactor: cpuSeconds.mean > 0 ? audioSeconds / cpuSeconds.mean : null,
        completionTokensPerTurn: turnStats.completionTokens
    };
}

function answerConcurrency({ turnStats, callStats, host, baseline, bench }) {
    if (turnStats.empty) return { available: false };

    const usableCores = host.cores * COST_MODEL.utilizationTarget - (baseline?.idleCoresBusy ?? 0);

    const coresPerCall = turnStats.cycleMs.mean > 0
        ? (turnStats.cpuSeconds.mean * 1000) / turnStats.cycleMs.mean
        : null;

    const cpuBound = coresPerCall > 0 ? Math.floor(usableCores / coresPerCall) : null;

    const ramPerCallBytes = callStats.empty
        ? null
        : (callStats.stackRssDeltaBytes.p95 ?? callStats.stackRssDeltaBytes.mean);

    const usableRamBytes =
        host.systemTotalBytes * COST_MODEL.memoryTarget - (baseline?.stackRssBytes ?? 0);

    const ramBound = ramPerCallBytes > 0 ? Math.floor(usableRamBytes / ramPerCallBytes) : null;

    const bounds = [cpuBound, ramBound].filter((value) => Number.isFinite(value) && value >= 0);
    const modelled = bounds.length > 0 ? Math.max(1, Math.min(...bounds)) : null;

    const measured = bench.maxSupportedConcurrency;

    return {
        available: true,
        basis: measured != null ? "benchmark" : "model",
        measured,
        modelled,
        concurrentCalls: measured ?? modelled,
        highestTested: bench.highestTested,
        ceilingNotReached: bench.ceilingNotReached,
        cores: host.cores,
        usableCores,
        coresPerCall,
        cpuBound,
        ramPerCallBytes,
        ramBound,
        stackBaselineBytes: baseline?.stackRssBytes ?? 0,
        stackMeasured: baseline?.stackComplete ?? false,
        bottleneck: cpuBound == null || ramBound == null
            ? "cpu"
            : cpuBound <= ramBound ? "cpu" : "memory",
        meanCallSeconds: callStats.empty ? null : callStats.durationSeconds.mean
    };
}

function answerCost({ callStats, concurrency, bench }) {
    if (callStats.empty) return { available: false };

    const callMinutes = (callStats.durationSeconds.mean ?? 0) / 60;

    const level = bench.levels.find(
        (entry) => entry.tested && entry.level === bench.maxSupportedConcurrency
    );

    const callsPerHour = level
        ? level.callsPerMinute * 60
        : (concurrency.concurrentCalls ?? 1) * (3600 / (callStats.durationSeconds.mean || 1));

    const successfulCallsPerHour = level
        ? level.successfulCallsPerMinute * 60
        : callsPerHour * (callStats.completionRatePct / 100);

    const cost = costPerCompletedCall({ callsPerHour, successfulCallsPerHour, callMinutes });
    const box = boxCostPerHour();

    return {
        ...cost,
        available: true,
        basis: level ? "benchmark" : "model",
        currency: COST_MODEL.currency,
        symbol: COST_MODEL.currencySymbol,
        capexPerHour: box.capex,
        powerPerHour: box.power,
        monthlyBoxCost: box.total * COST_MODEL.availableHoursPerMonth,
        callMinutes,
        callsPerHour,
        successfulCallsPerHour,
        completionRatePct: callStats.completionRatePct,
        completedCalls: callStats.completedCalls,
        totalCalls: callStats.count,
        cloudEquivalent: ((callStats.cpuSeconds.mean ?? 0) / 3600) * COST_MODEL.cloudPerVcpuHour,
        savingsVsManagedPct: cost.perCompletedCall != null && cost.managedEquivalent > 0
            ? (1 - cost.perCompletedCall / cost.managedEquivalent) * 100
            : null
    };
}

const CORE_COUNTS = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
const RAM_SIZES_GIB = [4, 8, 16, 32, 64, 128, 256];

const snapUp = (value, options) => options.find((option) => option >= value) ?? options.at(-1);

function answerHardware({ concurrency, host }) {
    const footprint = modelFootprint();

    if (!concurrency.available) {
        return { available: false, models: footprint.models, modelBytes: footprint.totalBytes };
    }

    const coresPerCall = concurrency.coresPerCall ?? 0;
    const ramPerCall = concurrency.ramPerCallBytes ?? 0;

    const baseRamBytes = concurrency.stackMeasured && concurrency.stackBaselineBytes > 0
        ? concurrency.stackBaselineBytes
        : footprint.totalBytes + 512 * 1024 * 1024;

    const tiers = BENCHMARK_LEVELS.map((calls) => {
        const rawCores = (calls * coresPerCall) / COST_MODEL.utilizationTarget;
        const rawRamGiB = ((baseRamBytes + calls * ramPerCall) / COST_MODEL.memoryTarget) / GIB;

        return {
            concurrentCalls: calls,
            cores: snapUp(rawCores, CORE_COUNTS),
            coresExact: rawCores,
            ramGiB: snapUp(rawRamGiB, RAM_SIZES_GIB),
            ramGiBExact: rawRamGiB
        };
    });

    return {
        available: true,
        measuredOn: {
            cpuModel: host.cpuModel,
            cores: host.cores,
            ramGiB: host.systemTotalBytes / GIB
        },
        coresPerCall,
        ramPerCallBytes: ramPerCall,
        baseRamBytes,
        baseRamMeasured: concurrency.stackMeasured,
        models: footprint.models,
        modelBytes: footprint.totalBytes,
        diskGiB: Math.ceil((footprint.totalBytes * COST_MODEL.diskHeadroom) / GIB),
        tiers,
        minimum: tiers[0],
        gpu: host.gpu
    };
}

export function analyze(aggregate) {
    const traces = aggregate.calls ?? [];
    const host = aggregate.host;
    const baseline = aggregate.baseline;

    const inference = analyzeInferences(traces);
    const turn = analyzeTurns(traces);
    const call = analyzeCalls(traces);
    const bench = benchmark(traces);

    const compute = answerCompute({ turnStats: turn, host });
    const concurrency = answerConcurrency({ turnStats: turn, callStats: call, host, baseline, bench });
    const cost = answerCost({ callStats: call, concurrency, bench });
    const hardware = answerHardware({ concurrency, host });

    return {
        generatedAt: aggregate.generatedAt ?? Date.now(),
        host,
        baseline,
        activeCalls: aggregate.activeCalls ?? 0,
        peakConcurrency: aggregate.peakConcurrency ?? null,
        inference,
        turn,
        call,
        benchmark: bench,
        answers: { compute, concurrency, cost, hardware },
        spend: call.spend,
        assumptions: COST_MODEL,
        targets: SLO_TARGETS
    };
}

export function analyzeOne(trace) {
    return {
        generatedAt: Date.now(),
        host: trace.host,
        baseline: trace.baseline,
        detail: describeCall(trace),
        inference: analyzeInferences([trace]),
        spend: summarizeSpend([trace])
    };
}
