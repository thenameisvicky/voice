import assert from "node:assert/strict";
import { test } from "node:test";

import { Reasoner } from "../src/LLM/reasoner/reasoner.js";
import { ORDER_CONFIRMATION } from "../src/LLM/reasoner/agentTools.js";

const QUOTE = { ok: true, items: [{ item_id: "sugar", name: "Sugar", quantity: 5 }], total_rupees: 233.6 };

function reasonerWithQuote() {
    const calls = [];
    const reasoner = new Reasoner({
        model: { generate: async () => ({ type: "final", content: "The tax is 13 rupees and 60 paise." }) },
        systemPrompt: "test",
        executeTool: async (name, args) => {
            calls.push(name);
            if (name === "quote_order") return QUOTE;
            if (name === "create_invoice") return { ok: true, invoice_number: "INV-TEST", total_rupees: 233.6 };
            return { ok: true };
        },
        tools: [],
        confirmation: ORDER_CONFIRMATION,
        callId: "CA-confirm"
    });
    return { reasoner, calls };
}

test("'proceed with the order' confirms a quote", async () => {
    const { reasoner, calls } = reasonerWithQuote();
    await reasoner.runTool("quote_order", { items: [{ item_id: "sugar", quantity: 5 }] });

    const spoken = await reasoner.reason("Proceed with the order.");
    assert.ok(calls.includes("create_invoice"));
    assert.match(spoken.content, /draft invoice/i);
});

test("a side question keeps the quote waiting for yes", async () => {
    const { reasoner, calls } = reasonerWithQuote();
    await reasoner.runTool("quote_order", { items: [{ item_id: "sugar", quantity: 5 }] });

    await reasoner.reason("What is the tax amount?");
    assert.equal(calls.includes("create_invoice"), false);
    assert.equal(reasoner.memory.pendingAction.tool, "create_invoice");

    await reasoner.reason("Okay go ahead.");
    assert.ok(calls.includes("create_invoice"));
});

test("a no drops the quote", async () => {
    const { reasoner, calls } = reasonerWithQuote();
    await reasoner.runTool("quote_order", { items: [{ item_id: "sugar", quantity: 5 }] });

    await reasoner.reason("No, not now.");
    assert.equal(reasoner.memory.pendingAction, null);
    await reasoner.reason("What is the tax amount?");
    assert.equal(calls.includes("create_invoice"), false);
});
