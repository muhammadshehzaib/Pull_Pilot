// Original, authored fixtures. Neither the contracts nor answers are sent as ground truth.
// Each pair reviews a safe -> buggy change and the corresponding buggy -> fixed change.
const cases = [];
function add(id, category, contract, safe, buggy, trigger, terms, path = 'src/change.js', context = []) {
  cases.push({ id, category, contract, safe: safe + '\n', buggy: buggy + '\n', trigger, terms, path, context });
}
add('sql-interpolation', 'security', 'Look up a user by an untrusted request query parameter. db.query uses PostgreSQL parameter binding.',
  'export function lookup(req, db) {\n  return db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);\n}',
  'export function lookup(req, db) {\n  return db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);\n}',
  'id=0 OR 1=1 changes the SQL predicate.', ['SQL', 'inject']);
add('shell-interpolation', 'security', 'List an untrusted directory using node:child_process; the shell must not interpret its contents.',
  'export function list(req, execFile) {\n  return execFile("ls", ["--", req.query.directory]);\n}',
  'export function list(req, exec) {\n  return exec(`ls ${req.query.directory}`);\n}',
  'A directory containing shell metacharacters executes another command.', ['command', 'shell', 'inject']);
add('html-injection', 'security', 'Render untrusted profile text in a browser element.',
  'export function render(element, profile) {\n  element.textContent = profile.bio;\n}',
  'export function render(element, profile) {\n  element.innerHTML = profile.bio;\n}',
  'An attacker-controlled bio with an HTML event handler executes script.', ['XSS', 'HTML', 'script']);
add('dynamic-eval', 'security', 'Parse an untrusted request body containing a JSON object.',
  'export function parse(req) {\n  return JSON.parse(req.body);\n}',
  'export function parse(req) {\n  return eval("(" + req.body + ")");\n}',
  'Executable JavaScript in the body is evaluated.', ['eval', 'execution', 'inject']);
add('tls-verification', 'security', 'Connect to an external HTTPS server with certificate validation enabled.',
  'export function connect(https, url) {\n  return https.get(url, { rejectUnauthorized: true });\n}',
  'export function connect(https, url) {\n  return https.get(url, { rejectUnauthorized: false });\n}',
  'An untrusted server certificate is accepted, enabling interception.', ['certificate', 'TLS', 'rejectUnauthorized']);
add('jwt-verification', 'security', 'Authenticate a signed bearer JWT with the configured secret.',
  'export function authenticate(jwt, token, secret) {\n  return jwt.verify(token, secret);\n}',
  'export function authenticate(jwt, token, secret) {\n  return jwt.decode(token);\n}',
  'An attacker can forge an unsigned payload because signature verification is removed.', ['signature', 'verify', 'decode']);
add('wildcard-cors', 'security', 'Allow credentialed requests only from https://app.example.test. req.headers.origin is untrusted.',
  'export function cors(req, res) {\n  if (req.headers.origin === "https://app.example.test") res.setHeader("Access-Control-Allow-Origin", req.headers.origin);\n  res.setHeader("Access-Control-Allow-Credentials", "true");\n}',
  'export function cors(req, res) {\n  res.setHeader("Access-Control-Allow-Origin", req.headers.origin);\n  res.setHeader("Access-Control-Allow-Credentials", "true");\n}',
  'An arbitrary hostile origin receives permission to read credentialed responses.', ['origin', 'CORS', 'credential']);
add('tenant-authorization', 'authorization', 'Return an invoice only when it belongs to the authenticated tenant. db.invoice.findFirst matches every where field.',
  'export function invoice(req, db) {\n  return db.invoice.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });\n}',
  'export function invoice(req, db) {\n  return db.invoice.findFirst({ where: { id: req.params.id } });\n}',
  'Tenant B requests an invoice ID belonging to tenant A.', ['tenant', 'authorization', 'access']);
add('admin-guard', 'authorization', 'Only a signed-in administrator may delete users.',
  'export function allowed(user) {\n  return !!user && user.role === "admin";\n}',
  'export function allowed(user) {\n  return !!user || user.role === "admin";\n}',
  'Every signed-in non-admin is allowed; a missing user also throws.', ['admin', 'OR', 'authorization']);
add('path-traversal', 'security', 'Serve a user-selected file only inside /srv/uploads. resolve and sep are from node:path. readFile reads any supplied absolute path.',
  'export function download(name, resolve, sep, readFile) {\n  const root = resolve("/srv/uploads");\n  const target = resolve(root, name);\n  if (!target.startsWith(root + sep)) throw new Error("outside root");\n  return readFile(target);\n}',
  'export function download(name, resolve, sep, readFile) {\n  const root = resolve("/srv/uploads");\n  const target = resolve(root, name);\n  return readFile(target);\n}',
  'name=../../etc/passwd escapes the upload directory.', ['traversal', 'directory', 'root']);
add('ssrf-host-check', 'security', 'Fetch an untrusted URL only if its exact hostname is api.example.test. fetch follows no redirects.',
  'export function proxy(raw, fetch) {\n  const url = new URL(raw);\n  if (url.protocol !== "https:" || url.hostname !== "api.example.test") throw new Error("blocked");\n  return fetch(url, { redirect: "error" });\n}',
  'export function proxy(raw, fetch) {\n  const url = new URL(raw);\n  if (!raw.includes("api.example.test")) throw new Error("blocked");\n  return fetch(url, { redirect: "error" });\n}',
  'http://127.0.0.1/?api.example.test bypasses the substring check.', ['SSRF', 'hostname', 'substring']);
add('prototype-lookup', 'security', 'Copy only own enumerable keys into a dictionary without inheriting Object.prototype.',
  'export function dictionary(entries) {\n  const result = Object.create(null);\n  for (const [key, value] of entries) result[key] = value;\n  return result;\n}',
  'export function dictionary(entries) {\n  const result = {};\n  for (const [key, value] of entries) result[key] = value;\n  return result;\n}',
  'A __proto__ key changes the dictionary prototype; inherited keys become visible.', ['prototype', '__proto__', 'inherit']);
add('pagination-offset', 'correctness', 'Pages are one-based. Page 1 must have offset 0.',
  'export function offset(page, size) {\n  return (page - 1) * size;\n}',
  'export function offset(page, size) {\n  return page * size;\n}',
  'page=1,size=20 skips the first 20 records.', ['page', 'offset', 'first']);
add('inclusive-expiry', 'correctness', 'A token expires at expiresAt; time values are milliseconds.',
  'export function valid(now, expiresAt) {\n  return now < expiresAt;\n}',
  'export function valid(now, expiresAt) {\n  return now <= expiresAt;\n}',
  'now===expiresAt incorrectly accepts an expired token.', ['expire', 'boundary', 'equal']);
add('time-unit', 'correctness', 'JWT exp is Unix seconds. Date.now() returns milliseconds.',
  'export function expired(exp) {\n  return exp * 1000 <= Date.now();\n}',
  'export function expired(exp) {\n  return exp <= Date.now();\n}',
  'A future seconds-based expiry compares less than the current millisecond timestamp.', ['seconds', 'milliseconds', '1000']);
add('zero-default', 'correctness', 'A retry count of zero explicitly disables retries; only null/undefined should default to three.',
  'export function retries(config) {\n  return config.retries ?? 3;\n}',
  'export function retries(config) {\n  return config.retries || 3;\n}',
  'retries=0 becomes 3.', ['zero', '0', 'falsy']);
add('numeric-sort', 'correctness', 'Sort an array of finite numbers in ascending numeric order without mutating its input.',
  'export function sorted(values) {\n  return [...values].sort((a, b) => a - b);\n}',
  'export function sorted(values) {\n  return [...values].sort();\n}',
  '[2,10] becomes [10,2] due to lexicographic comparison.', ['sort', 'lexicographic', 'numeric']);
add('empty-reduce', 'correctness', 'Return the sum of an array, including zero for an empty array.',
  'export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}',
  'export function sum(values) {\n  return values.reduce((a, b) => a + b);\n}',
  'An empty array throws a TypeError.', ['empty', 'reduce', 'initial']);
add('missing-return', 'correctness', 'Return an array of user IDs.',
  'export function ids(users) {\n  return users.map(user => user.id);\n}',
  'export function ids(users) {\n  return users.map(user => { user.id; });\n}',
  'A nonempty user list produces undefined entries.', ['return', 'undefined', 'map']);
add('mutation', 'correctness', 'Return the newest record without modifying the caller-owned records array; records have numeric createdAt.',
  'export function newest(records) {\n  return [...records].sort((a, b) => b.createdAt - a.createdAt)[0];\n}',
  'export function newest(records) {\n  return records.sort((a, b) => b.createdAt - a.createdAt)[0];\n}',
  'The caller observes its records array reordered.', ['mutat', 'sort', 'original']);
add('null-result', 'correctness', 'db.findUser returns null when there is no user; missing users should return null.',
  'export async function name(db, id) {\n  const user = await db.findUser(id);\n  return user?.name ?? null;\n}',
  'export async function name(db, id) {\n  const user = await db.findUser(id);\n  return user.name;\n}',
  'An unknown user ID causes a null dereference.', ['null', 'missing', 'name']);
add('string-addition', 'correctness', 'HTTP quantity and price parameters contain valid numeric strings; return their numeric sum.',
  'export function total(req) {\n  return Number(req.query.quantity) + Number(req.query.price);\n}',
  'export function total(req) {\n  return req.query.quantity + req.query.price;\n}',
  'quantity="2",price="10" returns "210" instead of 12.', ['string', 'concaten', 'numeric']);
add('money-rounding', 'correctness', 'Convert a nonnegative dollar amount into integer cents rounded to the nearest cent.',
  'export function cents(dollars) {\n  return Math.round(dollars * 100);\n}',
  'export function cents(dollars) {\n  return Math.round(dollars) * 100;\n}',
  '1.49 becomes 100 cents rather than 149.', ['round', 'cents', 'precision']);
add('range-bound', 'correctness', 'An index is valid only in [0,length). Inputs are integers.',
  'export function validIndex(index, length) {\n  return index >= 0 && index < length;\n}',
  'export function validIndex(index, length) {\n  return index >= 0 && index <= length;\n}',
  'index===length is accepted even though it is past the last element.', ['bound', 'length', 'off-by-one']);
add('async-map', 'async', 'Save every item and resolve to an array of saved records only after all saves finish.',
  'export async function saveAll(items, save) {\n  return Promise.all(items.map(item => save(item)));\n}',
  'export async function saveAll(items, save) {\n  return items.map(item => save(item));\n}',
  'The function resolves to unresolved promises instead of saved records.', ['Promise.all', 'await', 'promises']);
add('async-foreach', 'async', 'Resolve only after every send finishes. send returns a promise.',
  'export async function sendAll(items, send) {\n  for (const item of items) await send(item);\n}',
  'export async function sendAll(items, send) {\n  items.forEach(async item => { await send(item); });\n}',
  'The outer function resolves before pending sends complete.', ['forEach', 'await', 'promise']);
add('missing-await', 'async', 'Check an asynchronous authorization function before removing a record.',
  'export async function remove(user, authorize, destroy) {\n  if (!(await authorize(user))) throw new Error("forbidden");\n  return destroy();\n}',
  'export async function remove(user, authorize, destroy) {\n  if (!authorize(user)) throw new Error("forbidden");\n  return destroy();\n}',
  'A promise resolving false is truthy, allowing an unauthorized deletion.', ['await', 'promise', 'authorization']);
add('swallowed-error', 'async', 'Reject failed transfers; callers rely on rejection to avoid marking an invoice paid.',
  'export async function transfer(bank, amount) {\n  return await bank.send(amount);\n}',
  'export async function transfer(bank, amount) {\n  try { return await bank.send(amount); } catch { return { ok: true }; }\n}',
  'A rejected bank transfer is reported as success.', ['error', 'success', 'swallow']);
add('transaction', 'data-integrity', 'Debit and credit must be atomic. db.transaction rolls back both updates if either fails.',
  'export function move(db, from, to, amount) {\n  return db.transaction(async tx => {\n    await tx.debit(from, amount);\n    await tx.credit(to, amount);\n  });\n}',
  'export async function move(db, from, to, amount) {\n  await db.debit(from, amount);\n  await db.credit(to, amount);\n}',
  'Credit failure leaves the debit committed.', ['atomic', 'transaction', 'debit']);
add('oversell', 'data-integrity', 'Reserve one item atomically only when stock is positive. db.reserveIfPositive is atomic; read/write calls are independent.',
  'export async function reserve(db, id) {\n  return db.reserveIfPositive(id);\n}',
  'export async function reserve(db, id) {\n  const item = await db.read(id);\n  if (item.stock <= 0) return false;\n  await db.write(id, { stock: item.stock - 1 });\n  return true;\n}',
  'Two concurrent requests both reserve the final item.', ['race', 'atomic', 'concurrent']);
add('delete-scope', 'data-integrity', 'Delete only the requested record. deleteMany({where:{}}) deletes every record.',
  'export function remove(db, id) {\n  return db.deleteMany({ where: { id } });\n}',
  'export function remove(db, id) {\n  return db.deleteMany({ where: {} });\n}',
  'Removing one ID deletes the entire table.', ['all', 'delete', 'where']);
add('cache-tenant-key', 'authorization', 'Invoice IDs are unique only inside a tenant. The shared cache is a Map.',
  'export async function invoice(cache, db, tenantId, id) {\n  const key = `${tenantId}:${id}`;\n  if (!cache.has(key)) cache.set(key, await db.find(tenantId, id));\n  return cache.get(key);\n}',
  'export async function invoice(cache, db, tenantId, id) {\n  const key = id;\n  if (!cache.has(key)) cache.set(key, await db.find(tenantId, id));\n  return cache.get(key);\n}',
  'Tenant B receives tenant A\'s cached invoice with the same local ID.', ['tenant', 'cache', 'key']);
add('regex-state', 'correctness', 'Every independent invocation must return true for an alphabetic username.',
  'const username = /^[a-z]+$/;\nexport function valid(value) {\n  return username.test(value);\n}',
  'const username = /^[a-z]+$/g;\nexport function valid(value) {\n  return username.test(value);\n}',
  'Two calls with "alice" alternate due to global RegExp.lastIndex.', ['lastIndex', 'global', 'state']);
add('utf8-byte-limit', 'correctness', 'Enforce a 10-byte UTF-8 request limit, not a UTF-16 character limit.',
  'export function allowed(body) {\n  return Buffer.byteLength(body, "utf8") <= 10;\n}',
  'export function allowed(body) {\n  return body.length <= 10;\n}',
  'Six non-ASCII two-byte characters bypass the byte limit.', ['byte', 'UTF', 'length']);
add('listener-leak', 'resource-management', 'Subscribe during a screen mount and return a cleanup callback that removes that same handler.',
  'export function mount(bus, handler) {\n  bus.on("update", handler);\n  return () => bus.off("update", handler);\n}',
  'export function mount(bus, handler) {\n  bus.on("update", handler);\n  return () => bus.off("update", () => handler());\n}',
  'Repeated mounts leave old handlers because cleanup passes a different function.', ['listener', 'reference', 'leak']);
add('timer-cleanup', 'resource-management', 'Stop a recurring poll when the screen unmounts.',
  'export function mount(poll) {\n  const timer = setInterval(poll, 1000);\n  return () => clearInterval(timer);\n}',
  'export function mount(poll) {\n  setInterval(poll, 1000);\n  return () => {};\n}',
  'Polling continues after unmount and accumulates on remount.', ['interval', 'cleanup', 'leak']);
add('response-fallthrough', 'correctness', 'An unauthorized request must send 401 and never call next().',
  'export function auth(req, res, next) {\n  if (!req.user) return res.status(401).end();\n  next();\n}',
  'export function auth(req, res, next) {\n  if (!req.user) res.status(401).end();\n  next();\n}',
  'An unauthorized request still reaches the protected next handler.', ['return', 'next', 'unauthoriz']);
add('caller-contract', 'cross-file', 'getPrice returns cents, as shown by its unchanged caller.',
  'export function getPrice(product) {\n  return product.priceCents;\n}',
  'export function getPrice(product) {\n  return product.priceCents / 100;\n}',
  'A $25 item gets charged 25 cents because the unchanged caller expects cents.', ['cents', 'caller', '100'], 'src/price.js',
  [{ path: 'src/checkout.js', content: 'import { getPrice } from "./price.js";\nexport function checkout(product, gateway) { return gateway.charge({ amountCents: getPrice(product) }); }\n' }]);
add('caller-async-contract', 'cross-file', 'isAllowed is called synchronously by the unchanged caller; converting it to async changes that contract.',
  'export function isAllowed(user) {\n  return user.role === "admin";\n}',
  'export async function isAllowed(user) {\n  return user.role === "admin";\n}',
  'The unchanged synchronous caller treats the returned promise as true for non-admins.', ['promise', 'async', 'caller'], 'src/permission.js',
  [{ path: 'src/delete.js', content: 'import { isAllowed } from "./permission.js";\nexport function remove(user, db) { if (!isAllowed(user)) throw new Error("denied"); return db.deleteAll(); }\n' }]);
add('infinite-loop', 'correctness', 'Search an integer-sorted array; return -1 for an absent value.',
  'export function search(values, target) {\n  let low = 0, high = values.length - 1;\n  while (low <= high) {\n    const mid = Math.floor((low + high) / 2);\n    if (values[mid] === target) return mid;\n    if (values[mid] < target) low = mid + 1; else high = mid - 1;\n  }\n  return -1;\n}',
  'export function search(values, target) {\n  let low = 0, high = values.length - 1;\n  while (low <= high) {\n    const mid = Math.floor((low + high) / 2);\n    if (values[mid] === target) return mid;\n    if (values[mid] < target) low = mid; else high = mid;\n  }\n  return -1;\n}',
  'search([1,3],2) never advances its bounds and hangs.', ['loop', 'mid', 'infinite']);
module.exports = cases;
