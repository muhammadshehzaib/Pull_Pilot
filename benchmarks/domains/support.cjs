const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function defineDomain(domain, definitions) {
  return definitions.map(item => ({ ...item, id: `${domain}-${item.id}`, domain,
    category: item.category || domain, context: item.context || [],
    safe: item.safe.trim() + '\n', buggy: item.buggy.trim() + '\n',
  }));
}

function loadDomains() {
  return fs.readdirSync(__dirname).filter(name => name.endsWith('.fixtures.cjs')).sort()
    .flatMap(name => require(path.join(__dirname, name)));
}

async function reproduce(item, variant) {
  const databases = [];
  const context = { Buffer, URL, structuredClone,
    makeDb() {
      // Only authored database proofs can call this. No customer connection is used.
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:'); databases.push(db); return db;
    },
  };
  const name = /export (?:async )?function (\w+)/.exec(item[variant])?.[1];
  if (!name || typeof item.proof !== 'string') throw new Error(`Missing executable proof for ${item.id}`);
  const source = item[variant].replace(/\bexport /g, '') + `\nconst f = ${name};\n${item.proof}`;
  let timer;
  try {
    const result = vm.runInNewContext(source, context, { timeout: 250 });
    return await Promise.race([Promise.resolve(result), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Async proof timed out: ${item.id}`)), 2000);
    })]);
  } finally {
    clearTimeout(timer);
    for (const db of databases) db.close();
  }
}
module.exports = { defineDomain, loadDomains, reproduce };
