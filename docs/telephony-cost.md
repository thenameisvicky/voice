# Yuga telephony cost accounting

Yuga records an estimated Exotel charge on every phone call, then can replace that estimate with an actual charge from Exotel billing. Browser websocket sessions are not telephony and stay `not_applicable`.

The existing modelled "cost per completed call" card is unchanged. That number still uses the hardware / electricity assumptions in `src/telemetry/config.js`, including `COST_MODEL.telephonyPerMinute`. It is **not** the Exotel tariff.

## Call lifecycle

1. Customer dials the merchant number.
2. Exotel opens the `/exotel` websocket and sends `start` with `call_sid`.
3. Yuga starts a telemetry trace keyed by that CallSid.
4. Audio, ASR, LLM, tools and TTS run as before.
5. `stop` or websocket close ends the trace.
6. Cost is attached from the configured tariff and whatever duration is known.
7. Later, Exotel can POST a status callback, or you can import a CDR / invoice row.

The websocket does not include Price or billable Duration. Application start-to-close time is used only until an official Exotel duration arrives, and is labelled `durationSource: application`.

## Configure the Exotel tariff

Amounts are **integer paise** (1 INR = 100 paise). There is no default rate. If the inbound/outbound rate is unset, the telephony cost is `unavailable`, never `0.00`.

```bash
# Required for estimates
export EXOTEL_TARIFF_INBOUND_PAISE_PER_MINUTE=80    # ₹0.80 / minute
export EXOTEL_TARIFF_OUTBOUND_PAISE_PER_MINUTE=150  # ₹1.50 / minute

# Billing increment. Default 60 seconds, rounded up.
export EXOTEL_TARIFF_INCREMENT_SECONDS=60
export EXOTEL_TARIFF_ROUNDING=ceil                  # ceil | floor | nearest
export EXOTEL_TARIFF_CURRENCY=INR
export EXOTEL_TARIFF_VERSION=1
```

Copy the per-minute figure from your Exotel contract or latest invoice. Do not guess.

Optional vendor inference rates, also integer paise. Leave unset when ASR/TTS/LLM are self-hosted with no per-unit invoice:

```bash
export INFERENCE_ASR_PAISE_PER_AUDIO_MINUTE=
export INFERENCE_LLM_PAISE_PER_1K_TOKENS=
export INFERENCE_TTS_PAISE_PER_AUDIO_MINUTE=
```

## Official duration and actual charges

Exotel's voice stream does not expose the billed amount. Yuga uses two official sources, and only stores fields that are actually present.

### 1. Status callback

In the Exotel dashboard, set the call Status Callback URL to:

```text
https://<your-host>/exotel/status
```

Exotel POSTs form fields such as `CallSid`, `Status`, `Direction`, `Duration`, `StartTime`, `EndTime`. If the payload includes `Price`, that value becomes `actual_telephony_cost`. If `Price` is absent, the estimate is kept.

### 2. Call Details API (optional)

If these are set, Yuga may GET the documented Call Details resource after hangup:

```text
GET {EXOTEL_API_BASE_URL}/v1/Accounts/{EXOTEL_ACCOUNT_SID}/Calls/{CallSid}.json
```

```bash
export EXOTEL_ACCOUNT_SID=
export EXOTEL_API_KEY=
export EXOTEL_API_TOKEN=
export EXOTEL_API_BASE_URL=https://api.exotel.com
```

`Duration` is used when present. `Price` is used only when that key exists in the JSON. The client does not invent other billing fields.

### 3. CDR / invoice import

When the invoice or CDR export has the charged amount:

```bash
curl -X POST http://localhost:3000/exotel/billing \
  -H 'Content-Type: application/json' \
  -d '{
    "callSid": "CAXXXXXXXX",
    "actual_telephony_cost": "1.20",
    "currency": "INR",
    "source": "exotel-cdr-export"
  }'
```

`actualPaise` (integer) is also accepted. Updates are idempotent on `CallSid`.

## Schema on each call (`trace.cost`)

| Field | Meaning |
| --- | --- |
| `estimated_telephony_cost` | Tariff × billable minutes, INR decimal string or null |
| `actual_telephony_cost` | Official/imported charge, or null |
| `telephony_cost_status` | `estimated` · `actual` · `pending` · `unavailable` · `not_applicable` · `not_billed` |
| `asr_cost` / `llm_cost` / `tts_cost` | Inference components, or null if unconfigured |
| `inference_cost` | `asr + llm + tts` when all three are known |
| `estimated_total_cost` | estimated telephony + inference |
| `actual_total_cost` | actual telephony + inference, only after reconciliation |
| `currency` | `INR` |
| `cost_calculation_version` | `1` |

Monetary values are stored as integer paise and shown as decimal rupee strings. Floating-point is not used for arithmetic.

## Dashboard

The Yuga telemetry overview and per-call report add:

- Telephony cost (estimated or actual)
- Inference cost
- Estimated total
- Actual total when reconciled
- Cost per connected minute
- Cost per successful business action
- Estimated vs actual
- Aggregate telephony spend, inference spend, average cost per call

Failed invoice attempts remain in total spend. A connected call is not treated as a successful business action.

## Tests

```bash
node --test test/cost.test.js
```
