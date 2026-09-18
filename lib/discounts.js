'use strict';
// ===========================================================================
// DISCOUNT CODES — the rules, in one place
// ---------------------------------------------------------------------------
// This module is pure: it touches no database, no HTTP and no clock of its own
// (the current time is injected). It exists so that the two places that must
// agree on the number — POST /api/validate-discount (what the checkout shows)
// and POST /api/orders (what the customer is actually charged) — run the exact
// same code instead of two copies that can drift.
//
// It does NOT create a discount system. The codes themselves live in the
// existing `discount_codes` table and are managed by the existing
// Admin -> Discounts screen; this only interprets what that screen saved.
// ===========================================================================

// Long enough for any real promo code, short enough that a hostile body can
// never make us do meaningful work (or log a novel's worth) on a bogus code.
const MAX_CODE_LENGTH = 40;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Codes are case-insensitive and whitespace-insensitive for the customer:
// " save20 ", "save20" and "SAVE20" are the same code. Admin already stores
// them upper-cased; normalising here means a lower-case row (created through
// any other path) still matches.
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
}

function isExpired(code, now) {
  if (!code || !code.expires_at) return false;
  const at = Date.parse(code.expires_at);
  if (!Number.isFinite(at)) return false;
  return at <= now.getTime();
}

// A blank / 0 / negative max_uses means "unlimited".
function usesExhausted(code) {
  const max = num(code && code.max_uses);
  if (!Number.isFinite(max) || max <= 0) return false;
  return num(code.used_count) >= max;
}

function findDiscountCode(rows, raw) {
  const want = normalizeCode(raw);
  if (!want) return null;
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (row && normalizeCode(row.code) === want) return row;
  }
  return null;
}

// How much the code is worth before any cap. `base` is the merchandise
// subtotal (see the note on evaluateDiscountCode below).
function rawAmount(code, base) {
  const value = num(code.value);
  if (code.type === 'fixed') return value;
  return base * (value / 100);
}

// ---------------------------------------------------------------------------
// evaluateDiscountCode(rows, rawCode, { subtotal, bundleDiscount, now })
//
// `subtotal`        — merchandise total, i.e. the sum of the line totals
//                     BEFORE the bundle discount and before delivery. This is
//                     the number an admin means by "Min Order (EGP)".
// `bundleDiscount`  — the existing full-set saving, already earned. The two
//                     discounts stack, but a code can never discount away more
//                     than the merchandise left after the bundle, so the
//                     order total can never go below the delivery fee.
//
// Returns { ok:true, code, type, value, minOrder, discount } on success and
// { ok:false, reason, ... } on failure. `reason` is a stable machine token the
// caller turns into localised copy — never a message meant for a customer.
// ---------------------------------------------------------------------------
function evaluateDiscountCode(rows, rawCode, opts) {
  const options = opts || {};
  const now = options.now instanceof Date ? options.now : new Date();
  const subtotal = Math.max(0, num(options.subtotal));
  const bundleDiscount = Math.max(0, num(options.bundleDiscount));

  const normalized = normalizeCode(rawCode);
  if (!normalized) return { ok: false, reason: 'invalid' };

  const code = findDiscountCode(rows, normalized);
  if (!code) return { ok: false, reason: 'not_found' };

  const result = {
    ok: false,
    code: normalizeCode(code.code),
    type: code.type === 'fixed' ? 'fixed' : 'percentage',
    value: num(code.value),
    minOrder: num(code.min_order),
  };

  if (code.active === false || code.active === 0 || code.active === 'false') {
    return Object.assign({}, result, { reason: 'inactive' });
  }
  if (isExpired(code, now)) {
    return Object.assign({}, result, { reason: 'expired' });
  }
  if (usesExhausted(code)) {
    return Object.assign({}, result, { reason: 'exhausted' });
  }
  if (subtotal < result.minOrder) {
    return Object.assign({}, result, { reason: 'min_order' });
  }

  // Cap at whatever merchandise value is left after the bundle saving.
  const headroom = Math.max(0, subtotal - bundleDiscount);
  const discount = Math.max(0, Math.min(rawAmount(code, subtotal), headroom));

  return Object.assign({}, result, { ok: true, reason: null, discount: Math.round(discount) });
}

module.exports = {
  MAX_CODE_LENGTH,
  normalizeCode,
  findDiscountCode,
  isExpired,
  usesExhausted,
  evaluateDiscountCode,
};
