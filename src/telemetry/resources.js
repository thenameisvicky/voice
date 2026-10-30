import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const PAGE_SIZE = 4096;

const STACK_PATTERNS = [
    { label: "llama-server", pattern: /llama-server/ },
    { label: "nemo-speech", pattern: /nemo-speech/ },
    { label: "whisper", pattern: /whisper(-server|\.cpp)?/ }
];

let stackPids = null;

export function systemCpuTimes() {
    let idleMs = 0;
    let totalMs = 0;

    for (const cpu of os.cpus()) {
        for (const [mode, value] of Object.entries(cpu.times)) {
            totalMs += value;
            if (mode === "idle") idleMs += value;
        }
    }

    return { idleMs, totalMs };
}

function readRss(pid) {
    try {
        return Number(fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * PAGE_SIZE;
    } catch {
        return null;
    }
}

function discoverStackPids() {
    const found = [];

    try {
        for (const entry of fs.readdirSync("/proc")) {
            if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;

            let cmdline;

            try {
                cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
            } catch {
                continue;
            }

            const match = STACK_PATTERNS.find((candidate) => candidate.pattern.test(cmdline));
            if (match) found.push({ pid: Number(entry), label: match.label });
        }
    } catch {
    }

    return found;
}

export function stackMemory() {
    if (stackPids === null) stackPids = discoverStackPids();

    const processes = [{ pid: process.pid, label: "node", rssBytes: process.memoryUsage().rss }];
    let stale = false;

    for (const { pid, label } of stackPids) {
        const rssBytes = readRss(pid);

        if (rssBytes == null) stale = true;
        else processes.push({ pid, label, rssBytes });
    }

    if (stale) stackPids = null;

    return {
        processes,
        totalRssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
        complete: processes.length > 1
    };
}

export function memorySnapshot() {
    const total = os.totalmem();
    const free = os.freemem();
    const stack = stackMemory();

    return {
        systemTotalBytes: total,
        systemUsedBytes: total - free,
        utilizationPct: ((total - free) / total) * 100,
        stackRssBytes: stack.totalRssBytes,
        stackComplete: stack.complete,
        stackProcesses: stack.processes
    };
}

export function gpuMemory() {
    try {
        const rows = execFileSync(
            "nvidia-smi",
            ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
            { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }
        ).trim().split("\n").filter(Boolean);

        const devices = rows.map((row) => {
            const [name, total, used] = row.split(",").map((field) => field.trim());
            return { name, totalBytes: Number(total) * 1024 ** 2, usedBytes: Number(used) * 1024 ** 2 };
        });

        return {
            present: devices.length > 0,
            devices,
            totalBytes: devices.reduce((total, device) => total + device.totalBytes, 0),
            usedBytes: devices.reduce((total, device) => total + device.usedBytes, 0)
        };
    } catch {
        return { present: false, reason: "no CUDA device; the pipeline runs on CPU" };
    }
}

export function openResourceWindow() {
    const cpuStart = systemCpuTimes();
    const memoryStart = memorySnapshot();
    const wallStart = Date.now();

    return function close() {
        const cpuEnd = systemCpuTimes();
        const memoryEnd = memorySnapshot();
        const wallMs = Math.max(1, Date.now() - wallStart);

        const capacityCpuMs = cpuEnd.totalMs - cpuStart.totalMs;
        const busyCpuMs = Math.max(0, capacityCpuMs - (cpuEnd.idleMs - cpuStart.idleMs));

        return {
            wallMs,
            busyCpuMs,
            utilizationPct: capacityCpuMs > 0 ? (busyCpuMs / capacityCpuMs) * 100 : 0,
            coresBusy: busyCpuMs / wallMs,
            stackRssDeltaBytes: memoryEnd.stackRssBytes - memoryStart.stackRssBytes,
            stackRssBytes: memoryEnd.stackRssBytes
        };
    };
}

export async function measureIdleBaseline(durationMs) {
    const close = openResourceWindow();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const window = close();
    const memory = memorySnapshot();

    return {
        measuredAt: Date.now(),
        durationMs: window.wallMs,
        idleCoresBusy: window.coresBusy,
        idleUtilizationPct: window.utilizationPct,
        systemTotalBytes: memory.systemTotalBytes,
        systemUsedBytes: memory.systemUsedBytes,
        stackRssBytes: memory.stackRssBytes,
        stackComplete: memory.stackComplete,
        stackProcesses: memory.stackProcesses
    };
}

export function hostInfo() {
    return {
        cores: os.cpus().length,
        cpuModel: os.cpus()[0]?.model?.trim() ?? "unknown",
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        nodeVersion: process.version,
        systemTotalBytes: os.totalmem(),
        gpu: gpuMemory()
    };
}
