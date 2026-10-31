export const STAGE_COLORS = {
    asr: "#c84141",
    llm: "#1f7a4a",
    tool: "#9a6b1f",
    tts: "#3b5bbf",
    vad: "#7a4aa1",
    overhead: "#9298a8"
};

export const STAGE_LABELS = {
    asr: "ASR",
    llm: "LLM",
    tool: "Tools",
    tts: "TTS",
    vad: "VAD",
    overhead: "Overhead"
};

const DASH = "&mdash;";

export const esc = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

export function num(value, digits = 2) {
    if (!Number.isFinite(value)) return DASH;
    return value.toLocaleString("en-IN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

export function int(value) {
    if (!Number.isFinite(value)) return DASH;
    return Math.round(value).toLocaleString("en-IN");
}

export function ms(value) {
    if (!Number.isFinite(value)) return DASH;
    if (value >= 10000) return `${num(value / 1000, 1)} s`;
    if (value >= 1000) return `${num(value / 1000, 2)} s`;
    if (value >= 10) return `${int(value)} ms`;
    return `${num(value, 1)} ms`;
}

export function seconds(value, digits = 2) {
    if (!Number.isFinite(value)) return DASH;
    return `${num(value, digits)} s`;
}

export function bytes(value) {
    if (!Number.isFinite(value)) return DASH;

    const units = [["GiB", 1024 ** 3], ["MiB", 1024 ** 2], ["KiB", 1024]];

    for (const [unit, size] of units) {
        if (Math.abs(value) >= size) return `${num(value / size, value / size >= 100 ? 0 : 2)} ${unit}`;
    }

    return `${int(value)} B`;
}

export function pct(value, digits = 1) {
    if (!Number.isFinite(value)) return DASH;
    return `${num(value, digits)}%`;
}

export function money(value, symbol = "₹") {
    if (!Number.isFinite(value)) return DASH;
    if (value === 0) return `${symbol}0`;
    if (Math.abs(value) < 0.01) return `${symbol}${num(value, 5)}`;
    if (Math.abs(value) < 1) return `${symbol}${num(value, 4)}`;
    return `${symbol}${num(value, 2)}`;
}

export function moneyAmount(value, symbol = "₹") {
    if (value == null || value === "") return DASH;
    return `${symbol}${esc(value)}`;
}

export function costStatusPill(status) {
    if (!status) return `<span class="pill">unknown</span>`;
    if (status === "actual") return `<span class="pill pill-ok">actual</span>`;
    if (status === "estimated") return `<span class="pill pill-warn">estimated</span>`;
    if (status === "pending") return `<span class="pill pill-warn">pending</span>`;
    return `<span class="pill">${esc(status.replaceAll("_", " "))}</span>`;
}

export function clock(timestamp) {
    if (!Number.isFinite(timestamp)) return DASH;
    return new Date(timestamp).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "medium"
    });
}

export function duration(msValue) {
    if (!Number.isFinite(msValue)) return DASH;

    const total = Math.round(msValue / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;

    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function specStrip(items) {
    return `<section class="specs reveal">
    ${items.map((item) => `<div class="spec">
      <span class="spec-value">${item.value}</span>
      <span class="spec-label">${esc(item.label)}</span>
    </div>`).join("\n    ")}
  </section>`;
}

export function sectionHead({ eyebrow, title, lead }) {
    return `<div class="section-head reveal">
      <span class="eyebrow">${esc(eyebrow)}</span>
      <h2>${esc(title)}</h2>
      ${lead ? `<p>${lead}</p>` : ""}
    </div>`;
}

export function table({ columns, rows, align = [] }) {
    if (rows.length === 0) {
        return `<p class="empty">No data recorded yet.</p>`;
    }

    const head = columns
        .map((column, index) => `<th${align[index] === "r" ? ' class="r"' : ""}>${esc(column)}</th>`)
        .join("");

    const body = rows
        .map((row) => `<tr>${row
            .map((cell, index) => `<td${align[index] === "r" ? ' class="r"' : ""}>${cell}</td>`)
            .join("")}</tr>`)
        .join("\n      ");

    return `<div class="table-wrap reveal">
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>
      ${body}
      </tbody>
    </table>
  </div>`;
}

export function stackedBar(segments, total) {
    const scale = total > 0 ? total : 1;

    const parts = segments
        .filter((segment) => segment.value > 0)
        .map((segment) => `<span class="seg" style="width:${(segment.value / scale) * 100}%;background:${STAGE_COLORS[segment.key] ?? "#9298a8"}" title="${esc(STAGE_LABELS[segment.key] ?? segment.key)}: ${ms(segment.value)}"></span>`)
        .join("");

    return `<div class="bar">${parts}</div>`;
}

export function legend(keys) {
    return `<div class="legend">${keys.map((key) =>
        `<span class="legend-item"><i style="background:${STAGE_COLORS[key] ?? "#9298a8"}"></i>${esc(STAGE_LABELS[key] ?? key)}</span>`
    ).join("")}</div>`;
}

export function lineChart({ series, width = 900, height = 190, yLabel = "", yMax = null }) {
    const points = series.flatMap((line) => line.points);

    if (points.length < 2) {
        return `<p class="empty">Not enough samples to plot.</p>`;
    }

    const padLeft = 54;
    const padRight = 16;
    const padTop = 14;
    const padBottom = 26;

    const xValues = points.map((point) => point.x);
    const maxX = Math.max(...xValues);
    const minX = Math.min(...xValues);
    const maxY = yMax ?? Math.max(...points.map((point) => point.y), 1);

    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    const sx = (x) => padLeft + (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * plotWidth);
    const sy = (y) => padTop + plotHeight - (y / maxY) * plotHeight;

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const y = padTop + plotHeight - fraction * plotHeight;
        return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="grid-line"/>` +
            `<text x="${padLeft - 8}" y="${y + 4}" class="axis r-anchor">${num(maxY * fraction, maxY >= 10 ? 0 : 1)}</text>`;
    }).join("");

    const paths = series.map((line) => {
        const d = line.points
            .map((point, index) => `${index === 0 ? "M" : "L"}${sx(point.x).toFixed(1)} ${sy(point.y).toFixed(1)}`)
            .join(" ");

        return `<path d="${d}" fill="none" stroke="${line.color}" stroke-width="1.8" stroke-linejoin="round"/>`;
    }).join("");

    const xTicks = [0, 0.5, 1].map((fraction) => {
        const value = minX + (maxX - minX) * fraction;
        const x = sx(value);
        return `<text x="${x}" y="${height - 8}" class="axis mid-anchor">${num(value / 1000, 0)}s</text>`;
    }).join("");

    const seriesLegend = series
        .map((line) => `<span class="legend-item"><i style="background:${line.color}"></i>${esc(line.name)}</span>`)
        .join("");

    return `<div class="chart reveal">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(yLabel)}">
      ${gridLines}
      ${paths}
      ${xTicks}
    </svg>
    <div class="legend">${seriesLegend}</div>
  </div>`;
}

export function answerCard({ number, question, headline, unit, note, rows, method }) {
    return `<article class="answer reveal">
    <header>
      <span class="answer-num">${esc(number)}</span>
      <h3>${esc(question)}</h3>
    </header>
    <p class="answer-headline">${headline}${unit ? `<span class="answer-unit">${esc(unit)}</span>` : ""}</p>
    ${note ? `<p class="answer-note">${note}</p>` : ""}
    ${rows?.length ? `<dl class="kv">${rows.map(([key, value]) =>
        `<div><dt>${esc(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>` : ""}
    ${method ? `<p class="method"><span>How</span>${method}</p>` : ""}
  </article>`;
}

const CSS = `
* { box-sizing: border-box; }

:root {
  --bg: #fafaf9;
  --surface: rgba(255, 255, 255, 0.72);
  --surface-solid: #ffffff;
  --border: rgba(15, 15, 20, 0.08);
  --text: #0c0c0f;
  --muted: #5b6070;
  --faint: #9298a8;
  --accent: #c84141;
  --accent-soft: rgba(200, 65, 65, 0.08);
  --grid: rgba(15, 15, 20, 0.05);
  --shadow: 0 1px 2px rgba(15, 15, 20, 0.04), 0 12px 32px rgba(15, 15, 20, 0.06);
  --radius: 16px;
  color-scheme: light;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; text-decoration: none; }
a.link { color: var(--accent); }
a.link:hover { text-decoration: underline; }

.backdrop { position: fixed; inset: 0; z-index: -1; pointer-events: none; }

.grid {
  position: absolute; inset: 0;
  background-image: radial-gradient(var(--grid) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse at 50% 20%, #000 25%, transparent 70%);
  -webkit-mask-image: radial-gradient(ellipse at 50% 20%, #000 25%, transparent 70%);
}

.nav {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; max-width: 1160px; margin: 0 auto; padding: 20px 32px;
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}

.logo {
  display: flex; align-items: center; gap: 10px;
  font-size: 18px; font-weight: 600; letter-spacing: -0.02em;
}

.logo-mark {
  width: 26px; height: 26px; flex-shrink: 0; border-radius: 8px;
  background: linear-gradient(180deg, #d45454, #c84141);
  box-shadow: 0 4px 14px rgba(200, 65, 65, 0.3);
}

.nav-links { display: flex; gap: 24px; font-size: 14px; color: var(--muted); }
.nav-links a:hover { color: var(--text); }

main { max-width: 1160px; margin: 0 auto; padding: 0 32px 24px; }

.hero { padding: 40px 0 28px; }

h1 {
  margin: 0; font-size: clamp(32px, 4.6vw, 52px);
  line-height: 1.04; letter-spacing: -0.045em; font-weight: 650;
}

.accent {
  background: linear-gradient(120deg, #e17575, #c84141 50%, #853232);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}

.lead { margin: 18px 0 0; max-width: 640px; font-size: 17px; line-height: 1.6; color: var(--muted); }

.meta {
  display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 20px 0 0;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px; color: var(--faint);
}

.pill {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface);
  font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted);
}

.pill-ok { background: rgba(34, 139, 84, 0.1); color: #1f7a4a; border-color: rgba(34, 139, 84, 0.22); }
.pill-warn { background: var(--accent-soft); color: var(--accent); border-color: rgba(200, 65, 65, 0.22); }

.live-dot {
  width: 7px; height: 7px; border-radius: 50%; background: currentColor;
  box-shadow: 0 0 8px currentColor;
}

.specs {
  display: grid; grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); overflow: hidden;
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}

.spec { display: flex; flex-direction: column; gap: 4px; padding: 20px 22px; }
.spec + .spec { border-left: 1px solid var(--border); }

.spec-value {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 21px; font-weight: 500; letter-spacing: -0.02em;
}

.spec-label { font-size: 13px; color: var(--muted); }

.section { padding: 76px 0 0; }
.section-head { max-width: 660px; margin-bottom: 32px; }

.eyebrow {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent);
}

h2 {
  margin: 12px 0 0; font-size: clamp(26px, 3.4vw, 38px);
  line-height: 1.12; letter-spacing: -0.035em; font-weight: 650;
}

.section-head p { margin: 12px 0 0; font-size: 16px; color: var(--muted); line-height: 1.6; }

h3 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }

.answers { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }

.answer {
  display: flex; flex-direction: column;
  padding: 26px 28px 24px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  transition: box-shadow 250ms ease;
}

.answer:hover { box-shadow: var(--shadow); }

.answer header { display: flex; align-items: flex-start; gap: 12px; }

.answer-num {
  display: inline-grid; place-items: center; flex-shrink: 0;
  width: 28px; height: 28px; border-radius: 9px;
  background: var(--surface-solid); border: 1px solid var(--border);
  font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; color: var(--accent);
}

.answer-headline {
  margin: 20px 0 0;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 34px; font-weight: 500; letter-spacing: -0.04em; line-height: 1;
}

.answer-unit { margin-left: 8px; font-size: 14px; color: var(--faint); letter-spacing: 0; }
.answer-note { margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: var(--muted); }

.kv { margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border); display: grid; gap: 9px; }
.kv > div { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.kv dt { margin: 0; font-size: 13px; color: var(--muted); }
.kv dd {
  margin: 0; font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 13px; text-align: right; white-space: nowrap;
}

.method {
  margin: 18px 0 0; padding: 12px 14px; border-radius: 11px;
  background: var(--accent-soft); font-size: 13px; line-height: 1.6; color: var(--muted);
}

.method span {
  display: block; margin-bottom: 4px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent);
}

.table-wrap {
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); overflow-x: auto;
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}

table { width: 100%; border-collapse: collapse; font-size: 13.5px; }

th {
  padding: 13px 16px; text-align: left; white-space: nowrap;
  border-bottom: 1px solid var(--border);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px; font-weight: 500; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--faint);
}

td { padding: 13px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: rgba(200, 65, 65, 0.025); }
td.r, th.r { text-align: right; }

td.mono, .mono {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12.5px; letter-spacing: -0.01em;
}

.quiet { color: var(--muted); }
.fail { color: var(--accent); }
.good { color: #1f7a4a; }

.empty {
  margin: 0; padding: 28px; border: 1px dashed var(--border); border-radius: var(--radius);
  text-align: center; font-size: 14px; color: var(--faint);
}

.bar {
  display: flex; width: 100%; min-width: 120px; height: 9px;
  border-radius: 999px; overflow: hidden; background: rgba(15, 15, 20, 0.05);
}

.bar .seg { display: block; height: 100%; }

.legend {
  display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 14px;
  font-size: 12px; color: var(--muted);
}

.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-item i { width: 9px; height: 9px; border-radius: 3px; flex-shrink: 0; }

.chart {
  padding: 18px 20px 14px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--surface);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}

.chart svg { width: 100%; height: 190px; display: block; }
.grid-line { stroke: var(--border); stroke-width: 1; }
.axis { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10px; fill: var(--faint); }
.r-anchor { text-anchor: end; }
.mid-anchor { text-anchor: middle; }

.turn {
  padding: 20px 22px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}

.turns { display: grid; gap: 12px; }

.turn-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; color: var(--faint);
}

.turn-index { color: var(--accent); }
.turn-bar { margin: 16px 0 0; }

.speech { display: grid; gap: 8px; margin: 16px 0 0; font-size: 14px; line-height: 1.6; }
.speech > div { display: flex; gap: 10px; }

.who {
  flex-shrink: 0; width: 46px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--faint); padding-top: 4px;
}

.said { margin: 0; color: var(--text); }
.said.muted { color: var(--muted); }

.notes { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }

.notes li {
  padding: 18px 20px; border: 1px solid var(--border); border-radius: 13px;
  background: var(--surface); font-size: 14px; line-height: 1.65; color: var(--muted);
}

.notes strong { display: block; margin-bottom: 4px; color: var(--text); font-weight: 600; }

.footer {
  max-width: 1160px; margin: 0 auto; padding: 72px 32px 48px;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 14px; font-size: 13px; color: var(--faint);
  border-top: 1px solid var(--border); margin-top: 72px;
}

@media (max-width: 900px) {
  .answers, .specs { grid-template-columns: 1fr; }
  .spec + .spec { border-left: none; border-top: 1px solid var(--border); }
  .nav-links { display: none; }
  main, .nav, .footer { padding-left: 20px; padding-right: 20px; }
}

@media print {
  .backdrop, .nav-links { display: none; }
  body { background: #fff; }
  .answer, .table-wrap, .chart, .turn { break-inside: avoid; }
}
`;

export function page({ title, description, navLinks = [], body }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="theme-color" content="#fafaf9" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<div class="backdrop" aria-hidden="true"><div class="grid"></div></div>

<header class="nav">
  <a class="logo" href="#top"><span class="logo-mark"></span>Yuga</a>
  <nav class="nav-links">
    ${navLinks.map((link) => `<a href="${esc(link.href)}">${esc(link.label)}</a>`).join("\n    ")}
  </nav>
</header>

<main id="top">
${body}
</main>

<footer class="footer">
  <span>Yuga telemetry &middot; Tokenly</span>
  <span class="mono">Generated ${esc(clock(Date.now()))}</span>
</footer>
</body>
</html>
`;
}
