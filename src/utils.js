/**
 * Utility functions for cart recovery system
 */

/**
 * Strips non-digit characters from a phone number string
 */
function getCleanPhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * Checks if two phone numbers belong to the same customer (Brazilian format aware)
 * Handles country code '55', with or without the 9th digit (e.g. 5511988887777 vs 1188887777).
 */
function isSameCustomerPhone(phoneA, phoneB) {
  const cleanA = getCleanPhone(phoneA);
  const cleanB = getCleanPhone(phoneB);
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  // Extract core 8 digits (subscriber number without 9th digit)
  const last8A = cleanA.slice(-8);
  const last8B = cleanB.slice(-8);
  if (last8A.length < 8 || last8B.length < 8) return false;
  if (last8A !== last8B) return false;

  // Extract DDD (area code)
  const getDDD = (clean) => {
    if (clean.startsWith('55') && clean.length >= 12) return clean.slice(2, 4);
    if (clean.length >= 10 && clean.length <= 11) return clean.slice(0, 2);
    return '';
  };

  const dddA = getDDD(cleanA);
  const dddB = getDDD(cleanB);
  if (dddA && dddB && dddA !== dddB) return false;

  return true;
}

/**
 * Checks if two carts/items correspond to the same order/purchase
 */
function isSameOrder(cartA, cartBOrItems, amountB = null) {
  if (!cartA) return false;

  const amountA = Number(cartA.amount) || 0;
  let amountBVal = 0;
  if (amountB !== null && amountB !== undefined) {
    amountBVal = Number(amountB) || 0;
  } else if (cartBOrItems && typeof cartBOrItems === 'object' && cartBOrItems.amount !== undefined) {
    amountBVal = Number(cartBOrItems.amount) || 0;
  }

  // Parse items from cartA
  let itemsA = [];
  try {
    itemsA = typeof cartA.items_json === 'string' ? JSON.parse(cartA.items_json) : (cartA.items || []);
  } catch (e) {
    itemsA = [];
  }
  if (!Array.isArray(itemsA)) itemsA = [];

  // Parse items from B
  let itemsB = [];
  const rawItemsB = Array.isArray(cartBOrItems)
    ? cartBOrItems
    : (cartBOrItems && (cartBOrItems.items || cartBOrItems.cartItems || cartBOrItems.products)) || [];

  if (typeof rawItemsB === 'string') {
    try {
      itemsB = JSON.parse(rawItemsB);
    } catch (e) {
      itemsB = [];
    }
  } else if (Array.isArray(rawItemsB)) {
    itemsB = rawItemsB;
  }

  // 1. If both have items: check if any item title/name or ID matches
  if (itemsA.length > 0 && itemsB.length > 0) {
    const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const titlesA = itemsA.map((i) => normalize(i.title || i.name || i.productName)).filter(Boolean);
    const titlesB = itemsB.map((i) => normalize(i.title || i.name || i.productName)).filter(Boolean);

    const idsA = itemsA.map((i) => String(i.id || i.productId || '')).filter(Boolean);
    const idsB = itemsB.map((i) => String(i.id || i.productId || '')).filter(Boolean);

    const hasMatchId = idsA.length > 0 && idsB.length > 0 && idsA.some((id) => idsB.includes(id));
    if (hasMatchId) return true;

    const hasMatchTitle = titlesA.some((tA) => titlesB.some((tB) => tA === tB || tA.includes(tB) || tB.includes(tA)));
    if (hasMatchTitle) return true;
  }

  // 2. If amounts are both > 0 and match within R$ 1,00 tolerance
  if (amountA > 0 && amountBVal > 0 && Math.abs(amountA - amountBVal) <= 100) {
    return true;
  }

  // 3. Fallback: If either cart has no items recorded (common in Bestfy transaction-only postbacks)
  if (itemsA.length === 0 || itemsB.length === 0) {
    return true;
  }

  return false;
}

module.exports = {
  getCleanPhone,
  isSameCustomerPhone,
  isSameOrder,
};
