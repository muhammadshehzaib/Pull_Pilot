const { defineDomain } = require('./support.cjs');
module.exports = defineDomain('products', [
  {
    id: 'variant-stock', path: 'src/products/availability.js',
    contract: 'Availability is determined by the selected variant, not aggregate product stock.',
    safe: `export function available(product, variantId) {
  const variant = product.variants.find(item => item.id === variantId);
  return !!variant && variant.stock > 0;
}`,
    buggy: `export function available(product, variantId) {
  return product.stock > 0;
}`,
    trigger: 'An out-of-stock size is offered because other sizes have stock.', terms: ['variant', 'stock', 'size'],
    proof: 'f({stock:10,variants:[{id:"large",stock:0},{id:"small",stock:10}]},"large")',
  },
  {
    id: 'variant-price', path: 'src/products/pricing.js',
    contract: 'Each selectable variant owns its own integer-cent price; checkout must use the selected variant price.',
    safe: `export function price(product, variantId) {
  const variant = product.variants.find(item => item.id === variantId);
  if (!variant) throw new Error("variant missing");
  return variant.priceCents;
}`,
    buggy: `export function price(product, variantId) {
  return product.priceCents;
}`,
    trigger: 'A premium variant is sold at the cheaper base product price.', terms: ['variant', 'price', 'base'],
    proof: 'f({priceCents:1000,variants:[{id:"premium",priceCents:2500}]},"premium")!==2500',
  },
  {
    id: 'zero-price-update', path: 'src/products/update.js',
    contract: 'An explicit priceCents=0 makes a product free. Only an omitted field should preserve the previous value.',
    safe: `export function update(product, patch) {
  if (patch.priceCents !== undefined) product.priceCents = patch.priceCents;
}`,
    buggy: `export function update(product, patch) {
  if (patch.priceCents) product.priceCents = patch.priceCents;
}`,
    trigger: 'Updating a paid product to zero silently preserves its old paid price.', terms: ['zero', '0', 'truth', 'price'],
    proof: '(()=>{const p={priceCents:1000};f(p,{priceCents:0});return p.priceCents!==0;})()',
  },
  {
    id: 'stale-cache', path: 'src/products/unpublish.js',
    contract: 'Unpublishing a product must invalidate the existing public cache entry before subsequent reads.',
    safe: `export function unpublish(product, cache) {
  product.published = false;
  cache.delete(product.id);
}`,
    buggy: `export function unpublish(product, cache) {
  product.published = false;
}`,
    trigger: 'The public cache continues serving an unpublished product.', terms: ['cache', 'invalid', 'stale', 'publish'],
    proof: '(()=>{const p={id:"p1",published:true},cache=new Map([["p1",{...p}]]);f(p,cache);return cache.get("p1")?.published===true;})()',
  },
  {
    id: 'soft-delete-filter', path: 'src/products/list.js',
    contract: 'Public product lists exclude rows whose deletedAt is non-null, even if published remains true.',
    safe: `export function list(products) {
  return products.filter(product => product.published && product.deletedAt === null);
}`,
    buggy: `export function list(products) {
  return products.filter(product => product.published);
}`,
    trigger: 'A soft-deleted product reappears in public catalog results.', terms: ['delet', 'filter', 'public'],
    proof: 'f([{id:"gone",published:true,deletedAt:"2026-01-01"}]).length!==0',
  },
  {
    id: 'draft-publication', path: 'src/products/publication.js',
    contract: 'Only products approved by moderation may be published. A draft has moderationStatus="pending".',
    safe: `export function publish(product) {
  if (product.moderationStatus !== "approved") throw new Error("approval required");
  product.published = true;
}`,
    buggy: `export function publish(product) {
  if (product.moderationStatus === "rejected") throw new Error("approval required");
  product.published = true;
}`,
    trigger: 'A pending draft is published without moderation approval.', terms: ['pending', 'approv', 'draft', 'publish'],
    proof: '(()=>{const p={moderationStatus:"pending",published:false};try{f(p);}catch{}return p.published;})()',
  },
  {
    id: 'literal-search', path: 'src/products/search.js',
    contract: 'User-entered catalog searches are literal case-sensitive substrings; regex metacharacters have no special meaning.',
    safe: `export function search(products, query) {
  return products.filter(product => product.name.includes(query));
}`,
    buggy: `export function search(products, query) {
  return products.filter(product => new RegExp(query).test(product.name));
}`,
    trigger: 'Searching for a.b incorrectly matches axb because unescaped input becomes a regex.', terms: ['regex', 'literal', 'escape', 'RegExp'],
    proof: 'f([{name:"axb"}],"a.b").length!==0',
  },
  {
    id: 'free-price-filter', path: 'src/products/filters.js',
    contract: 'maxCents is optional; maxCents=0 explicitly requests free products only. Product prices are nonnegative.',
    safe: `export function filter(products, maxCents) {
  return products.filter(product => maxCents === undefined || product.priceCents <= maxCents);
}`,
    buggy: `export function filter(products, maxCents) {
  return products.filter(product => !maxCents || product.priceCents <= maxCents);
}`,
    trigger: 'The free-products filter includes paid products because zero is treated as an absent limit.', terms: ['zero', 'free', 'maxCents', 'falsy'],
    proof: 'f([{priceCents:0},{priceCents:500}],0).length!==1',
  },
  {
    id: 'empty-stock', path: 'src/products/buy-button.js',
    contract: 'The buy button is enabled only when a product has at least one unit in stock.',
    safe: `export function canBuy(product) {
  return product.stock > 0;
}`,
    buggy: `export function canBuy(product) {
  return product.stock >= 0;
}`,
    trigger: 'A product with zero stock has an enabled buy button.', terms: ['zero', 'stock', 'bound', '0'],
    proof: 'f({stock:0})',
  },
  {
    id: 'tenant-sku', path: 'src/products/lookup.js', category: 'authorization',
    contract: 'SKU values are unique only within a tenant. Merchant lookups must match both SKU and authenticated tenant ID.',
    safe: `export function lookup(products, tenantId, sku) {
  return products.find(product => product.sku === sku && product.tenantId === tenantId);
}`,
    buggy: `export function lookup(products, tenantId, sku) {
  return products.find(product => product.sku === sku);
}`,
    trigger: 'Merchant B reads merchant A\'s product when their SKUs coincide.', terms: ['tenant', 'SKU', 'merchant', 'access'],
    proof: 'f([{sku:"SKU-1",tenantId:"A"},{sku:"SKU-1",tenantId:"B"}],"B","SKU-1").tenantId!=="B"',
  },
]);
