// ==========================================================================
// Tokenly base — identical on tokenly.in, Kural and fast-CV.
// Change it in one page, copy it to the others. Page code goes below the
// "Page" banner at the end of this file.
// ==========================================================================

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

// ---------- Animated backdrop ----------

// Sizes the full-viewport #bg canvas and runs the page's draw(view, now) every
// frame, pausing while the tab is hidden. Reduced motion draws one still frame.
function startBackdrop({ draw, resize = () => {} }) {
  const canvas = document.getElementById("bg");
  const view = { ctx: canvas.getContext("2d"), width: 0, height: 0 };

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.width = window.innerWidth;
    view.height = window.innerHeight;
    canvas.width = view.width * dpr;
    canvas.height = view.height * dpr;
    view.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    resize(view);
  }

  fit();
  window.addEventListener("resize", () => {
    fit();
    if (reducedMotion) draw(view, 0);
  });

  if (reducedMotion) {
    draw(view, 0);
    return;
  }

  let rafId = 0;
  const frame = (now) => {
    draw(view, now);
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(rafId);
    if (!document.hidden) rafId = requestAnimationFrame(frame);
  });
}

// ==========================================================================
// Page
// ==========================================================================

// ---------- Animated waveform background ----------

const WAVE_RGB = "200, 65, 65";

const waves = [
  { amp: 28, freq: 0.006, speed: 0.6, alpha: 0.24, y: 0.58, width: 2.5, phase: 0 },
  { amp: 20, freq: 0.009, speed: -0.9, alpha: 0.18, y: 0.62, width: 2.25, phase: 2.1 },
  { amp: 38, freq: 0.004, speed: 0.4, alpha: 0.14, y: 0.66, width: 2.5, phase: 4.2 },
  { amp: 24, freq: 0.007, speed: -0.5, alpha: 0.11, y: 0.7, width: 2, phase: 0.8 },
  { amp: 32, freq: 0.005, speed: 0.75, alpha: 0.08, y: 0.75, width: 2, phase: 5.3 },
  { amp: 18, freq: 0.01, speed: -0.6, alpha: 0.06, y: 0.8, width: 1.75, phase: 2.7 },
];

startBackdrop({
  draw({ ctx, width, height }, t) {
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
          Math.sin(x * w.freq + t * 0.001 * w.speed + w.phase) * w.amp * envelope * taper +
          Math.sin(x * w.freq * 2.3 + t * 0.0017 * w.speed) * w.amp * 0.3 * taper;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${WAVE_RGB}, ${w.alpha})`;
      ctx.lineWidth = w.width;
      ctx.lineCap = "round";
      ctx.stroke();
    });
  },
});

// ---------- Probability waveform ----------

// Bars whose heights morph with the VAD speech probability.
class ProbabilityBars {
  constructor(container, { count = 10, rest, active }) {
    this.container = container;
    this.rest = rest;
    this.active = active;
    this.target = 0;
    this.level = 0;
    this.time = 0;
    this.last = 0;
    this.bars = Array.from({ length: count }, (_, i) => {
      const el = document.createElement("span");
      container.append(el);
      // Bell-shaped profile: centre bars reach higher than the edges.
      const c = (i - (count - 1) / 2) / ((count - 1) / 2);
      return {
        el,
        shape: 0.4 + 0.6 * Math.cos((c * Math.PI) / 2),
        // Neighbouring bars share a phase offset so motion flows across the row.
        phase: i * 0.55 + Math.random() * 0.6,
      };
    });
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    this.height = this.container.clientHeight;
    this.minHeight = this.bars[0].el.clientWidth || 5;
  }

  setProbability(p) {
    this.target = Math.max(0, Math.min(1, p));
  }

  frame(now) {
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    // Fast attack, slower release, like the endpointer's hysteresis.
    const rate = this.target > this.level ? 14 : 5;
    this.level += (this.target - this.level) * (1 - Math.exp(-dt * rate));
    // Motion speeds up as the model grows more confident there is speech.
    this.time += dt * (0.5 + this.level * 1.8);
    this.draw();
  }

  draw() {
    const { rest, active, level } = this;
    const color = rest.map((v, i) => Math.round(v + (active[i] - v) * level)).join(", ");
    this.bars.forEach((bar) => {
      // Two travelling waves in opposite directions keep the shape organic.
      const wobble =
        0.5 +
        0.3 * Math.sin(this.time * 6 + bar.phase) +
        0.2 * Math.sin(this.time * 9.5 - bar.phase * 1.3);
      const breathe = 0.04 * (1 + Math.sin(this.time * 2 + bar.phase));
      const energy = Math.min(1, level * bar.shape * wobble + breathe);
      const h = this.minHeight + (this.height - this.minHeight) * energy;
      bar.el.style.height = `${h.toFixed(1)}px`;
      bar.el.style.background = `rgb(${color})`;
    });
  }
}

// ---------- Live transcript demo ----------

const vad = document.getElementById("vad");
const vadValue = document.getElementById("vadValue");
const demoText = document.getElementById("demoText");
const demoState = document.getElementById("demoState");
const wave = new ProbabilityBars(document.getElementById("vadBars"), {
  count: 24,
  rest: [214, 208, 208],
  active: [200, 65, 65],
});

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
  // Static snapshot of the bars mid-speech.
  wave.level = 0.92;
  wave.draw();
  vadValue.textContent = "0.92";
  demoText.textContent = lines[0];
} else {
  requestAnimationFrame(waveLoop);
  runDemo();
}
