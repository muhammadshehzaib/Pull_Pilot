const { defineDomain } = require('./support.cjs');
module.exports = defineDomain('database', [
  {
    id: 'tenant-update', path: 'src/database/invoices.js', category: 'authorization',
    contract: 'Invoice IDs are tenant-local. Update exactly the invoice owned by the authenticated tenant.',
    safe: `export function markPaid(db, tenantId, id) {
  return db.prepare("UPDATE invoices SET paid = 1 WHERE tenant_id = ? AND id = ?").run(tenantId, id);
}`,
    buggy: `export function markPaid(db, tenantId, id) {
  return db.prepare("UPDATE invoices SET paid = 1 WHERE id = ?").run(id);
}`,
    trigger: 'Updating tenant B\'s local invoice ID also changes tenant A\'s invoice with the same ID.', terms: ['tenant', 'UPDATE', 'scope', 'invoice'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE invoices(tenant_id TEXT,id INTEGER,paid INTEGER,PRIMARY KEY(tenant_id,id)); INSERT INTO invoices VALUES (\'A\',1,0),(\'B\',1,0)");f(db,"B",1);return db.prepare("SELECT paid FROM invoices WHERE tenant_id=\'A\'").get().paid!==0;})()',
  },
  {
    id: 'rollback-boundary', path: 'src/database/transfers.js',
    contract: 'A transfer must update both account balances atomically. If the destination update fails, the debit must roll back.',
    safe: `export function transfer(db, fromId, toId, amount) {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(amount, fromId);
    db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(amount, toId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}`,
    buggy: `export function transfer(db, fromId, toId, amount) {
  db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(amount, fromId);
  db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(amount, toId);
}`,
    trigger: 'A destination balance constraint rejects credit after the source debit has already committed.', terms: ['transaction', 'rollback', 'atomic', 'debit'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE accounts(id INTEGER PRIMARY KEY,balance INTEGER CHECK(balance <= 100)); INSERT INTO accounts VALUES(1,100),(2,100)");try{f(db,1,2,10);}catch{}return db.prepare("SELECT balance FROM accounts WHERE id=1").get().balance!==100;})()',
  },
  {
    id: 'foreign-key-enforcement', path: 'src/database/connection.js',
    contract: 'Every new SQLite connection must enable foreign-key enforcement so order lines cannot reference nonexistent orders.',
    safe: `export function configure(db) {
  db.exec("PRAGMA foreign_keys = ON");
}`,
    buggy: `export function configure(db) {
  db.exec("PRAGMA foreign_keys = OFF");
}`,
    trigger: 'An orphan order line is inserted because connection-level foreign-key enforcement is disabled.', terms: ['foreign', 'constraint', 'PRAGMA', 'orphan'],
    proof: '(()=>{const db=makeDb();f(db);db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY); CREATE TABLE lines(order_id INTEGER REFERENCES orders(id))");try{db.exec("INSERT INTO lines VALUES(999)");}catch{}return db.prepare("SELECT COUNT(*) AS n FROM lines").get().n!==0;})()',
  },
  {
    id: 'lost-update', path: 'src/database/wallet.js',
    contract: 'A stale wallet update must fail rather than overwrite a newer balance. A successful debit increments version and returns true.',
    safe: `export function debit(db, snapshot, amount) {
  const result = db.prepare("UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ? AND version = ?")
    .run(snapshot.balance - amount, snapshot.id, snapshot.version);
  return result.changes === 1;
}`,
    buggy: `export function debit(db, snapshot, amount) {
  const result = db.prepare("UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?")
    .run(snapshot.balance - amount, snapshot.id);
  return result.changes === 1;
}`,
    trigger: 'Two debits using the same snapshot both report success, but the second overwrites the first balance update.', terms: ['version', 'stale', 'lost', 'optimistic'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE wallets(id INTEGER PRIMARY KEY,balance INTEGER,version INTEGER);INSERT INTO wallets VALUES(1,100,0)");const snapshot=db.prepare("SELECT * FROM wallets").get();const first=f(db,snapshot,10),second=f(db,snapshot,20);return first&&second&&db.prepare("SELECT balance FROM wallets").get().balance!==70;})()',
  },
  {
    id: 'null-predicate', path: 'src/database/active-products.js',
    contract: 'Return active products whose deleted_at column is SQL NULL.',
    safe: `export function activeProducts(db) {
  return db.prepare("SELECT id FROM products WHERE deleted_at IS NULL").all();
}`,
    buggy: `export function activeProducts(db) {
  return db.prepare("SELECT id FROM products WHERE deleted_at = NULL").all();
}`,
    trigger: 'Comparing with = NULL hides every active product because SQL NULL is not equal to itself.', terms: ['NULL', 'IS', 'SQL', 'predicate'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE products(id INTEGER PRIMARY KEY,deleted_at TEXT);INSERT INTO products VALUES(1,NULL),(2,\'2026-01-01\')");return f(db).length!==1;})()',
  },
  {
    id: 'unscoped-delete', path: 'src/database/sessions.js',
    contract: 'Logging out one user must delete only that user\'s sessions.',
    safe: `export function logout(db, userId) {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}`,
    buggy: `export function logout(db, userId) {
  return db.prepare("DELETE FROM sessions").run();
}`,
    trigger: 'Logging out one user deletes every user\'s session.', terms: ['DELETE', 'WHERE', 'all', 'session'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE sessions(user_id TEXT);INSERT INTO sessions VALUES(\'A\'),(\'B\')");f(db,"A");return db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=\'B\'").get().n!==1;})()',
  },
  {
    id: 'cursor-tie', path: 'src/database/order-page.js',
    contract: 'Paginate orders by ascending (created_at,id). Cursor timestamps may tie; the next page must include later IDs at the same timestamp.',
    safe: `export function nextPage(db, createdAt, id) {
  return db.prepare("SELECT id FROM orders WHERE (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT 10").all(createdAt, id);
}`,
    buggy: `export function nextPage(db, createdAt, id) {
  return db.prepare("SELECT id FROM orders WHERE created_at > ? ORDER BY created_at, id LIMIT 10").all(createdAt);
}`,
    trigger: 'An order sharing the cursor timestamp is skipped permanently because the tie-breaking ID is omitted.', terms: ['cursor', 'tie', 'timestamp', 'skip'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY,created_at INTEGER);INSERT INTO orders VALUES(1,100),(2,100),(3,101)");return JSON.stringify(f(db,100,1).map(r=>r.id))!=="[2,3]";})()',
  },
  {
    id: 'case-insensitive-uniqueness', path: 'src/database/users-schema.js',
    contract: 'Email addresses are case-insensitive account identifiers and must be unique regardless of letter case.',
    safe: `export function createUsers(db) {
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE UNIQUE NOT NULL)");
}`,
    buggy: `export function createUsers(db) {
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL)");
}`,
    trigger: 'Alice@example.test and alice@example.test create two accounts for the same case-insensitive identity.', terms: ['case', 'unique', 'email', 'collat'],
    proof: '(()=>{const db=makeDb();f(db);db.prepare("INSERT INTO users(email) VALUES(?)").run("Alice@example.test");try{db.prepare("INSERT INTO users(email) VALUES(?)").run("alice@example.test");}catch{}return db.prepare("SELECT COUNT(*) AS n FROM users").get().n!==1;})()',
  },
  {
    id: 'sql-parameter-binding', path: 'src/database/customer-search.js', category: 'security',
    contract: 'Search by an untrusted exact email address using bound SQL parameters.',
    safe: `export function search(db, email) {
  return db.prepare("SELECT id FROM customers WHERE email = ?").all(email);
}`,
    buggy: 'export function search(db, email) {\n  return db.prepare(`SELECT id FROM customers WHERE email = \'${email}\'`).all();\n}',
    trigger: 'An email containing a quote and OR 1=1 changes the SQL predicate and returns other customers.', terms: ['SQL', 'inject', 'parameter', 'email'],
    proof: '(()=>{const db=makeDb();db.exec("CREATE TABLE customers(id INTEGER PRIMARY KEY,email TEXT);INSERT INTO customers VALUES(1,\'a@example.test\'),(2,\'b@example.test\')");return f(db,"\' OR 1=1 --").length!==0;})()',
  },
  {
    id: 'cascade-delete', path: 'src/database/order-schema.js',
    contract: 'Deleting an order must delete its dependent lines; foreign-key enforcement is already enabled.',
    safe: `export function createLines(db) {
  db.exec("CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE)");
}`,
    buggy: `export function createLines(db) {
  db.exec("CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL)");
}`,
    trigger: 'Deleting an order leaves detached order lines instead of deleting them.', terms: ['CASCADE', 'delete', 'line', 'NULL'],
    proof: '(()=>{const db=makeDb();db.exec("PRAGMA foreign_keys=ON;CREATE TABLE orders(id INTEGER PRIMARY KEY);INSERT INTO orders VALUES(1)");f(db);db.exec("INSERT INTO lines VALUES(1,1);DELETE FROM orders WHERE id=1");return db.prepare("SELECT COUNT(*) AS n FROM lines").get().n!==0;})()',
  },
]);
