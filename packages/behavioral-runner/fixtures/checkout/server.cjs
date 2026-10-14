// Disposable reference application, never a production authentication endpoint.
const http = require('node:http');
const { execFile } = require('node:child_process');
if (process.env.AIPR_SANDBOX !== '1' || process.env.PAYMENT_MODE !== 'sandbox') throw new Error('Sandbox only');
const sql = query => new Promise((resolve, reject) => execFile('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-tAc', query], { timeout: 2000 }, (e, out) => e ? reject(new Error('Database unavailable')) : resolve(out.trim())));
const page = require('node:fs').readFileSync(require('node:path').join(__dirname, 'checkout.html'), 'utf8');
async function main() {
  await sql('CREATE TABLE IF NOT EXISTS customers(id uuid PRIMARY KEY); CREATE TABLE IF NOT EXISTS orders(customer_id uuid PRIMARY KEY REFERENCES customers(id), payment_mode text NOT NULL);');
  http.createServer(async (req, res) => {
    try {
      const customer = /(?:^|; )aipr_session=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
      if (req.method === 'POST' && req.url === '/__aipr/session') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1000) throw new Error(); }
        const fixture = JSON.parse(body);
        if (fixture.fixture !== 'CUSTOMER' || !/^[a-f0-9-]{36}$/.test(fixture.namespace)) throw new Error();
        await sql(`INSERT INTO customers VALUES ('${fixture.namespace}') ON CONFLICT DO NOTHING;`);
        res.setHeader('Set-Cookie', `aipr_session=${fixture.namespace}; HttpOnly; Path=/; SameSite=Strict`);
        res.end('{}'); return;
      }
      if (!customer) { res.writeHead(401); res.end(); return; }
      if (req.method === 'POST' && req.url === '/orders') {
        // Fixed synthetic customer and one checkout key: a repeated submission
        // must create exactly one order. No gateway or real payment is involved.
        await sql(`INSERT INTO orders VALUES ('${customer}', 'mock') ON CONFLICT DO NOTHING;`);
        res.end('{}'); return;
      }
      if (req.method === 'GET' && req.url === '/__aipr/state') {
        const count = Number(await sql(`SELECT count(*) FROM orders WHERE customer_id='${customer}';`));
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ orderCount: count })); return;
      }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  }).listen(Number(process.env.PORT), '0.0.0.0');
}
main().catch(() => process.exit(1));
