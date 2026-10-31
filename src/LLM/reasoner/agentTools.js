import { CALL_OUTRO } from "../config.js";
import { transfers } from "../../telephony/callTransfer.js";
import {
    toolsReady,
    getCustomerProfile,
    getInventoryItem,
    quoteOrder,
    createInvoice
} from "./tools.js";

const MAX_SEARCH_RESULTS = 8;
const MAX_LIST_RESULTS = 40;
const MONGO_OBJECT_ID = /^[a-fA-F0-9]{24}$/;

const rupees = (minor) => Math.round(Number(minor || 0)) / 100;

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isMongoObjectId(value) {
    return MONGO_OBJECT_ID.test(String(value || ""));
}

export function mapCatalogItem(item) {
    return {
        item_id: String(item._id),
        name: item.name,
        price_rupees: rupees(item.unit_price),
        unit: item.sub_unit || item.base_unit || "",
        in_stock: Number(item.available_quantity ?? 0)
    };
}

export function matchCatalogItems(catalog, spoken) {
    const needle = String(spoken || "").trim().toLowerCase();
    if (!needle) return [];

    const exact = catalog.filter((item) => String(item.name || "").toLowerCase() === needle);
    if (exact.length > 0) return exact;

    return catalog.filter((item) => String(item.name || "").toLowerCase().includes(needle));
}

export function resolveCatalogSelection(catalog, spokenOrId) {
    const key = String(spokenOrId || "").trim();
    if (!key) {
        return { status: "invalid", error: "Say which product you want." };
    }

    if (isMongoObjectId(key)) {
        const found = catalog.find((item) => item.item_id === key);
        return found
            ? { status: "ok", item: found }
            : { status: "unknown_id", item_id: key };
    }

    const matches = matchCatalogItems(catalog, key);
    if (matches.length === 1) {
        return { status: "ok", item: matches[0] };
    }
    if (matches.length > 1) {
        return {
            status: "ambiguous",
            error: "Several products match that name. Which one do you want?",
            matches
        };
    }

    return { status: "missing", error: "That product is not in the catalog. Ask me to list what we have, or say another name." };
}

const ITEMS_SCHEMA = {
    type: "array",
    description: "Items in the order. item_id must be copied from a search_catalog result.",
    items: {
        type: "object",
        properties: {
            item_id: {
                type: "string",
                description: "Exact item_id from a search_catalog result. Never invent this value."
            },
            quantity: {
                type: "number",
                description: "Requested quantity greater than 0, in the item's unit."
            },
            accept_partial: {
                type: "boolean",
                description: "If true and stock is short, quote the available quantity instead of failing."
            }
        },
        required: ["item_id", "quantity"]
    }
};

export const ORDER_CONFIRMATION = {
    quoteTool: "quote_order",
    commitTool: "create_invoice",
    commitArgs: (quoteArgs, result) => ({
        items: result?.items ?? quoteArgs.items,
        customer_confirmed: true
    })
};

export const TRANSFER_TOOL = "transfer_to_human";
export const ESCALATION_REASONS = new Set(["owner", "human", "someone_else", "cannot_complete"]);

function transferToolDefinition(departments) {
    const names = departments.length > 0
        ? departments.map((entry) => entry.id).join(", ")
        : "none configured";

    return {
        type: "function",
        function: {
            name: TRANSFER_TOOL,
            description:
                "Escalate to support only when the caller asks to speak to the owner, a human, or anyone else, " +
                "or when you tried and cannot complete their request. Do not use this for catalog, price, stock, " +
                "or order help. Pass department support, never a phone number. This only starts the transfer. " +
                "Do not tell the caller they are already connected. Available departments: " +
                names + ".",
            parameters: {
                type: "object",
                properties: {
                    department: {
                        type: "string",
                        description: "Must be support. Never a phone number."
                    },
                    reason: {
                        type: "string",
                        enum: ["owner", "human", "someone_else", "cannot_complete"],
                        description:
                            "Why this call must be escalated. owner, human, or someone_else only if the caller asked for that person. cannot_complete only after you tried and still cannot finish their request."
                    },
                    summary: {
                        type: "string",
                        description: "Short handoff notes for the receiving human. No phone numbers or internal ids."
                    }
                },
                required: ["department", "reason"]
            }
        }
    };
}

export function toolDefinitions(transfer = transfers) {
    return [
    {
        type: "function",
        function: {
            name: "search_catalog",
            description: "List or search shop products. Omit query to list all products. Returns item_id, name, price in rupees, unit and stock. Never read item_id aloud.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Optional product name or part of it. Leave empty to list every product."
                    }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "quote_order",
            description: "Build or update the pending order and calculate the exact total, including tax. Verifies current stock and price. If stock is short it returns available quantity and alternatives. Does not place an order.",
            parameters: {
                type: "object",
                properties: {
                    items: ITEMS_SCHEMA,
                    replace_all: {
                        type: "boolean",
                        description: "If true, replace the pending order. If omitted, merge these items into the pending order by item_id."
                    }
                },
                required: ["items"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "end_call",
            description: "End the phone call after a goodbye. Call this when the customer says bye, that's all, or they are done. After a draft invoice is created the system ends the call for you.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Why the call is ending, for example goodbye or done."
                    }
                }
            }
        }
    },
    transferToolDefinition(transfer.listDepartments())
    ];
}

export const TOOL_DEFINITIONS = toolDefinitions();

export async function lookupCustomer(phone) {
    if (!phone || !toolsReady()) return null;

    const profile = await getCustomerProfile(phone);
    if (profile.status !== "success") return null;

    return {
        id: profile.data._id,
        name: profile.data.name,
        created: Boolean(profile.created)
    };
}

const toInventoryItems = (items) =>
    (Array.isArray(items) ? items : []).map((item) => ({
        inventory_id: item.item_id,
        quantity: Number(item.quantity)
    }));

function catalogNote(query, items, totalFound) {
    if (items.length === 0) {
        return query
            ? `No product matches "${query}".`
            : "No products are currently available.";
    }
    if (!query && totalFound > items.length) {
        return `Showing ${items.length} of ${totalFound} products. Ask the customer to name one, or search by a more specific word.`;
    }
    return undefined;
}

export function createToolExecutor({
    customer,
    callId = null,
    channel = null,
    fetchInventory = getInventoryItem,
    quote = quoteOrder,
    invoice = createInvoice,
    transfer = transfers
} = {}) {
    let catalog = [];
    let draft = [];

    const remember = (items) => {
        catalog = items;
        return items;
    };

    const mergeDraft = (incoming, replaceAll) => {
        if (replaceAll) return incoming;
        const next = new Map(draft.map((line) => [line.item_id, line]));
        for (const line of incoming) {
            next.set(line.item_id, line);
        }
        return [...next.values()];
    };

    async function findAlternatives(item) {
        const word = String(item?.name || "").split(/\s+/).find(Boolean) || "";
        const seen = new Set([item?.item_id]);
        const options = [];

        const consider = (candidate) => {
            if (!candidate || seen.has(candidate.item_id) || !(candidate.in_stock > 0)) return;
            seen.add(candidate.item_id);
            options.push(candidate);
        };

        for (const known of catalog) consider(known);

        if (word) {
            const result = await fetchInventory({ name: escapeRegex(word) });
            if (result.status === "success") {
                for (const row of result.data || []) consider(mapCatalogItem(row));
            }
        }

        return options.slice(0, 5);
    }

    async function lookupById(itemId) {
        const known = catalog.find((item) => item.item_id === itemId);
        if (known) return known;

        const result = await fetchInventory({ itemId });
        if (result.status !== "success" || !result.data?.[0]) return null;
        const mapped = mapCatalogItem(result.data[0]);
        catalog = [...catalog.filter((item) => item.item_id !== mapped.item_id), mapped];
        return mapped;
    }

    async function resolveLine(raw) {
        const quantity = Number(raw?.quantity);
        if (!(quantity > 0)) {
            return { ok: false, error: "Quantity must be greater than 0." };
        }

        const key = String(raw?.item_id || raw?.name || "").trim();
        let resolved = resolveCatalogSelection(catalog, key);

        if (resolved.status === "unknown_id") {
            const fetched = await lookupById(resolved.item_id);
            resolved = fetched
                ? { status: "ok", item: fetched }
                : { status: "missing", error: "That product is not in the catalog." };
        }

        if (resolved.status === "missing" && key && !isMongoObjectId(key)) {
            const result = await fetchInventory({ name: escapeRegex(key) });
            if (result.status === "success") {
                const matches = remember((result.data || []).map(mapCatalogItem));
                resolved = resolveCatalogSelection(matches, key);
            }
        }

        if (resolved.status === "ambiguous") {
            return {
                ok: false,
                error: resolved.error,
                matches: resolved.matches
            };
        }

        if (resolved.status !== "ok") {
            return { ok: false, error: resolved.error || "That product is not in the catalog." };
        }

        if (resolved.item.in_stock < quantity) {
            if (raw.accept_partial === true && resolved.item.in_stock > 0) {
                return {
                    ok: true,
                    item: resolved.item,
                    quantity: resolved.item.in_stock,
                    requested: quantity,
                    partial: true
                };
            }
            return {
                ok: false,
                code: "insufficient_stock",
                item: resolved.item,
                requested: quantity
            };
        }

        return { ok: true, item: resolved.item, quantity, requested: quantity };
    }

    function toDraftLine(line) {
        return {
            item_id: line.item.item_id,
            name: line.item.name,
            quantity: line.quantity,
            requested: line.requested ?? line.quantity,
            unit: line.item.unit,
            price_rupees: line.item.price_rupees,
            in_stock: line.item.in_stock,
            partial: Boolean(line.partial)
        };
    }

    async function resolveOrderItems(items) {
        if (!Array.isArray(items) || items.length === 0) {
            return { ok: false, error: "Say which products and quantities to quote." };
        }

        const resolved = [];
        const shortages = [];
        for (const raw of items) {
            const line = await resolveLine(raw);
            if (line.code === "insufficient_stock") {
                shortages.push(line);
                continue;
            }
            if (!line.ok) return line;
            resolved.push(toDraftLine(line));
        }

        if (shortages.length > 0) {
            const first = shortages[0];
            return {
                ok: false,
                code: "insufficient_stock",
                error: `Only ${first.item.in_stock} ${first.item.unit || "units"} of ${first.item.name} available.`,
                shortage: {
                    item_id: first.item.item_id,
                    name: first.item.name,
                    requested: first.requested,
                    available: first.item.in_stock,
                    unit: first.item.unit,
                    price_rupees: first.item.price_rupees
                },
                alternatives: await findAlternatives(first.item),
                items: resolved
            };
        }

        return { ok: true, items: resolved };
    }

    const handlers = {
        async search_catalog({ query } = {}) {
            const q = String(query || "").trim();
            const result = q
                ? await fetchInventory({ name: escapeRegex(q) })
                : await fetchInventory({});

            if (result.status !== "success") return { ok: false, error: result.message };

            const totalFound = result.data.length;
            const items = remember(
                result.data
                    .slice(0, q ? MAX_SEARCH_RESULTS : MAX_LIST_RESULTS)
                    .map(mapCatalogItem)
            );
            const note = catalogNote(q, items, totalFound);

            return {
                ok: true,
                items,
                listed_all: !q,
                ...(note ? { note } : {})
            };
        },

        async quote_order({ items, replace_all } = {}) {
            const incoming = await resolveOrderItems(items);
            if (!incoming.ok) return incoming;

            const next = mergeDraft(incoming.items, replace_all === true);
            const result = await quote(toInventoryItems(next));
            if (result.status !== "success") {
                return { ok: false, error: result.message, items: next };
            }

            draft = next.map((line, index) => ({
                ...line,
                line_total_rupees: rupees(result.items[index]?.line_grand_total)
            }));

            return {
                ok: true,
                items: draft,
                lines: result.items.map((item) => ({
                    name: item.item_name,
                    quantity: item.quantity,
                    unit: item.unit,
                    line_total_rupees: rupees(item.line_grand_total)
                })),
                subtotal_rupees: rupees(result.total_amount),
                tax_rupees: rupees(result.total_tax_amount),
                total_rupees: rupees(result.grand_total)
            };
        },

        async end_call() {
            return { ok: true, hangup: true, message: CALL_OUTRO };
        },

        async transfer_to_human({ department, reason, summary } = {}, { confirmed = false } = {}) {
            if (channel !== "exotel") {
                return {
                    ok: false,
                    code: "channel_unavailable",
                    error: "This session is not on an Exotel call, so it cannot be transferred."
                };
            }
            if (!callId) {
                return { ok: false, error: "This call has no Exotel CallSid, so it cannot be transferred." };
            }
            if (!transfer.config.enabled) {
                return { ok: false, error: "No human departments are configured for transfer." };
            }

            const escalationReason = String(reason || "").trim().toLowerCase();
            if (!ESCALATION_REASONS.has(escalationReason)) {
                return {
                    ok: false,
                    code: "invalid_reason",
                    error: "Escalate only if the caller asked for the owner, a human, or anyone else, or if you cannot complete their request."
                };
            }

            const resolved = transfer.resolve(department);
            if (resolved.status !== "ok") {
                return {
                    ok: false,
                    code: resolved.status === "forbidden" ? "forbidden_destination" : "unknown_department",
                    error: resolved.error,
                    departments: transfer.listDepartments()
                };
            }

            if (confirmed !== true) {
                return {
                    ok: true,
                    needs_confirmation: true,
                    status: "needs_confirmation",
                    department: resolved.department.id,
                    label: resolved.department.label,
                    reason: escalationReason
                };
            }

            return transfer.initiate(callId, {
                department: resolved.department,
                reason: escalationReason,
                summary
            });
        },

        async create_invoice({ items, customer_confirmed } = {}) {
            if (!customer) {
                return { ok: false, error: "No verified customer is linked to this call, so an invoice cannot be created." };
            }
            if (customer_confirmed !== true) {
                return { ok: false, error: "The customer has not confirmed. Read the name, quantity and total, then ask them to confirm first." };
            }

            const source = Array.isArray(items) && items.length > 0 ? items : draft;
            const resolved = await resolveOrderItems(source);
            if (!resolved.ok) return resolved;

            const result = await invoice({
                customerId: customer.id,
                items: toInventoryItems(resolved.items)
            });
            if (result.status !== "success") return { ok: false, error: result.message };

            return {
                ok: true,
                invoice_number: result.invoice_number,
                total_rupees: rupees(result.grand_total),
                status: result.lifecycle_status
            };
        }
    };

    return async function executeTool(name, args, context = {}) {
        const handler = handlers[name];
        if (!handler) return { ok: false, error: `Unknown tool ${name}` };

        if (
            name !== "end_call" &&
            name !== TRANSFER_TOOL &&
            !toolsReady() &&
            fetchInventory === getInventoryItem
        ) {
            return { ok: false, error: "The shop system is not available right now." };
        }

        return handler(args ?? {}, context);
    };
}
