import { MongoClient, ObjectId } from "mongodb";
import { randomUUID } from "crypto";

let client = null;
let db = null;
let config = {
    companyId: "",
    userId: "",
    appBaseUrl: "http://localhost:8082",
    publicTokenSecret: "change"
};

function requireDb() {
    if (!db) {
        throw new Error("MongoDB is not initialized. Call initTools() from server.js first.");
    }
    return db;
}

function requireCompanyId() {
    if (!config.companyId) {
        throw new Error("COMPANY_ID is required for voice-agent DB tools.");
    }
    return config.companyId;
}

function nowUtc() {
    return new Date();
}

export function normalizeIndianPhone(value) {
    const digits = String(value || "").replace(/\D+/g, "");
    if (digits.length === 10) {
        return `91${digits}`;
    }
    return digits;
}

function phoneVariants(incomingNumber) {
    const normalized = normalizeIndianPhone(incomingNumber);
    const variants = new Set([normalized, String(incomingNumber || "").replace(/\D+/g, "")].filter(Boolean));
    if (normalized.length === 12 && normalized.startsWith("91")) {
        variants.add(normalized.slice(2));
    }
    return [...variants];
}

function serializeDoc(doc) {
    if (doc == null) return doc;
    if (Array.isArray(doc)) return doc.map(serializeDoc);
    if (doc instanceof ObjectId) return String(doc);
    if (doc instanceof Date) return doc.toISOString();
    if (typeof doc !== "object") return doc;

    const out = {};
    for (const [key, value] of Object.entries(doc)) {
        out[key] = serializeDoc(value);
    }
    return out;
}

function serializeCustomer(customer) {
    return serializeDoc({
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        whatsapp_phone: customer.whatsapp_phone,
        email: customer.email,
        gstin: customer.gstin,
        address: customer.address,
        billing_address: customer.billing_address || customer.address,
        billing_state: customer.billing_state,
        billing_state_code: customer.billing_state_code || customer.billing_state,
        customer_type: customer.customer_type,
        gst_registration_type: customer.gst_registration_type || customer.customer_type,
        notes: customer.notes,
        company_id: customer.company_id
    });
}

async function createCustomerFromIncomingNumber(incomingNumber, extras = {}) {
    const database = extras.database || requireDb();
    const companyId = extras.companyId || requireCompanyId();
    const phone = normalizeIndianPhone(incomingNumber);
    const now = nowUtc();
    const customer = {
        _id: new ObjectId(),
        company_id: companyId,
        user_id: String(config.userId || "voice-agent"),
        name: "",
        phone,
        whatsapp_phone: phone,
        gstin: null,
        email: null,
        address: null,
        billing_address: null,
        notes: "Created automatically from incoming voice call",
        customer_type: "Individual",
        gst_registration_type: "Individual",
        billing_state: "",
        billing_state_code: "",
        campaign_id: null,
        created_at: now,
        updated_at: now,
        is_active: true
    };

    await database.collection("customerdetails").insertOne(customer);
    await database.collection("customerengagementdetails").insertOne({
        _id: new ObjectId(),
        entity_id: String(customer._id),
        entity_type: "Customer",
        event_type: "CustomerCreated",
        metadata: {
            source: "AI",
            created_by_ai: true,
            incoming_number: phone
        },
        created_at: now,
        company_id: companyId
    });

    return customer;
}

function itemPriceMinor(item) {
    return Number(
        item.selling_price_minor ??
        item.selling_price ??
        item.unit_price ??
        0
    );
}

function legacyStatusFromLifecycle(lifecycleStatus, deliveryStatus = null) {
    if (lifecycleStatus === "ISSUED" && deliveryStatus === "SENT") return "Sent";
    if (lifecycleStatus === "ISSUED") return "Issued";
    if (lifecycleStatus === "CANCELLED") return "Cancelled";
    return "Draft";
}

function discountFromPayload(subtotal, amount, percentage) {
    if (amount != null) return Number(amount);
    return Math.floor((subtotal * Number(percentage || 0)) / 100);
}

function normalizeInvoiceItems(items) {
    let totalAmount = 0;
    let totalTaxAmount = 0;
    const processed = items.map((item) => {
        const quantity = Number(item.quantity || 0);
        const unitPrice = Number(item.unit_price || 0);
        const lineSubtotal = quantity * unitPrice;
        let lineTaxTotal = 0;
        for (const tax of item.tax_details || []) {
            lineTaxTotal += Math.floor((lineSubtotal * Number(tax.tax_percentage || 0)) / 10000);
        }
        totalAmount += lineSubtotal;
        totalTaxAmount += lineTaxTotal;
        return {
            ...item,
            quantity,
            unit_price: unitPrice,
            line_subtotal: lineSubtotal,
            line_tax_total: lineTaxTotal,
            line_grand_total: lineSubtotal + lineTaxTotal
        };
    });
    return { processed, totalAmount, totalTaxAmount };
}

async function buildSnapshots(companyId, customerId, items) {
    const database = requireDb();
    const company = ObjectId.isValid(companyId)
        ? await database.collection("companydetails").findOne({ _id: new ObjectId(companyId) })
        : null;
    const customer = ObjectId.isValid(customerId)
        ? await database.collection("customerdetails").findOne({
            _id: new ObjectId(customerId),
            company_id: companyId,
            is_active: true
        })
        : null;

    const itemSnapshots = [];
    for (const item of items) {
        let product = null;
        if (ObjectId.isValid(String(item.inventory_id))) {
            product = await database.collection("newinventorydetails").findOne({
                _id: new ObjectId(String(item.inventory_id)),
                company_id: companyId,
                is_active: true
            });
        }
        const taxDetails = item.tax_details || [];
        itemSnapshots.push({
            inventory_id: String(item.inventory_id || ""),
            item_name: product?.name || item.item_name || "",
            product_code: product?.code || "",
            hsn_code: item.hsn_code || product?.hsn_code || "",
            uqc: product?.uqc_code || item.unit,
            unit: item.unit || product?.base_unit || "",
            quantity: Number(item.quantity || 0),
            unit_price: Number(item.unit_price || 0),
            discount: Number(item.discount || 0),
            taxable_value: Number(item.line_subtotal || 0),
            gst_rate: taxDetails.reduce((sum, tax) => sum + Number(tax.tax_percentage || 0), 0),
            cgst: taxDetails
                .filter((tax) => String(tax.tax_name || "").toUpperCase() === "CGST")
                .reduce((sum, tax) => sum + Number(tax.tax_percentage || 0), 0),
            sgst: taxDetails
                .filter((tax) => String(tax.tax_name || "").toUpperCase() === "SGST")
                .reduce((sum, tax) => sum + Number(tax.tax_percentage || 0), 0),
            igst: taxDetails
                .filter((tax) => String(tax.tax_name || "").toUpperCase() === "IGST")
                .reduce((sum, tax) => sum + Number(tax.tax_percentage || 0), 0),
            line_total: Number(item.line_grand_total || 0)
        });
    }

    const sellerSnapshot = {
        name: company?.name || "",
        gstin: company?.gstin || "",
        address: company?.address || "",
        state: company?.state || "",
        phone: company?.phone || ""
    };
    const buyerSnapshot = {
        customer_id: customerId,
        name: customer?.name || "",
        phone: customer?.whatsapp_phone || customer?.phone || "",
        email: customer?.email || "",
        gst_registration_type: customer?.gst_registration_type || customer?.customer_type || "",
        gstin: customer?.gstin || "",
        billing_address: customer?.billing_address || customer?.address || "",
        billing_state_code: customer?.billing_state_code || customer?.billing_state || ""
    };

    return {
        sellerSnapshot,
        buyerSnapshot,
        itemSnapshots,
        supplierGst: sellerSnapshot.gstin || "N/A"
    };
}

export async function initTools({
    mongoUri,
    mongoDatabase = "wai",
    companyId = "",
    userId = "",
    appBaseUrl = "http://localhost:8082",
    publicTokenSecret = "change"
} = {}) {
    if (!mongoUri) {
        throw new Error("MONGO_URI is required to initialize voice-agent tools.");
    }

    config = {
        companyId: companyId || process.env.COMPANY_ID || "",
        userId: userId || process.env.USER_ID || "",
        appBaseUrl: appBaseUrl || process.env.APP_BASE_URL || "http://localhost:8082",
        publicTokenSecret: publicTokenSecret || process.env.PUBLIC_TOKEN_SECRET || "change"
    };

    if (db) {
        return db;
    }

    client = new MongoClient(mongoUri);
    await client.connect();
    db = client.db(mongoDatabase);
    await db.command({ ping: 1 });
    console.log(`[TOOLS] Connected to MongoDB database "${mongoDatabase}"`);
    return db;
}

export function toolsReady() {
    return db !== null && Boolean(config.companyId);
}

export async function quoteOrder(items = []) {
    const database = requireDb();
    const companyId = requireCompanyId();

    if (!Array.isArray(items) || items.length === 0) {
        return { status: "error", message: "Items array cannot be empty." };
    }

    const lineItems = [];
    for (const raw of items) {
        const inventoryId = raw.inventory_id || raw.inventoryId;
        const quantity = Number(raw.quantity || 1);
        if (!ObjectId.isValid(String(inventoryId))) {
            return { status: "error", message: "Invoice item is missing a valid product reference" };
        }
        if (quantity <= 0) {
            return { status: "error", message: "Invoice item quantity must be greater than zero" };
        }

        const product = await database.collection("newinventorydetails").findOne({
            _id: new ObjectId(String(inventoryId)),
            company_id: companyId,
            is_active: true
        });
        if (!product) {
            return { status: "error", message: `Inventory item not found: ${inventoryId}` };
        }
        if (Number(product.total_sub_units || 0) < quantity) {
            return {
                status: "error",
                message: `Insufficient quantity for ${product.name || product.code}`
            };
        }

        lineItems.push({
            inventory_id: String(product._id),
            item_name: product.name,
            quantity,
            unit: product.sub_unit || product.base_unit || "",
            unit_price: itemPriceMinor(product),
            tax_details: product.tax || []
        });
    }

    const { processed, totalAmount, totalTaxAmount } = normalizeInvoiceItems(lineItems);

    return {
        status: "success",
        items: processed,
        total_amount: totalAmount,
        total_tax_amount: totalTaxAmount,
        grand_total: totalAmount + totalTaxAmount,
        currency: "INR"
    };
}

export async function closeTools() {
    if (client) {
        await client.close();
        client = null;
        db = null;
    }
}

export async function getCustomerProfile(incomingNumber, extras = {}) {
    const database = extras.database || requireDb();
    const companyId = extras.companyId || requireCompanyId();
    const variants = phoneVariants(incomingNumber);

    if (variants.length === 0) {
        return { status: "error", message: "incomingNumber is required" };
    }

    let customer = await database.collection("customerdetails").findOne({
        company_id: companyId,
        is_active: true,
        $or: [
            { phone: { $in: variants } },
            { whatsapp_phone: { $in: variants } }
        ]
    });

    if (!customer) {
        customer = await createCustomerFromIncomingNumber(incomingNumber, { database, companyId });
        return {
            status: "success",
            created: true,
            data: serializeCustomer(customer)
        };
    }

    return {
        status: "success",
        created: false,
        data: serializeCustomer(customer)
    };
}

export async function getInventoryItem(filter = {}) {
    const database = requireDb();
    const companyId = requireCompanyId();

    const query = {
        company_id: companyId,
        is_active: true
    };

    if (filter.itemId && ObjectId.isValid(String(filter.itemId))) {
        query._id = new ObjectId(String(filter.itemId));
    }
    if (filter.name) {
        query.name = { $regex: String(filter.name), $options: "i" };
    }
    if (filter.code) {
        query.code = String(filter.code);
    }

    const cursor = database.collection("newinventorydetails").find(query).sort({ name: 1 });
    const items = await cursor.toArray();

    const data = items.map((item) => ({
        _id: String(item._id),
        name: item.name,
        code: item.code,
        description: item.description || "",
        hsn_code: item.hsn_code,
        uqc_code: item.uqc_code,
        item_type: item.item_type || "GOODS",
        base_unit: item.base_unit,
        sub_unit: item.sub_unit || "",
        unit_price: itemPriceMinor(item),
        selling_price_minor: itemPriceMinor(item),
        currency: item.currency || "INR",
        tax: item.tax || [],
        taxability: item.taxability || "TAXABLE",
        available_quantity: Number(item.total_sub_units || 0),
        total_sub_units: Number(item.total_sub_units || 0)
    }));

    if (filter.itemId && data.length === 0) {
        return { status: "error", message: "Inventory item not found" };
    }

    return { status: "success", data };
}

export async function createInvoice(params = {}) {
    const database = requireDb();
    const companyId = requireCompanyId();
    const userId = config.userId || "voice-agent";

    let customerId = params.customerId || params.customer_id || "";
    if (!customerId && params.incomingNumber) {
        const profile = await getCustomerProfile(params.incomingNumber);
        if (profile.status !== "success") {
            return profile;
        }
        customerId = profile.data._id;
    }

    if (!customerId || !ObjectId.isValid(String(customerId))) {
        return { status: "error", message: "Valid customerId or incomingNumber is required" };
    }

    const customer = await database.collection("customerdetails").findOne({
        _id: new ObjectId(String(customerId)),
        company_id: companyId,
        is_active: true
    });
    if (!customer) {
        return { status: "error", message: "Customer not found or inactive" };
    }

    const rawItems = Array.isArray(params.items) && params.items.length > 0
        ? params.items
        : (params.inventoryId || params.inventory_id)
            ? [{
                inventory_id: params.inventoryId || params.inventory_id,
                quantity: Number(params.quantity || 1)
            }]
            : [];

    if (rawItems.length === 0) {
        return { status: "error", message: "Items array cannot be empty." };
    }

    const lineItems = [];
    for (const raw of rawItems) {
        const inventoryId = raw.inventory_id || raw.inventoryId;
        const quantity = Number(raw.quantity || 1);
        if (!ObjectId.isValid(String(inventoryId))) {
            return { status: "error", message: "Invoice item is missing a valid product reference" };
        }
        if (quantity <= 0) {
            return { status: "error", message: "Invoice item quantity must be greater than zero" };
        }

        const product = await database.collection("newinventorydetails").findOne({
            _id: new ObjectId(String(inventoryId)),
            company_id: companyId,
            is_active: true
        });
        if (!product) {
            return { status: "error", message: `Inventory item not found: ${inventoryId}` };
        }
        if (Number(product.total_sub_units || 0) < quantity) {
            return {
                status: "error",
                message: `Insufficient quantity for ${product.name || product.code}`
            };
        }

        lineItems.push({
            inventory_id: String(product._id),
            item_name: product.name,
            quantity,
            unit: product.sub_unit || product.base_unit || "",
            unit_price: itemPriceMinor(product),
            tax_details: product.tax || [],
            hsn_code: product.hsn_code || ""
        });
    }

    const { processed, totalAmount, totalTaxAmount } = normalizeInvoiceItems(lineItems);
    const discountAmount = discountFromPayload(
        totalAmount,
        params.discount_amount ?? params.discountAmount,
        params.discount_percentage ?? params.discountPercentage ?? 0
    );
    if (discountAmount < 0 || discountAmount > totalAmount) {
        return { status: "error", message: "Discount amount must be between zero and the subtotal" };
    }

    const discountedTotal = totalAmount - discountAmount;
    const grandTotal = discountedTotal + totalTaxAmount;
    const now = nowUtc();
    const invoiceTnxId = randomUUID();
    const invoiceNumber = String(params.invoice_number || params.invoiceNumber || `INV-${invoiceTnxId.slice(0, 8).toUpperCase()}`);
    const lifecycleStatus = params.issue ? "ISSUED" : "DRAFT";
    const placeOfSupply =
        params.place_of_supply ||
        params.placeOfSupply ||
        customer.billing_state_code ||
        customer.billing_state ||
        "";

    const { sellerSnapshot, buyerSnapshot, itemSnapshots, supplierGst } =
        await buildSnapshots(companyId, String(customerId), processed);

    const invoice = {
        _id: new ObjectId(),
        user_id: String(userId),
        company_id: companyId,
        customer_id: String(customerId),
        invoice_tnx_id: invoiceTnxId,
        invoice_number: invoiceNumber,
        created_at: now,
        last_updated: now,
        place_of_supply: placeOfSupply,
        items: processed,
        customer_gst:
            params.customer_gst ||
            params.customerGst ||
            (String(customer.customer_type || "").toLowerCase() === "business"
                ? (customer.gstin || "N/A")
                : "N/A"),
        total_amount: discountedTotal,
        total_tax_amount: totalTaxAmount,
        discount_amount: discountAmount,
        discount_percentage: Number(params.discount_percentage ?? params.discountPercentage ?? 0),
        grand_total: grandTotal,
        due_amount: grandTotal,
        amount_received: 0,
        status: legacyStatusFromLifecycle(lifecycleStatus),
        lifecycle_status: lifecycleStatus,
        delivery_status: "NOT_SENT",
        payment_status: "UnPaid",
        source: "AI",
        created_by_ai: true,
        inventory_effect: "APPLY_ON_ISSUE",
        inventory_applied: false,
        issued_at: lifecycleStatus === "ISSUED" ? now : null,
        issue_method: params.issue ? (params.issue_method || "VOICE_AGENT") : null,
        currency: "INR",
        due_date: params.due_date ? new Date(params.due_date) : null,
        public_token: null,
        payment_link: "",
        supplier_gst: supplierGst,
        invoice_type: params.invoice_type || params.invoiceType || "Tax Invoice",
        previous_invoice_id: null,
        version_number: 0,
        seller_snapshot: sellerSnapshot,
        buyer_snapshot: buyerSnapshot,
        item_snapshot: itemSnapshots,
        is_active: true
    };

    if (params.issue) {
        const decremented = [];
        for (const item of processed) {
            const objectId = new ObjectId(String(item.inventory_id));
            const quantity = Number(item.quantity);
            const result = await database.collection("newinventorydetails").updateOne(
                {
                    _id: objectId,
                    company_id: companyId,
                    is_active: true,
                    total_sub_units: { $gte: quantity }
                },
                {
                    $inc: { total_sub_units: -quantity },
                    $set: { updated_at: now }
                }
            );
            if (result.modifiedCount !== 1) {
                for (const [rollbackId, rollbackQty] of decremented) {
                    await database.collection("newinventorydetails").updateOne(
                        { _id: rollbackId, company_id: companyId },
                        {
                            $inc: { total_sub_units: rollbackQty },
                            $set: { updated_at: now }
                        }
                    );
                }
                return {
                    status: "error",
                    message: "Inventory changed while issuing invoice. Try again."
                };
            }
            decremented.push([objectId, quantity]);
        }
        invoice.inventory_applied = true;
    }

    await database.collection("invoicedetails").insertOne(invoice);
    await database.collection("invoiceeventdetails").insertOne({
        _id: new ObjectId(),
        entity_id: invoiceTnxId,
        entity_type: "Invoice",
        event_type: params.issue ? "InvoiceIssued" : "InvoiceCreated",
        metadata: {
            source: "AI",
            created_by_ai: true,
            invoice_number: invoiceNumber,
            grand_total: grandTotal,
            issue_method: params.issue ? (params.issue_method || "VOICE_AGENT") : undefined
        },
        created_at: now,
        company_id: companyId
    });

    return {
        status: "success",
        invoice_tnx_id: invoiceTnxId,
        invoice_number: invoiceNumber,
        payment_link: invoice.payment_link,
        grand_total: grandTotal,
        total_amount: discountedTotal,
        total_tax_amount: totalTaxAmount,
        currency: "INR",
        lifecycle_status: invoice.lifecycle_status,
        data: serializeDoc(invoice)
    };
}
