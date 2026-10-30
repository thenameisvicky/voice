import fs from "node:fs/promises";
import path from "node:path";

import { analyze, analyzeOne } from "./analysis.js";
import {
    BENCHMARK_LEVELS,
    BENCHMARK_METRICS,
    COST_MODEL,
    STAGE_ORDER,
    TELEMETRY_CONFIG
} from "./config.js";
import {
    answerCard,
    bytes,
    clock,
    duration,
    esc,
    int,
    legend,
    lineChart,
    money,
    ms,
    num,
    page,
    pct,
    seconds,
    sectionHead,
    specStrip,
    stackedBar,
    STAGE_COLORS,
    STAGE_LABELS,
    table
} from "./theme.js";

const BREAKDOWN_KEYS = [...STAGE_ORDER, "overhead"];

const symbol = COST_MODEL.currencySymbol;

const safeName = (value) =>
    String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

const TBD = `<span class="quiet">TBD</span>`;

const levelLabel = (level) => (level === 1 ? "Single call" : `${level} calls`);

const BENCHMARK_ROWS = [
    {
        label: "CPU utilization",
        render: (level) => pct(level.cpuUtilizationPct),
        note: (level) => `peak ${pct(level.peakCpuUtilizationPct)}`
    },
    {
        label: "RAM consumption",
        render: (level) => bytes(level.stackRssBytes),
        note: (level) => `whole machine ${pct(level.memoryUtilizationPct)} full`
    },
    {
        label: "GPU utilization",
        render: (level) => level.gpu?.present ? pct(level.gpuUtilizationPct) : `<span class="quiet">no GPU</span>`
    },
    { label: "p50 turn latency", render: (level) => ms(level.p50LatencyMs) },
    { label: "p95 turn latency", render: (level) => ms(level.p95LatencyMs) },
    {
        label: "Successful calls/min",
        render: (level) => num(level.successfulCallsPerMinute, 2),
        note: (level) => `${int(level.completedCalls)} of ${int(level.calls)} calls`
    },
    {
        label: "Error rate",
        render: (level) => level.errorRatePct > 0
            ? `<span class="fail">${pct(level.errorRatePct)}</span>`
            : `<span class="good">0%</span>`
    },
    {
        label: "Cost per completed call",
        render: (level) => money(level.costPerCompletedCall, symbol)
    }
];

function benchmarkSection(bench) {
    const rows = BENCHMARK_ROWS.map((row) => [
        `<strong>${esc(row.label)}</strong>`,
        ...bench.levels.map((level) => {
            if (!level.tested) return TBD;

            const note = row.note?.(level);

            return `${row.render(level)}${note ? `<br><span class="quiet">${note}</span>` : ""}`;
        })
    ]);

    rows.push([
        `<span class="quiet">Meets targets</span>`,
        ...bench.levels.map((level) =>
            !level.tested
                ? TBD
                : level.meetsTargets
                    ? `<span class="pill pill-ok">pass</span>`
                    : `<span class="pill pill-warn">fail</span>`
        )
    ]);

    const headline = bench.maxSupportedConcurrency != null
        ? `<strong>${int(bench.maxSupportedConcurrency)} concurrent call${bench.maxSupportedConcurrency === 1 ? "" : "s"}</strong>
           is the highest level tested that met every latency, reliability and saturation target.
           ${bench.ceilingNotReached
            ? "Every tested level passed, so the real ceiling is above what has been run so far."
            : ""}`
        : bench.tested > 0
            ? `<strong>No tested level met every target yet.</strong>`
            : `<strong>Nothing benchmarked yet.</strong> Columns fill in as calls run at each level.`;

    return `<section id="benchmark" class="section">
    ${sectionHead({
        eyebrow: "Benchmark",
        title: "The same metrics, measured at each concurrency level.",
        lead: `${headline}
            A call is attributed to the level equal to the peak number of calls in flight while it
            was live, so running four calls together fills the <em>4 calls</em> column. Untested
            levels stay TBD rather than being interpolated from a single call.`
    })}
    ${table({
        columns: ["Metric", ...bench.levels.map((level) => levelLabel(level.level))],
        rows,
        align: ["", ...bench.levels.map(() => "r")]
    })}
    <div class="legend">
      <span class="legend-item">${bench.tested} of ${bench.levels.length} levels tested${bench.untracked > 0
            ? `. ${int(bench.untracked)} call${bench.untracked === 1 ? "" : "s"} ran at a concurrency with no column and are excluded.`
            : "."}</span>
    </div>
    <div style="height:28px"></div>
    <div class="answers">
      <article class="answer">
        <header><span class="answer-num">M</span><h3>Why each row is here</h3></header>
        <dl class="kv">${BENCHMARK_METRICS.map(([metric, why]) =>
            `<div><dt>${esc(metric)}</dt><dd>${esc(why)}</dd></div>`).join("")}</dl>
      </article>
      <article class="answer">
        <header><span class="answer-num">T</span><h3>Targets a level must meet</h3></header>
        <dl class="kv">
          <div><dt>p50 turn latency</dt><dd>&le; ${int(bench.targets.p50LatencyMs)} ms</dd></div>
          <div><dt>p95 turn latency</dt><dd>&le; ${int(bench.targets.p95LatencyMs)} ms</dd></div>
          <div><dt>Queue wait p95</dt><dd>&le; ${int(bench.targets.maxQueueWaitP95Ms)} ms</dd></div>
          <div><dt>Error rate</dt><dd>&le; ${num(bench.targets.maxErrorRatePct, 0)}%</dd></div>
          <div><dt>Completion rate</dt><dd>&ge; ${num(bench.targets.minCompletionRatePct, 0)}%</dd></div>
          <div><dt>CPU utilization</dt><dd>&le; ${num(bench.targets.maxCpuUtilizationPct, 0)}%</dd></div>
          <div><dt>Memory utilization</dt><dd>&le; ${num(bench.targets.maxMemoryUtilizationPct, 0)}%</dd></div>
        </dl>
        <p class="method"><span>Definition</span>
          Maximum supported concurrency is the highest tested load that meets the latency and
          reliability targets &mdash; not simply the highest number of calls that manages to
          connect.</p>
      </article>
    </div>
  </section>`;
}

function computeCard(compute, host) {
    if (!compute.available) {
        return answerCard({
            number: "01",
            question: "How much compute does one voice interaction consume?",
            headline: "&mdash;",
            note: "No completed turns recorded yet."
        });
    }

    return answerCard({
        number: "01",
        question: "How much compute does one voice interaction consume?",
        headline: num(compute.cpuSecondsPerTurn.mean, 2),
        unit: "CPU-seconds per turn",
        note: `One turn &mdash; the caller speaks, the stack answers &mdash; costs
            <strong>${num(compute.cpuSecondsPerTurn.mean, 2)} CPU-seconds</strong>
            (p95 ${num(compute.cpuSecondsPerTurn.p95, 2)}), spread over
            ${num(compute.coresBusyDuringTurn.mean, 2)} cores for ${ms(compute.e2eLatencyMs.mean)}.
            That is ${pct(compute.machineSharePct)} of this ${host.cores}-core machine, held briefly.`,
        rows: [
            ["Audio per turn", seconds(compute.audioSecondsPerTurn, 1)],
            ["Real-time factor", compute.realtimeFactor != null ? `${num(compute.realtimeFactor, 2)}x` : "&mdash;"],
            ["Output tokens", int(compute.completionTokensPerTurn.mean)]
        ],
        method: `Whole-machine CPU time from <span class="mono">os.cpus()</span> deltas across the
            turn, net of the host's measured idle baseline. Whole-machine rather than per-process,
            because ASR and the LLM run outside this process.`
    });
}

function concurrencyCard(concurrency) {
    if (!concurrency.available) {
        return answerCard({
            number: "02",
            question: "How many simultaneous calls can one machine handle?",
            headline: "&mdash;",
            note: "No completed turns recorded yet."
        });
    }

    const benchmarked = concurrency.basis === "benchmark";

    return answerCard({
        number: "02",
        question: "How many simultaneous calls can one machine handle?",
        headline: int(concurrency.concurrentCalls),
        unit: benchmarked ? "concurrent calls, benchmarked" : "concurrent calls, modelled",
        note: benchmarked
            ? `<strong>${int(concurrency.measured)} calls</strong> is the highest benchmarked level
               that met every target. The CPU model alone would have predicted
               ${int(concurrency.modelled)}.`
            : `One active call holds <strong>${num(concurrency.coresPerCall, 2)} cores</strong>
               continuously, so ${concurrency.cores} cores at a
               ${pct(COST_MODEL.utilizationTarget * 100, 0)} ceiling gives
               <strong>${int(concurrency.modelled)} calls</strong>. This is a model &mdash;
               run calls at each level to replace it with a measurement.`,
        rows: [
            ["Benchmarked", concurrency.measured != null ? `${int(concurrency.measured)} calls` : TBD],
            ["Model prediction", `${int(concurrency.modelled)} calls`],
            ["Cores per call", num(concurrency.coresPerCall, 3)],
            ["CPU limit", concurrency.cpuBound != null ? `${int(concurrency.cpuBound)} calls` : "&mdash;"],
            ["Memory limit", concurrency.ramBound != null ? `${int(concurrency.ramBound)} calls` : "&mdash;"],
            ["Binding constraint", esc(concurrency.bottleneck)]
        ],
        method: `Cores per call is CPU-seconds per turn divided by the turn cycle
            (caller speech + wait + reply playback), which is the wall time one call genuinely
            occupies, divided into the usable cores. The memory limit counts only per-call growth,
            since the model weights load once and are shared.`
    });
}

function costCard(cost) {
    if (!cost.available || !cost.perCompletedCall) {
        return answerCard({
            number: "03",
            question: "What does one successfully completed call cost?",
            headline: TBD,
            note: `No call has completed a business action yet, so there is nothing to divide the
                box cost by. The box itself runs at ${money(cost.monthlyBoxCost ?? 0, symbol)} a month.`
        });
    }

    return answerCard({
        number: "03",
        question: "What does one successfully completed call cost?",
        headline: money(cost.perCompletedCall, symbol),
        unit: `per completed call, ${cost.currency}`,
        note: `A ${num(cost.callMinutes, 1)}-minute call costs
            <strong>${money(cost.compute, symbol)} of compute</strong> plus
            <strong>${money(cost.telephony, symbol)} of telephony</strong>.
            The box delivers ${num(cost.successfulCallsPerHour, 1)} successful calls an hour at
            ${money(cost.boxCostPerHour, symbol)} an hour, and the telephony bill for calls that
            did not complete lands on the ones that did.`,
        rows: [
            ["Compute", money(cost.compute, symbol)],
            ["Telephony", money(cost.telephony, symbol)],
            ["Managed vendor would charge", money(cost.managedEquivalent, symbol)],
            ["Cheaper by", cost.savingsVsManagedPct != null ? pct(cost.savingsVsManagedPct, 1) : "&mdash;"],
            ["Whole box per month", money(cost.monthlyBoxCost, symbol)],
            ["Basis", cost.basis === "benchmark" ? "benchmarked throughput" : "modelled throughput"]
        ],
        method: `Box cost per hour is ${money(cost.capexPerHour, symbol)} of amortised hardware plus
            ${money(cost.powerPerHour, symbol)} of electricity, divided by the successful calls per
            hour actually observed.`
    });
}

function hardwareCard(hardware) {
    if (!hardware.available) {
        return answerCard({
            number: "04",
            question: "What hardware does a merchant need to self-host Tokenly?",
            headline: bytes(hardware.modelBytes),
            unit: "of model weights",
            note: "Not enough call data to size CPU and memory yet."
        });
    }

    const minimum = hardware.minimum;

    return answerCard({
        number: "04",
        question: "What hardware does a merchant need to self-host Tokenly?",
        headline: `${int(minimum.cores)} cores / ${num(minimum.ramGiB, 0)} GiB`,
        unit: "for one call at a time",
        note: `A single-line shop needs <strong>${int(minimum.cores)} CPU cores,
            ${num(minimum.ramGiB, 0)} GiB of RAM and ${int(hardware.diskGiB)} GiB of SSD</strong>
            &mdash; an entry-level mini PC. No GPU: every model in the pipeline is CPU-only.
            Measured on a ${esc(hardware.measuredOn.cpuModel)}.`,
        rows: [
            ...hardware.tiers.map((tier) => [
                levelLabel(tier.concurrentCalls),
                `${int(tier.cores)} cores &middot; ${num(tier.ramGiB, 0)} GiB`
            ]),
            ["Model weights on disk", bytes(hardware.modelBytes)],
            ["Disk with headroom", `${int(hardware.diskGiB)} GiB`],
            ["GPU", hardware.gpu?.present ? esc(hardware.gpu.devices[0].name) : "Not required"]
        ],
        method: `Cores scale from the measured ${num(hardware.coresPerCall, 3)} cores per call over
            the ${pct(COST_MODEL.utilizationTarget * 100, 0)} utilisation ceiling. Memory is the
            ${hardware.baseRamMeasured ? "measured" : "estimated"} footprint of the loaded stack
            (${bytes(hardware.baseRamBytes)}) plus ${bytes(hardware.ramPerCallBytes)} per call.`
    });
}

function answersSection(analysis) {
    return `<section id="answers" class="section">
    ${sectionHead({
        eyebrow: "Overview",
        title: "Four questions, answered from measurements.",
        lead: `Derived from the raw spans and resource windows behind this page. The assumptions
            that turn CPU-seconds into rupees live in
            <span class="mono">src/telemetry/config.js</span> and are listed at the bottom.`
    })}
    <div class="answers">
      ${computeCard(analysis.answers.compute, analysis.host)}
      ${concurrencyCard(analysis.answers.concurrency)}
      ${costCard(analysis.answers.cost)}
      ${hardwareCard(analysis.answers.hardware)}
    </div>
  </section>`;
}

function inferenceSection(inference) {
    const rows = inference.stages.map((stage) => [
        `<strong>${STAGE_LABELS[stage.stage] ?? stage.stage}</strong>`,
        int(stage.calls),
        ms(stage.latencyMs.p50),
        ms(stage.latencyMs.p95),
        ms(stage.latencyMs.max),
        stage.tokensPerSecond != null ? `${num(stage.tokensPerSecond, 1)} tok/s` : "&mdash;",
        stage.realtimeFactor != null ? `${num(stage.realtimeFactor, 2)}x` : "&mdash;",
        stage.failures > 0
            ? `<span class="fail">${pct(stage.errorRatePct)}</span>`
            : `<span class="good">0%</span>`
    ]);

    if (inference.vad) {
        rows.push([
            `<strong>${STAGE_LABELS.vad}</strong>`,
            int(inference.vad.count),
            "&mdash;",
            "&mdash;",
            ms(inference.vad.maxMs),
            "&mdash;",
            "&mdash;",
            `<span class="good">0%</span>`
        ]);
    }

    return `<section id="inference" class="section">
    ${sectionHead({
        eyebrow: "Level 1 · Per inference",
        title: "One ASR, LLM, tool or TTS execution.",
        lead: `The narrowest level: a single model run. VAD fires about 31 times a second, so it is
            counted rather than stored one span per frame.`
    })}
    ${table({
        columns: ["Stage", "Runs", "p50", "p95", "Max", "Throughput", "Real-time", "Errors"],
        rows,
        align: ["", "r", "r", "r", "r", "r", "r", "r"]
    })}
  </section>`;
}

function turnBreakdownBar(turn) {
    return stackedBar(
        BREAKDOWN_KEYS.map((key) => ({
            key,
            value: key === "overhead" ? turn.overheadMs : turn.byStage[key] ?? 0
        })),
        turn.e2eLatencyMs ?? 1
    );
}

function turnSection(turnStats) {
    if (turnStats.empty) {
        return `<section id="turns" class="section">
      ${sectionHead({
            eyebrow: "Level 2 · Per turn",
            title: "One customer utterance and the reply to it."
        })}
      <p class="empty">No completed turns recorded yet.</p>
    </section>`;
    }

    const rows = STAGE_ORDER.map((stage) => [
        `<span class="legend-item"><i style="background:${STAGE_COLORS[stage]}"></i>${STAGE_LABELS[stage]}</span>`,
        ms(turnStats.stageLatency[stage].mean),
        ms(turnStats.stageLatency[stage].p95),
        pct(turnStats.e2eLatencyMs.mean > 0
            ? (turnStats.stageLatency[stage].mean / turnStats.e2eLatencyMs.mean) * 100
            : 0)
    ]);

    rows.push([
        `<span class="legend-item"><i style="background:${STAGE_COLORS.overhead}"></i>${STAGE_LABELS.overhead}</span>`,
        ms(turnStats.overheadMs.mean),
        ms(turnStats.overheadMs.p95),
        pct(turnStats.e2eLatencyMs.mean > 0
            ? (turnStats.overheadMs.mean / turnStats.e2eLatencyMs.mean) * 100
            : 0)
    ]);

    return `<section id="turns" class="section">
    ${sectionHead({
        eyebrow: "Level 2 · Per turn",
        title: "One customer utterance and the reply to it.",
        lead: `Latency is measured from the endpointer declaring the caller finished speaking to
            reply audio being ready. That is the silence the caller actually hears.`
    })}
    ${table({
        columns: ["Stage", "Mean", "p95", "Share of turn"],
        rows,
        align: ["", "r", "r", "r"]
    })}
  </section>`;
}

function callSection(callStats) {
    if (callStats.empty) {
        return `<section id="calls" class="section">
      ${sectionHead({ eyebrow: "Level 3 · Per call", title: "The whole conversation." })}
      <p class="empty">No completed calls recorded yet.</p>
    </section>`;
    }

    const rows = callStats.calls
        .slice()
        .reverse()
        .map((call) => [
            `<a class="link mono" href="calls/${esc(safeName(call.callId))}/index.html">${esc(call.callId)}</a>`,
            esc(clock(call.startedAt)),
            int(call.peakConcurrency),
            duration(call.durationMs),
            int(call.turnCount),
            ms(call.p95LatencyMs),
            seconds(call.cpuSeconds, 1),
            call.completed
                ? `<span class="pill pill-ok">completed</span>`
                : `<span class="pill">no action</span>`,
            call.errors.length > 0
                ? `<span class="fail">${int(call.errors.length)}</span>`
                : `<span class="good">0</span>`
        ]);

    return `<section id="calls" class="section">
    ${sectionHead({
        eyebrow: "Level 3 · Per call",
        title: "The whole conversation, turns and business actions included.",
        lead: `A call counts as completed when a business action actually succeeded &mdash; an
            invoice created, not merely quoted. Open any call for its own report.`
    })}
    ${table({
        columns: ["Call", "Started", "In flight", "Duration", "Turns", "p95 turn", "CPU", "Outcome", "Errors"],
        rows,
        align: ["", "", "r", "r", "r", "r", "r", "", "r"]
    })}
  </section>`;
}

function assumptionsSection(analysis) {
    const { host, baseline } = analysis;
    const hardware = analysis.answers.hardware;

    const hostRows = [
        ["CPU", esc(host.cpuModel)],
        ["Cores", int(host.cores)],
        ["Total RAM", bytes(host.systemTotalBytes)],
        ["GPU", host.gpu?.present ? esc(host.gpu.devices[0].name) : "none; CPU-only pipeline"],
        ["Platform", esc(host.platform)],
        ["Idle load at baseline", baseline
            ? `${pct(baseline.idleUtilizationPct)} (${num(baseline.idleCoresBusy, 2)} cores)`
            : "not measured"],
        ["Pipeline RSS at baseline", baseline
            ? `${bytes(baseline.stackRssBytes)}${baseline.stackComplete ? "" : " (node only)"}`
            : "not measured"]
    ];

    const costRows = [
        ["Hardware capital cost", money(COST_MODEL.hardwareCapex, symbol)],
        ["Written down over", `${COST_MODEL.hardwareLifetimeMonths} months`],
        ["Power under load", `${COST_MODEL.machineWatts} W`],
        ["Electricity tariff", `${money(COST_MODEL.electricityPerKwh, symbol)} / kWh`],
        ["Telephony", `${money(COST_MODEL.telephonyPerMinute, symbol)} / minute`],
        ["Managed vendor", `${money(COST_MODEL.managedVoiceAiPerMinute, symbol)} / minute`],
        ["CPU ceiling", pct(COST_MODEL.utilizationTarget * 100, 0)],
        ["Memory ceiling", pct(COST_MODEL.memoryTarget * 100, 0)]
    ];

    const kv = (rows) =>
        `<dl class="kv">${rows.map(([key, value]) =>
            `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("")}</dl>`;

    return `<section id="assumptions" class="section">
    ${sectionHead({
        eyebrow: "Method",
        title: "What was measured, and what was assumed.",
        lead: `Timings, CPU time, memory and tokens are measured. Prices and the utilisation
            ceiling are assumptions, held in one file so the cost answers can be re-derived for
            any merchant's electricity bill or telephony contract.`
    })}
    <div class="answers">
      <article class="answer">
        <header><span class="answer-num">H</span><h3>Host it was measured on</h3></header>
        ${kv(hostRows)}
      </article>
      <article class="answer">
        <header><span class="answer-num">${esc(symbol)}</span><h3>Costing assumptions</h3></header>
        ${kv(costRows)}
      </article>
    </div>
    <div style="height:16px"></div>
    ${table({
        columns: ["Model", "Stage", "Size", "On disk"],
        rows: (hardware.models ?? []).map((model) => [
            esc(model.name),
            STAGE_LABELS[model.stage] ?? model.stage,
            bytes(model.bytes),
            model.measured ? `<span class="good">measured</span>` : `<span class="quiet">declared</span>`
        ]),
        align: ["", "", "r", ""]
    })}
    <div style="height:16px"></div>
    <ul class="notes">
      <li><strong>No GPU anywhere in the pipeline</strong>Every model runs on CPU: ONNX Runtime for
        VAD and TTS, llama.cpp and nemo-speech.cpp for the LLM and ASR.</li>
      <li><strong>Why whole-machine CPU</strong>ASR runs in nemo-speech.cpp and the LLM in
        llama-server, both separate processes. This process's own
        <span class="mono">process.cpuUsage()</span> would miss almost all of the inference cost,
        so CPU is read from <span class="mono">os.cpus()</span> net of a measured idle baseline.</li>
      <li><strong>Why pipeline RSS, not machine memory</strong>Whole-machine memory counts whatever
        else the host runs. Memory is read from <span class="mono">/proc</span> for node,
        llama-server and nemo-speech, so sizing reflects the stack alone.</li>
    </ul>
  </section>`;
}

function hostLine(host) {
    return `${host.cpuModel} · ${host.cores} cores · ${bytes(host.systemTotalBytes)}`;
}

function overviewHtml(analysis) {
    const { compute, concurrency, cost } = analysis.answers;
    const bench = analysis.benchmark;

    const body = `  <section class="hero">
    <h1>What a voice call <span class="accent">actually costs</span> to run.</h1>
    <p class="lead">
      Kural instruments every stage of the pipeline &mdash; voice activity detection, speech
      recognition, the language model, tool calls and speech synthesis &mdash; at three levels:
      per inference, per turn and per call. This page is regenerated after every call.
    </p>
    <div class="meta">
      <span class="pill">${int(analysis.call.empty ? 0 : analysis.call.count)} calls</span>
      <span class="pill">${int(analysis.turn.empty ? 0 : analysis.turn.count)} turns</span>
      <span class="pill">peak ${int(analysis.peakConcurrency ?? 1)} in flight</span>
      <span class="pill ${analysis.inference.errorRatePct > 0 ? "pill-warn" : "pill-ok"}">
        ${pct(analysis.inference.errorRatePct)} error rate
      </span>
      ${analysis.activeCalls > 0
            ? `<span class="pill pill-warn"><span class="live-dot"></span>${int(analysis.activeCalls)} live</span>`
            : ""}
      <span>${esc(hostLine(analysis.host))}</span>
    </div>
  </section>

  ${specStrip([
        {
            value: compute.available ? seconds(compute.cpuSecondsPerTurn.mean) : TBD,
            label: "CPU-seconds per turn"
        },
        {
            value: analysis.turn.empty ? TBD : ms(analysis.turn.e2eLatencyMs.p95),
            label: "p95 turn latency"
        },
        {
            value: bench.maxSupportedConcurrency != null
                ? int(bench.maxSupportedConcurrency)
                : concurrency.available ? `~${int(concurrency.modelled)}` : TBD,
            label: bench.maxSupportedConcurrency != null
                ? "Max supported concurrency"
                : "Concurrency, modelled"
        },
        {
            value: cost.available && cost.perCompletedCall ? money(cost.perCompletedCall, symbol) : TBD,
            label: "Cost per completed call"
        }
    ])}

  ${benchmarkSection(bench)}
  ${answersSection(analysis)}
  ${inferenceSection(analysis.inference)}
  ${turnSection(analysis.turn)}
  ${callSection(analysis.call)}
  ${assumptionsSection(analysis)}`;

    return page({
        title: "Kural telemetry",
        description: "Measured compute, latency, concurrency and cost for the Kural voice pipeline.",
        navLinks: [
            { href: "#benchmark", label: "Benchmark" },
            { href: "#answers", label: "Overview" },
            { href: "#inference", label: "Per inference" },
            { href: "#turns", label: "Per turn" },
            { href: "#calls", label: "Per call" },
            { href: "#assumptions", label: "Method" }
        ],
        body
    });
}

function turnCards(detail) {
    if (detail.turns.length === 0) {
        return `<p class="empty">This call ended before a full turn completed.</p>`;
    }

    const cards = detail.turns.map((turn) => {
        const chips = STAGE_ORDER
            .filter((stage) => turn.byStage[stage] > 0)
            .map((stage) => `<span class="legend-item"><i style="background:${STAGE_COLORS[stage]}"></i>${STAGE_LABELS[stage]} ${ms(turn.byStage[stage])}</span>`)
            .join("");

        const tools = turn.toolCalls.length > 0
            ? `<div class="turn-head" style="margin-top:14px">${turn.toolCalls.map((tool) =>
                `<span class="pill ${tool.ok ? "pill-ok" : "pill-warn"}">${esc(tool.name)} ${ms(tool.durationMs)}</span>`
            ).join("")}</div>`
            : "";

        return `<article class="turn">
      <div class="turn-head">
        <span class="turn-index">TURN ${int(turn.index + 1)}</span>
        <span>+${ms(turn.offsetMs)}</span>
        <span><strong>${ms(turn.e2eLatencyMs)}</strong> end to end</span>
        <span>${num(turn.cpuSeconds, 2)} CPU-s</span>
        <span>${int(turn.tokens.completion)} out / ${int(turn.tokens.prompt)} in tokens</span>
        ${turn.ok ? "" : `<span class="pill pill-warn">${int(turn.errorCount)} error${turn.errorCount === 1 ? "" : "s"}</span>`}
      </div>
      <div class="turn-bar">${turnBreakdownBar(turn)}</div>
      <div class="legend">${chips}<span class="legend-item"><i style="background:${STAGE_COLORS.overhead}"></i>Overhead ${ms(turn.overheadMs)}</span></div>
      ${tools}
      <div class="speech">
        <div><span class="who">Caller</span><p class="said">${turn.transcript ? esc(turn.transcript) : `<span class="quiet">not transcribed</span>`}</p></div>
        <div><span class="who">Yuga</span><p class="said muted">${turn.response ? esc(turn.response) : `<span class="quiet">no reply</span>`}</p></div>
      </div>
    </article>`;
    });

    return `<div class="turns">${cards.join("\n")}</div>
    ${legend(BREAKDOWN_KEYS)}`;
}

function resourceChart(detail) {
    const samples = detail.samples.filter((sample) => sample.utilizationPct != null);

    if (samples.length < 2) {
        return `<p class="empty">The call was too short to plot a resource timeline.</p>`;
    }

    return lineChart({
        series: [
            {
                name: "Whole-machine CPU %",
                color: STAGE_COLORS.asr,
                points: samples.map((sample) => ({ x: sample.offsetMs, y: sample.utilizationPct }))
            },
            {
                name: "Machine memory in use %",
                color: STAGE_COLORS.llm,
                points: samples.map((sample) => ({ x: sample.offsetMs, y: sample.memoryUtilizationPct }))
            },
            {
                name: "Pipeline RSS, % of total RAM",
                color: STAGE_COLORS.tts,
                points: samples.map((sample) => ({
                    x: sample.offsetMs,
                    y: (sample.stackRssBytes / sample.systemTotalBytes) * 100
                }))
            }
        ],
        yLabel: "CPU and memory over the call",
        yMax: 100
    });
}

function callHtml(analysis) {
    const detail = analysis.detail;

    const level = {
        tested: true,
        calls: 1,
        completedCalls: detail.completed ? 1 : 0,
        cpuUtilizationPct: detail.cpuUtilizationPct.mean,
        peakCpuUtilizationPct: detail.peakCpuUtilizationPct,
        stackRssBytes: detail.peakStackRssBytes,
        memoryUtilizationPct: detail.memoryUtilizationPct.max,
        gpu: detail.gpu,
        gpuUtilizationPct: detail.gpu?.present && detail.gpu.totalBytes > 0
            ? (detail.gpu.usedBytes / detail.gpu.totalBytes) * 100
            : null,
        p50LatencyMs: detail.p50LatencyMs,
        p95LatencyMs: detail.p95LatencyMs,
        successfulCallsPerMinute: detail.successfulCallsPerMinute,
        errorRatePct: detail.errorRatePct,
        costPerCompletedCall: detail.costPerCompletedCall
    };

    const rows = BENCHMARK_ROWS.map((row) => [
        `<strong>${esc(row.label)}</strong>`,
        row.render(level),
        row.note ? `<span class="quiet">${row.note(level)}</span>` : ""
    ]);

    const body = `  <section class="hero">
    <h1>Call <span class="accent">${esc(detail.callId)}</span></h1>
    <p class="lead">
      ${duration(detail.durationMs)} on the line, ${int(detail.turnCount)} turns,
      ${num(detail.cpuSeconds, 2)} CPU-seconds of whole-machine compute.
      ${detail.completed
            ? "A business action completed successfully on this call."
            : "No business action completed on this call."}
    </p>
    <div class="meta">
      <span class="pill">${esc(clock(detail.startedAt))}</span>
      ${detail.metadata?.from ? `<span class="pill">from ${esc(detail.metadata.from)}</span>` : ""}
      ${detail.metadata?.customer
            ? `<span class="pill pill-ok">${esc(detail.metadata.customer)}</span>`
            : `<span class="pill">unverified caller</span>`}
      <span class="pill">peak ${int(detail.peakConcurrency)} in flight</span>
      <span class="pill ${detail.completed ? "pill-ok" : ""}">${detail.completed ? "completed" : "no action"}</span>
      <a class="link" href="../../index.html">&larr; All calls</a>
    </div>
  </section>

  <section id="metrics" class="section">
    ${sectionHead({
        eyebrow: "Benchmark",
        title: "This call, measured.",
        lead: `The same rows as the benchmark table on the overview, for this call alone. It ran
            with a peak of ${int(detail.peakConcurrency)} call${detail.peakConcurrency === 1 ? "" : "s"}
            in flight, so it populates the
            <em>${esc(levelLabel(detail.peakConcurrency))}</em> column there.`
    })}
    ${table({
        columns: ["Metric", "Value", ""],
        rows,
        align: ["", "r", ""]
    })}
  </section>

  <section id="turns" class="section">
    ${sectionHead({
        eyebrow: "Turns",
        title: "Where the latency went.",
        lead: `Each bar spans the caller's silence: from the endpointer declaring the utterance
            finished to reply audio being ready. Overhead is framing, buffering and orchestration
            outside any model.`
    })}
    ${turnCards(detail)}
  </section>

  <section id="resources" class="section">
    ${sectionHead({
        eyebrow: "Resources",
        title: "CPU and memory across the call.",
        lead: `Sampled every ${TELEMETRY_CONFIG.sampleIntervalMs} ms. CPU is the whole machine, so
            it includes llama-server and nemo-speech alongside this process.`
    })}
    ${resourceChart(detail)}
  </section>`;

    return page({
        title: `Call ${detail.callId} — Kural telemetry`,
        description: `Telemetry for call ${detail.callId}: ${detail.turnCount} turns, ${num(detail.cpuSeconds, 2)} CPU-seconds.`,
        navLinks: [
            { href: "#metrics", label: "Benchmark" },
            { href: "#turns", label: "Turns" },
            { href: "#resources", label: "Resources" },
            { href: "../../index.html", label: "All calls" }
        ],
        body
    });
}

const root = TELEMETRY_CONFIG.outputDir;

async function writeFiles(dir, files) {
    await fs.mkdir(dir, { recursive: true });

    await Promise.all(
        Object.entries(files).map(([name, content]) =>
            fs.writeFile(path.join(dir, name), content, "utf8")
        )
    );
}

export async function writeCallReport(trace) {
    const dir = path.join(root, "calls", safeName(trace.callId));

    await writeFiles(dir, {
        "index.html": callHtml(analyzeOne(trace)),
        "raw.json": JSON.stringify(trace, null, 2)
    });

    console.log(`[TELEMETRY] Report written: ${path.join(dir, "index.html")}`);

    return dir;
}

export async function writeOverviewReport(aggregate) {
    const analysis = analyze(aggregate);

    await writeFiles(root, {
        "index.html": overviewHtml(analysis),
        "benchmark.json": JSON.stringify(
            { benchmark: analysis.benchmark, answers: analysis.answers },
            null,
            2
        )
    });

    console.log(`[TELEMETRY] Overview written: ${path.join(root, "index.html")}`);

    return root;
}
