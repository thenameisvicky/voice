const PAISE_PER_RUPEE = 100;

function isBlank(value) {
    return value == null || value === "";
}

export function parsePaise(value) {
    if (isBlank(value)) return null;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return Number.isInteger(value) ? value : null;
    }

    const text = String(value).trim().replace(/,/g, "");
    if (!/^-?\d+$/.test(text)) return null;

    return Number(text);
}

export function rupeesToPaise(value) {
    if (isBlank(value)) return null;

    const text = String(value).trim().replace(/,/g, "");
    const match = text.match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return null;

    const sign = match[1] ? -1 : 1;
    const whole = Number(match[2]);
    const fraction = Number((match[3] ?? "").padEnd(2, "0") || "0");

    return sign * (whole * PAISE_PER_RUPEE + fraction);
}

export function paiseToRupees(paise) {
    if (!Number.isInteger(paise)) return null;

    const sign = paise < 0 ? "-" : "";
    const abs = Math.abs(paise);
    const whole = Math.trunc(abs / PAISE_PER_RUPEE);
    const fraction = String(abs % PAISE_PER_RUPEE).padStart(2, "0");

    return `${sign}${whole}.${fraction}`;
}

export function addPaise(...values) {
    if (values.some((value) => !Number.isInteger(value))) return null;
    return values.reduce((total, value) => total + value, 0);
}

export function dividePaise(numerator, denominator, rounding = "ceil") {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) {
        return null;
    }

    const negative = numerator < 0 !== denominator < 0;
    const absNum = Math.abs(numerator);
    const absDen = Math.abs(denominator);
    const quotient = Math.trunc(absNum / absDen);
    const remainder = absNum % absDen;

    let units = quotient;

    if (remainder !== 0) {
        if (rounding === "floor") {
            units = quotient;
        } else if (rounding === "nearest") {
            units = remainder * 2 >= absDen ? quotient + 1 : quotient;
        } else {
            units = quotient + 1;
        }
    }

    return negative ? -units : units;
}

export function applyPerMinuteRate(ratePaisePerMinute, billableSeconds, rounding = "ceil") {
    if (!Number.isInteger(ratePaisePerMinute) || !Number.isInteger(billableSeconds)) {
        return null;
    }

    return dividePaise(ratePaisePerMinute * billableSeconds, 60, rounding);
}

export function billableSeconds(connectedSeconds, incrementSeconds = 60, rounding = "ceil") {
    if (!Number.isFinite(connectedSeconds) || connectedSeconds < 0) return null;

    const increment = Number.isInteger(incrementSeconds) && incrementSeconds > 0
        ? incrementSeconds
        : 60;
    const seconds = Math.max(0, Math.round(connectedSeconds));

    if (seconds === 0) return 0;

    const increments = dividePaise(seconds, increment, rounding);
    if (increments == null) return null;

    return increments * increment;
}
