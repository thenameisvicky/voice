const root = document.documentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.getElementById("year").textContent = new Date().getFullYear();

// Trigger the hero load-in once the first frame has painted.
requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("loaded")));

// ---------- Mobile menu ----------

const menuToggle = document.getElementById("menuToggle");
const mobileMenu = document.getElementById("mobileMenu");

function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

menuToggle.addEventListener("click", () => {
  setMenu(!document.body.classList.contains("menu-open"));
});

mobileMenu.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMenu(false);
});

document.addEventListener("click", (event) => {
  if (!document.body.classList.contains("menu-open")) return;
  if (mobileMenu.contains(event.target) || menuToggle.contains(event.target)) return;
  setMenu(false);
});

window.matchMedia("(min-width: 641px)").addEventListener("change", (event) => {
  if (event.matches) setMenu(false);
});

// ---------- Reveal on scroll ----------

const revealed = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window && !reducedMotion) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );

  revealed.forEach((el, i) => {
    el.style.transitionDelay = `${(i % 5) * 60}ms`;
    observer.observe(el);
  });
} else {
  revealed.forEach((el) => el.classList.add("visible"));
}

// ---------- Animated waveform background ----------

const canvas = document.getElementById("waves");
const ctx = canvas.getContext("2d");
let width = 0;
let height = 0;
let dpr = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const WAVE_RGB = "200, 65, 65";

const waves = [
  { amp: 28, freq: 0.006, speed: 0.6, alpha: 0.24, y: 0.58, width: 2.5, phase: 0 },
  { amp: 20, freq: 0.009, speed: -0.9, alpha: 0.18, y: 0.62, width: 2.25, phase: 2.1 },
  { amp: 38, freq: 0.004, speed: 0.4, alpha: 0.14, y: 0.66, width: 2.5, phase: 4.2 },
  { amp: 24, freq: 0.007, speed: -0.5, alpha: 0.11, y: 0.7, width: 2, phase: 0.8 },
  { amp: 32, freq: 0.005, speed: 0.75, alpha: 0.08, y: 0.75, width: 2, phase: 5.3 },
  { amp: 18, freq: 0.01, speed: -0.6, alpha: 0.06, y: 0.8, width: 1.75, phase: 2.7 },
];

function drawWaves(t) {
  ctx.clearRect(0, 0, width, height);
  // Speech-like envelope: bursts of energy that rise and fall over time.
  const envelope = 0.55 + 0.45 * Math.sin(t * 0.0007) * Math.sin(t * 0.0013);

  waves.forEach((w) => {
    ctx.beginPath();
    const baseY = height * w.y;
    for (let x = 0; x <= width; x += 6) {
      const taper = Math.sin((x / width) * Math.PI);
      const y =
        baseY +
        Math.sin(x * w.freq + t * 0.001 * w.speed + w.phase) *
          w.amp *
          envelope *
          taper +
        Math.sin(x * w.freq * 2.3 + t * 0.0017 * w.speed) * w.amp * 0.3 * taper;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${WAVE_RGB}, ${w.alpha})`;
    ctx.lineWidth = w.width;
    ctx.lineCap = "round";
    ctx.stroke();
  });
}

let rafId = null;

function loop(t) {
  drawWaves(t);
  rafId = requestAnimationFrame(loop);
}

resize();
window.addEventListener("resize", resize);

if (reducedMotion) {
  drawWaves(0);
} else {
  rafId = requestAnimationFrame(loop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      rafId = requestAnimationFrame(loop);
    }
  });
}

// ---------- Probability waveform ----------

// Scrolling bar waveform whose height follows the VAD speech probability.
class ProbabilityWave {
  constructor(canvas, { barWidth = 3, gap = 3, speed = 70 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.step = barWidth + gap;
    this.barWidth = barWidth;
    this.speed = speed;
    this.target = 0;
    this.level = 0;
    this.phase = 0;
    this.shift = 0;
    this.bars = [];
    this.last = 0;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.ceil(this.width / this.step) + 2;
    while (this.bars.length < count) this.bars.unshift(this.makeBar());
    this.bars.splice(0, Math.max(0, this.bars.length - count));
  }

  setProbability(p) {
    this.target = Math.max(0, Math.min(1, p));
  }

  makeBar() {
    // Fast attack, slower release — like the endpointer's hysteresis.
    const k = this.target > this.level ? 0.45 : 0.14;
    this.level += (this.target - this.level) * k;
    this.phase += 0.55 + Math.random() * 0.35;
    const syllable = 0.35 + 0.65 * Math.abs(Math.sin(this.phase)) * (0.7 + Math.random() * 0.3);
    const idle = Math.random() * 0.03;
    return { amp: Math.max(idle, this.level * syllable), p: this.level };
  }

  frame(now) {
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    this.shift += dt * this.speed;
    while (this.shift >= this.step) {
      this.shift -= this.step;
      this.bars.shift();
      this.bars.push(this.makeBar());
    }
    this.draw();
  }

  draw() {
    const { ctx, width, height } = this;
    const mid = height / 2;
    const maxH = height / 2 - 4;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "rgba(15, 15, 20, 0.08)";
    ctx.fillRect(0, mid - 0.5, width, 1);

    const n = this.bars.length;
    for (let i = 0; i < n; i++) {
      const bar = this.bars[i];
      const x = i * this.step - this.shift;
      const h = Math.max(1.5, bar.amp * maxH);
      // Grey when silent, accent red as probability rises; fade older bars.
      const r = Math.round(196 + (200 - 196) * bar.p);
      const g = Math.round(190 + (65 - 190) * bar.p);
      const b = Math.round(190 + (65 - 190) * bar.p);
      const edge = Math.min(1, x / (width * 0.3));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.25 + 0.75 * Math.max(0, edge)})`;
      ctx.beginPath();
      ctx.roundRect(x, mid - h, this.barWidth, h * 2, this.barWidth / 2);
      ctx.fill();
    }
  }
}

// ---------- Live transcript demo ----------

const vad = document.getElementById("vad");
const vadValue = document.getElementById("vadValue");
const demoText = document.getElementById("demoText");
const demoState = document.getElementById("demoState");
const wave = new ProbabilityWave(document.getElementById("vadWave"));

const lines = [
  "What's on my calendar this afternoon?",
  "Summarise the last meeting in two lines.",
  "Remind me to call the team at five.",
  "How long would it take to drive to the airport?",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Simulated VAD output: near zero in silence, high and jittery while speaking.
let speaking = false;
let lastWordAt = 0;

function simulatedProbability(now) {
  if (!speaking) return 0.02 + Math.random() * 0.06;
  const sinceWord = now - lastWordAt;
  const base = sinceWord < 140 ? 0.95 : 0.78;
  return Math.min(0.99, base + (Math.random() - 0.5) * 0.12);
}

let shownValue = 0;

function waveLoop(now) {
  wave.setProbability(simulatedProbability(now));
  wave.frame(now);
  shownValue += (wave.level - shownValue) * 0.2;
  vadValue.textContent = shownValue.toFixed(2);
  requestAnimationFrame(waveLoop);
}

async function setState(text) {
  if (demoState.textContent === text) return;
  demoState.classList.add("fading");
  await sleep(250);
  demoState.textContent = text;
  demoState.classList.remove("fading");
}

function addWord(word, first) {
  if (!first) demoText.append(" ");
  const span = document.createElement("span");
  span.className = "word";
  span.textContent = word;
  demoText.append(span);
}

async function runDemo() {
  let index = 0;
  while (true) {
    const words = lines[index].split(" ");
    setState("Listening");
    await sleep(900);

    speaking = true;
    vad.classList.add("speaking");
    setState("Transcribing");
    for (let i = 0; i < words.length; i++) {
      lastWordAt = performance.now();
      addWord(words[i], i === 0);
      await sleep(170 + Math.random() * 130);
    }

    speaking = false;
    vad.classList.remove("speaking");
    setState("Endpoint detected");
    await sleep(2200);

    // Fade the finished line out before the next one starts.
    demoText.classList.add("fading");
    await sleep(450);
    demoText.textContent = "";
    demoText.classList.remove("fading");
    index = (index + 1) % lines.length;
  }
}

if (reducedMotion) {
  // Static snapshot: a short burst of speech in the middle of the trace.
  wave.bars = wave.bars.map((_, i, all) => {
    const t = i / all.length;
    wave.setProbability(t > 0.35 && t < 0.8 ? 0.9 : 0.04);
    return wave.makeBar();
  });
  wave.draw();
  vadValue.textContent = "0.92";
  demoText.textContent = lines[0];
} else {
  requestAnimationFrame(waveLoop);
  runDemo();
}
