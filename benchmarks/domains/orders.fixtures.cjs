const { defineDomain } = require('./support.cjs');
module.exports = defineDomain('orders', [
  {
    id: 'negative-quantity', path: 'src/orders/lines.js',
    contract: 'A line quantity must be a positive safe integer; invalid input must be rejected before calculating its total.',
    safe: `export function lineTotal(product, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("invalid quantity");
  return product.priceCents * quantity;
}`,
    buggy: `export function lineTotal(product, quantity) {
  if (!Number.isSafeInteger(quantity)) throw new Error("invalid quantity");
  return product.priceCents * quantity;
}`,
    trigger: 'A negative line quantity creates a negative order total.', terms: ['quantity', 'negative', 'positive'],
    proof: '(()=>{try{return f({priceCents:500},-2)<0;}catch{return false;}})()',
  },
  {
    id: 'cancel-owner', path: 'src/orders/cancellation.js', category: 'authorization',
    contract: 'Only the authenticated customer who owns an order may cancel it. Both order and customer IDs are server-authenticated records.',
    safe: `export function cancel(order, customer) {
  if (order.customerId !== customer.id) throw new Error("forbidden");
  order.status = "cancelled";
}`,
    buggy: `export function cancel(order, customer) {
  order.status = "cancelled";
}`,
    trigger: 'Customer B cancels an order belonging to customer A.', terms: ['owner', 'customer', 'authoriz', 'cancel'],
    proof: '(()=>{const order={customerId:"A",status:"pending"};try{f(order,{id:"B"});}catch{}return order.status==="cancelled";})()',
  },
  {
    id: 'ship-cancelled', path: 'src/orders/shipping.js',
    contract: 'Only a paid order may transition to shipped. Cancelled orders must remain cancelled.',
    safe: `export function ship(order) {
  if (order.status !== "paid") throw new Error("order is not ready");
  order.status = "shipped";
}`,
    buggy: `export function ship(order) {
  if (order.status === "pending") throw new Error("order is not ready");
  order.status = "shipped";
}`,
    trigger: 'An order already cancelled is accepted for shipment.', terms: ['cancel', 'state', 'ship', 'paid'],
    proof: '(()=>{const order={status:"cancelled"};try{f(order);}catch{}return order.status==="shipped";})()',
  },
  {
    id: 'double-restock', path: 'src/orders/restock.js',
    contract: 'Sequential cancellation retries must restore inventory once for a reserved order.',
    safe: `export function cancel(order, inventory) {
  if (order.status === "cancelled") return;
  inventory.stock += order.quantity;
  order.status = "cancelled";
}`,
    buggy: `export function cancel(order, inventory) {
  inventory.stock += order.quantity;
  order.status = "cancelled";
}`,
    trigger: 'Retrying cancellation twice restores twice the reserved quantity.', terms: ['restock', 'retry', 'inventory', 'twice'],
    proof: '(()=>{const order={status:"reserved",quantity:2},inventory={stock:8};f(order,inventory);f(order,inventory);return inventory.stock!==10;})()',
  },
  {
    id: 'price-snapshot', path: 'src/orders/receipts.js',
    contract: 'A completed order receipt must use the unit price captured on each order line, even if the product catalog changes later.',
    safe: `export function receiptTotal(lines, catalog) {
  return lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
}`,
    buggy: `export function receiptTotal(lines, catalog) {
  return lines.reduce((sum, line) => sum + catalog[line.productId].priceCents * line.quantity, 0);
}`,
    trigger: 'Changing a catalog price retroactively changes a completed order receipt.', terms: ['snapshot', 'price', 'histor', 'receipt'],
    proof: 'f([{productId:"p1",unitPriceCents:500,quantity:2}],{p1:{priceCents:900}})!==1000',
  },
  {
    id: 'discount-floor', path: 'src/orders/totals.js',
    contract: 'A fixed-amount discount may reduce a subtotal to zero but must never create a negative payable amount.',
    safe: `export function payable(subtotalCents, discountCents) {
  return Math.max(0, subtotalCents - discountCents);
}`,
    buggy: `export function payable(subtotalCents, discountCents) {
  return subtotalCents - discountCents;
}`,
    trigger: 'A 1500-cent coupon applied to a 1000-cent subtotal creates a negative payable amount.', terms: ['discount', 'negative', 'zero', 'floor'],
    proof: 'f(1000,1500)<0',
  },
  {
    id: 'digital-shipping', path: 'src/orders/delivery.js',
    contract: 'Shipping is required if any line is a physical product. Only an entirely digital basket skips shipping.',
    safe: `export function needsShipping(lines) {
  return lines.some(line => !line.digital);
}`,
    buggy: `export function needsShipping(lines) {
  return !lines.some(line => line.digital);
}`,
    trigger: 'A mixed digital/physical basket skips shipping even though a physical item needs delivery.', terms: ['digital', 'physical', 'some', 'shipping'],
    proof: 'f([{digital:true},{digital:false}])!==true',
  },
  {
    id: 'create-retry', path: 'src/orders/create.js',
    contract: 'Sequential retries with the same client request key must return the original order rather than create another one.',
    safe: `export async function create(requestKey, orders, insert) {
  if (orders.has(requestKey)) return orders.get(requestKey);
  const order = await insert();
  orders.set(requestKey, order);
  return order;
}`,
    buggy: `export async function create(requestKey, orders, insert) {
  const order = await insert();
  orders.set(requestKey, order);
  return order;
}`,
    trigger: 'Retrying the same order-creation request creates two orders.', terms: ['retry', 'duplicate', 'request', 'idempot'],
    proof: '(async()=>{let inserts=0;const orders=new Map(),insert=async()=>({id:++inserts});await f("r1",orders,insert);await f("r1",orders,insert);return inserts!==1;})()',
  },
  {
    id: 'shipping-per-line', path: 'src/orders/summary.js',
    contract: 'shippingCents is charged once per order, independent of the number of lines. Each line already has totalCents.',
    safe: `export function total(lines, shippingCents) {
  return lines.reduce((sum, line) => sum + line.totalCents, 0) + shippingCents;
}`,
    buggy: `export function total(lines, shippingCents) {
  return lines.reduce((sum, line) => sum + line.totalCents + shippingCents, 0);
}`,
    trigger: 'An order containing two lines is charged the shipping fee twice.', terms: ['shipping', 'line', 'twice', 'total'],
    proof: 'f([{totalCents:500},{totalCents:700}],100)!==1300',
  },
  {
    id: 'partial-fulfillment', path: 'src/orders/fulfillment.js',
    contract: 'A warehouse event identifies one order line; other order lines must retain their existing fulfillment status.',
    safe: `export function fulfill(order, lineId) {
  for (const line of order.lines) {
    if (line.id === lineId) line.fulfilled = true;
  }
}`,
    buggy: `export function fulfill(order, lineId) {
  for (const line of order.lines) {
    line.fulfilled = true;
  }
}`,
    trigger: 'Fulfilling one line marks an unrelated unshipped line fulfilled.', terms: ['line', 'all', 'fulfill', 'partial'],
    proof: '(()=>{const order={lines:[{id:"a",fulfilled:false},{id:"b",fulfilled:false}]};f(order,"a");return order.lines[1].fulfilled;})()',
  },
]);
