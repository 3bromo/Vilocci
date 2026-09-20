'use strict';

// Storefront policy: shared by the public settings payload and order pricing.
// Eligibility remains based on merchandise subtotal, before discounts/add-ons.
const FREE_SHIPPING_THRESHOLD = 2000;
function deliveryFeeFor(settings, subtotal) {
  return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : (settings.shippingFee || 0);
}
module.exports = { FREE_SHIPPING_THRESHOLD, deliveryFeeFor };
