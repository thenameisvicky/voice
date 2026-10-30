import {
    toolsReady,
    getCustomerProfile,
    getInventoryItem,
    quoteOrder,
    createInvoice
} from "./tools.js";

const MAX_SEARCH_RESULTS = 5;

const rupees = (minor) => Math.round(Number(minor || 0)) / 100;

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ITEMS_SCHEMA = {
    type: "array",
    description: "Items in the order.",
    items: {
        type: "object",
        properties: {
            item_id: {
                type: "string",
                description: "Exact item_id from a search_catalog result."
            },
            quantity: {
                type: "number",
                description: "Quantity greater than 0, in the item's unit."
            }
        },
        required: ["item_id", "quantity"]
    }
};

export const ORDER_CONFIRMATION = {
    quoteTool: "quote_order",
    commitTool: "create_invoice",
    commitArgs: (quoteArgs) => ({ items: quoteArgs.items, customer_confirmed: true })
};

export const TOOL_DEFINITIONS = [
    {
        type: "function",
        function: {
            name: "search_catalog",
            description: "Search the shop catalog by product name. Returns item_id, name, price in rupees, unit and stock.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Product name or part of it, for example rice."
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "quote_order",
            description: "Calculate the exact total for items and quantities, including tax. Does not place an order.",
            parameters: {
                type: "object",
                properties: { items: ITEMS_SCHEMA },
                required: ["items"]
            }
        }
    }
];

export async function lookupCustomer(phone) {
    if (!phone || !toolsReady()) return null;

    const profile = await getCustomerProfile(phone);
    if (profile.status !== "success") return null;

    return { id: profile.data._id, name: profile.data.name };
}

const toInventoryItems = (items) =>
    (Array.isArray(items) ? items : []).map((item) => ({
        inventory_id: item.item_id,
        quantity: Number(item.quantity)
    }));

export function createToolExecutor({ customer }) {
    const handlers = {
        async search_catalog({ query }) {
            if (!query?.trim()) return { ok: false, error: "Say which product to search for." };

            const result = await getInventoryItem({ name: escapeRegex(query.trim()) });
            if (result.status !== "success") return { ok: false, error: result.message };

            const items = result.data.slice(0, MAX_SEARCH_RESULTS).map((item) => ({
                item_id: item._id,
                name: item.name,
                price_rupees: rupees(item.unit_price),
                unit: item.sub_unit || item.base_unit || "",
                in_stock: item.available_quantity
            }));

            return items.length > 0
                ? { ok: true, items }
                : { ok: true, items: [], note: `No product matches "${query}".` };
        },

        async quote_order({ items }) {
            const result = await quoteOrder(toInventoryItems(items));
            if (result.status !== "success") return { ok: false, error: result.message };

            return {
                ok: true,
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

        async create_invoice({ items, customer_confirmed }) {
            if (!customer) {
                return { ok: false, error: "No verified customer is linked to this call, so an invoice cannot be created." };
            }
            if (customer_confirmed !== true) {
                return { ok: false, error: "The customer has not confirmed. Read the total and ask them to confirm first." };
            }

            const result = await createInvoice({
                customerId: customer.id,
                items: toInventoryItems(items)
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

    return async function executeTool(name, args) {
        if (!toolsReady()) {
            return { ok: false, error: "The shop system is not available right now." };
        }

        const handler = handlers[name];
        if (!handler) return { ok: false, error: `Unknown tool ${name}` };

        return handler(args ?? {});
    };
}
