import assert from "node:assert/strict";
import { test } from "node:test";

import { Reasoner } from "../src/LLM/reasoner/reasoner.js";
import { createToolExecutor } from "../src/LLM/reasoner/agentTools.js";
import { buildSystemPrompt } from "../src/LLM/config.js";
import {
    TransferRegistry,
    handleExotelConnectRequest,
    publicEventUrl
} from "../src/telephony/callTransfer.js";
import { parseExotelCallRecord } from "../src/telephony/exotelStatus.js";
import {
    looksLikePhoneNumber,
    parseTransferDestinations,
    resolveDepartment,
    resolveTransferConfig
} from "../src/telephony/transferDestinations.js";

function destinations() {
    return resolveTransferConfig({
        EXOTEL_TRANSFER_DESTINATIONS: JSON.stringify([
            {
                id: "support",
                label: "support",
                aliases: ["helpdesk"],
                numbers: ["+919811111111"]
            },
            {
                id: "sales",
                label: "sales",
                numbers: ["+919822222222"]
            }
        ]),
        EXOTEL_TRANSFER_DEFAULT: "support",
        EXOTEL_TRANSFER_TIMEOUT_MS: "40",
        EXOTEL_TRANSFER_CONNECT_WAIT_MS: "20",
        EXOTEL_TRANSFER_RING_SECONDS: "30"
    });
}

function registry(extra = {}) {
    const recorded = [];
    return {
        recorded,
        transfer: new TransferRegistry({
            config: destinations(),
            now: () => 1_000,
            setTimer: () => 1,
            clearTimer: () => {},
            telemetryApi: {
                recordTransfer(callSid, update) {
                    recorded.push({ callSid, ...update });
                }
            },
            ...extra
        })
    };
}

function mockRes() {
    return {
        status: null,
        body: null,
        writeHead(status) {
            this.status = status;
        },
        end(text) {
            this.body = JSON.parse(text);
        }
    };
}

test("hardcoded support destination and ngrok public base are used by default", () => {
    const config = resolveTransferConfig({});

    assert.equal(config.enabled, true);
    assert.equal(config.destinations.length, 1);
    assert.equal(config.defaultDepartment.id, "support");
    assert.deepEqual(config.destinations[0].numbers, ["+91636980395"]);
    assert.equal(
        config.publicBaseUrl,
        "https://813a-2401-4900-c98d-1c9d-3beb-b879-3cb0-7162.ngrok-free.app"
    );
    assert.equal(
        config.streamUrl,
        "wss://813a-2401-4900-c98d-1c9d-3beb-b879-3cb0-7162.ngrok-free.app/exotel"
    );
});

test("allowlist parses departments and never treats a number as a department", () => {
    const parsed = parseTransferDestinations("support:+919811111111,sales:+919822222222");
    assert.deepEqual(parsed.map((entry) => entry.id), ["support", "sales"]);
    assert.equal(looksLikePhoneNumber("+919811111111"), true);

    const config = destinations();
    assert.equal(resolveDepartment(config, "human").department.id, "support");
    assert.equal(resolveDepartment(config, "sales").department.id, "sales");
    assert.equal(resolveDepartment(config, "+919811111111").status, "forbidden");
    assert.equal(resolveDepartment(config, "legal").status, "unknown");
});

test("transfer_to_human requires confirmation and rejects arbitrary numbers", async () => {
    const { transfer } = registry();
    const execute = createToolExecutor({
        callId: "CA123",
        channel: "exotel",
        transfer
    });

    const pending = await execute("transfer_to_human", { department: "support", reason: "human" });
    assert.equal(pending.needs_confirmation, true);
    assert.equal(pending.status, "needs_confirmation");
    assert.equal(transfer.snapshot("CA123"), null);

    const noReason = await execute("transfer_to_human", { department: "support" }, { confirmed: true });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.code, "invalid_reason");

    const forbidden = await execute("transfer_to_human", { department: "+919833333333", reason: "human" }, { confirmed: true });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.code, "forbidden_destination");
    assert.equal(transfer.snapshot("CA123"), null);

    const started = await execute("transfer_to_human", { department: "support", reason: "human" }, { confirmed: true });
    assert.equal(started.ok, true);
    assert.equal(started.status, "initiated");
    assert.equal(started.leave_stream, true);
    assert.notEqual(started.status, "connected");
});

test("browser sessions cannot transfer", async () => {
    const { transfer } = registry();
    const execute = createToolExecutor({
        callId: "browser-1",
        channel: "browser",
        transfer
    });

    const result = await execute("transfer_to_human", { department: "support" }, { confirmed: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, "channel_unavailable");
});

test("Connect Dynamic URL only returns an allowlisted destination after confirmation", () => {
    const { transfer } = registry();

    const empty = transfer.onConnectQuery({ CallSid: "CA123" });
    assert.deepEqual(empty.destination.numbers, []);

    transfer.initiate("CA123", { department: transfer.resolve("support").department, summary: "Asked about rice." });
    const response = transfer.onConnectQuery({ CallSid: "CA123" }, { eventUrl: "https://host/exotel/connect/events" });

    assert.deepEqual(response.destination.numbers, ["+919811111111"]);
    assert.equal(response.start_call_playback.value, "Asked about rice.");
    assert.equal(response.dial_passthru_event_url, "https://host/exotel/connect/events");
    assert.equal(transfer.snapshot("CA123").status, "connecting");
    assert.notEqual(transfer.snapshot("CA123").status, "connected");
});

test("a later DialCallStatus is required before the transfer is treated as connected", () => {
    const { transfer, recorded } = registry();
    transfer.initiate("CA123", { department: transfer.resolve("sales").department });
    transfer.onConnectQuery({ CallSid: "CA123" });

    assert.equal(transfer.snapshot("CA123").status, "connecting");

    transfer.onDialEvent({ CallSid: "CA123", DialCallStatus: "no-answer" });
    assert.equal(transfer.snapshot("CA123").status, "failed");
    assert.equal(recorded.at(-1).ok, false);
    assert.equal(recorded.at(-1).status, "failed");

    transfer.initiate("CA999", { department: transfer.resolve("sales").department });
    transfer.onConnectQuery({ CallSid: "CA999" });
    transfer.onDialEvent({ CallSid: "CA999", DialCallStatus: "completed" });
    assert.equal(transfer.snapshot("CA999").status, "connected");
    assert.equal(recorded.at(-1).ok, true);
});

test("Connect HTTP handler cannot be pointed at an arbitrary number", () => {
    const { transfer } = registry();
    transfer.initiate("CA123", { department: transfer.resolve("support").department });

    const res = mockRes();
    handleExotelConnectRequest({
        method: "GET",
        url: "/exotel/connect?CallSid=CA123&To=%2B919833333333",
        headers: { host: "example.test" }
    }, res, transfer);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.destination.numbers, ["+919811111111"]);
    assert.equal(res.body.destination.numbers.includes("+919833333333"), false);
});

test("reasoner strips LLM confirmation and waits for an explicit yes", async () => {
    const { transfer } = registry();
    const execute = createToolExecutor({
        callId: "CA123",
        channel: "exotel",
        transfer
    });

    const reasoner = new Reasoner({
        model: {
            generate: async () => ({
                type: "final",
                content: "I've transferred you to an agent."
            })
        },
        systemPrompt: "test",
        executeTool: execute,
        tools: [],
        callId: "CA123"
    });

    await reasoner.runTool("transfer_to_human", {
        department: "support",
        reason: "human",
        caller_confirmed: true,
        number: "+919833333333"
    });

    assert.equal(reasoner.memory.pendingAction.tool, "transfer_to_human");
    assert.equal(transfer.snapshot("CA123"), null);

    const spoken = await reasoner.reason("yes");
    assert.equal(reasoner.hangupReason, "transfer");
    assert.match(spoken.content, /connecting you to support/i);
    assert.equal(transfer.snapshot("CA123").status, "initiated");
});

test("reasoner does not claim a successful handoff from model text", async () => {
    const reasoner = new Reasoner({
        model: {
            generate: async () => ({
                type: "final",
                content: "You're now connected with a human."
            })
        },
        systemPrompt: "test",
        executeTool: async () => ({ ok: true }),
        tools: [],
        callId: "CA123"
    });

    const spoken = await reasoner.reason("connect me");
    assert.match(spoken.content, /haven't transferred/i);
    assert.equal(spoken.hangup, false);
});

test("failed transfer returns a spoken alternative when Voicebot comes back", () => {
    const { transfer } = registry();
    transfer.initiate("CA123", { department: transfer.resolve("support").department });
    transfer.onConnectQuery({ CallSid: "CA123" });

    const returned = transfer.onVoicebotStart("CA123");
    assert.equal(returned.status, "failed");
    assert.match(returned.speakOnReturn, /did not connect|could not reach|busy|keep helping/i);
    assert.equal(transfer.shouldKeepTrace("CA123"), false);
});

test("status callback parser keeps DialCallStatus separate from call Status", () => {
    const parsed = parseExotelCallRecord({
        CallSid: "CA123",
        Status: "in-progress",
        DialCallStatus: "no-answer",
        DialWhomNumber: "+919811111111"
    });

    assert.equal(parsed.status, "in-progress");
    assert.equal(parsed.dialCallStatus, "no-answer");
    assert.equal(parsed.dialWhomNumber, "+919811111111");
});

test("public event URL prefers the configured public base", () => {
    const url = publicEventUrl(
        { headers: { host: "localhost:3000" } },
        { publicBaseUrl: "https://voice.example" }
    );
    assert.equal(url, "https://voice.example/exotel/connect/events");
});

test("prompt only allows owner, human, anyone else, or an incomplete request", () => {
    const prompt = buildSystemPrompt({
        departments: [{ id: "support", label: "support" }]
    });

    assert.match(prompt, /speak to the owner/i);
    assert.match(prompt, /speak to a human/i);
    assert.match(prompt, /anyone else/i);
    assert.match(prompt, /cannot complete their request/i);
    assert.match(prompt, /Do not escalate because they asked for a product/i);
    assert.match(prompt, /Do not offer a transfer[\s\S]*ordinary shop help/i);

    const config = resolveTransferConfig({});
    assert.equal(resolveDepartment(config, "owner").department.id, "support");
    assert.equal(resolveDepartment(config, "anyone else").department.id, "support");
});
