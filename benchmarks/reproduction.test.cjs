// Executes ONLY our own authored snippets with in-memory stubs. Never executes
// downloaded PR source, dependency installs, real shell commands or network calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fixtures = require('./seeded.cjs');

// Each expression returns true when the documented regression is observed.
const triggers = {
  'sql-interpolation': 'f({query:{id:"0 OR 1=1"}}, {query:(sql,args)=>!args && sql.includes("OR 1=1")})',
  'shell-interpolation': 'f({query:{directory:".; echo injected"}}, (command,args)=>!args && command.includes(";"))',
  'html-injection': '(() => {const el={}; f(el,{bio:"<img src=x onerror=alert(1)>"}); return !!el.innerHTML;})()',
  'dynamic-eval': '(() => {try{f({body:"globalThis.__benchmarkRan = true"});}catch{} return globalThis.__benchmarkRan === true;})()',
  'tls-verification': 'f({get:(_url,options)=>!options.rejectUnauthorized}, "https://example.test")',
  'jwt-verification': 'f({verify:()=>false,decode:()=>true},"forged","secret")',
  'wildcard-cors': '(() => {const headers={}; f({headers:{origin:"https://evil.test"}}, {setHeader:(k,v)=>headers[k]=v}); return headers["Access-Control-Allow-Origin"] === "https://evil.test";})()',
  'tenant-authorization': 'f({params:{id:1},auth:{tenantId:"B"}}, {invoice:{findFirst:q=>q.where.tenantId !== "B"}})',
  'admin-guard': 'f({role:"member"})',
  'path-traversal': '(() => {try{return f("../../etc/passwd", resolve, "/", x=>x)==="/etc/passwd";}catch{return false;}})()',
  'ssrf-host-check': '(() => {try{return f("http://127.0.0.1/?api.example.test",url=>url.hostname==="127.0.0.1");}catch{return false;}})()',
  'prototype-lookup': 'f([["__proto__",{injected:true}]]).injected === true',
  'pagination-offset': 'f(1,20)!==0',
  'inclusive-expiry': 'f(1000,1000)',
  'time-unit': 'f(Math.floor(Date.now()/1000)+3600)',
  'zero-default': 'f({retries:0})!==0',
  'numeric-sort': 'JSON.stringify(f([2,10]))!=="[2,10]"',
  'empty-reduce': '(() => {try{return f([])!==0;}catch{return true;}})()',
  'missing-return': 'f([{id:7}])[0]!==7',
  mutation: '(() => {const a=[{createdAt:1},{createdAt:2}]; f(a); return a[0].createdAt!==1;})()',
  'null-result': '(async()=>{try{return await f({findUser:async()=>null},1)!==null;}catch{return true;}})()',
  'string-addition': 'f({query:{quantity:"2",price:"10"}})!==12',
  'money-rounding': 'f(1.49)!==149',
  'range-bound': 'f(2,2)',
  'async-map': '(async()=>{const out=await f([1],async x=>x+1); return out[0]!==2;})()',
  'async-foreach': '(async()=>{const tasks=[]; const promise=f([1],()=>new Promise(resolve=>tasks.push(resolve))); let complete=false; promise.then(()=>complete=true); await Promise.resolve(); await Promise.resolve(); const early=complete; tasks.forEach(resolve=>resolve()); await promise; return early;})()',
  'missing-await': '(async()=>{try{return await f({},async()=>false,()=>true);}catch{return false;}})()',
  'swallowed-error': '(async()=>{try{return !!(await f({send:async()=>{throw Error("declined");}},1)).ok;}catch{return false;}})()',
  transaction: '(async()=>{let balance=10; const debit=async()=>{balance-=1;}; const credit=async()=>{throw Error("credit failed");}; const db={debit,credit,transaction:async cb=>{const old=balance;try{return await cb({debit,credit});}catch(e){balance=old;throw e;}}};try{await f(db,1,2,1);}catch{}return balance!==10;})()',
  oversell: '(async()=>{let stock=1;const db={reserveIfPositive:async()=>stock>0?(stock--,true):false,read:async()=>({stock}),write:async(_id,item)=>{stock=item.stock;}};const results=await Promise.all([f(db,1),f(db,1)]);return results.filter(Boolean).length>1;})()',
  'delete-scope': 'f({deleteMany:q=>Object.keys(q.where).length===0},7)',
  'cache-tenant-key': '(async()=>{const cache=new Map(),db={find:async tenant=>tenant};await f(cache,db,"A",1);return await f(cache,db,"B",1)!=="B";})()',
  'regex-state': 'f("alice")!==f("alice")',
  'utf8-byte-limit': 'f("éééééé")',
  'listener-leak': '(() => {const listeners=new Set(); const bus={on:(_n,handler)=>listeners.add(handler),off:(_n,handler)=>listeners.delete(handler)};const cleanup=f(bus,()=>{});cleanup();return listeners.size>0;})()',
  'timer-cleanup': '(() => {const cleanup=f(()=>{});cleanup();return globalThis.activeTimers>0;})()',
  'response-fallthrough': '(() => {let reached=false;f({}, {status(){return this;},end(){}},()=>reached=true);return reached;})()',
  'caller-contract': 'f({priceCents:2500})!==2500',
  'caller-async-contract': '!!f({role:"member"})',
  'infinite-loop': 'f([1,3],2)!==-1',
};

test('every authored bug has an executable reproduction', () => {
  assert.deepEqual(Object.keys(triggers).sort(), fixtures.map(f => f.id).sort());
});
for (const fixture of fixtures) {
  test(`${fixture.id}: safe passes and mutation reproduces`, async () => {
    for (const variant of ['safe', 'buggy']) {
      const functionName = /export (?:async )?function (\w+)/.exec(fixture[variant])[1];
      const context = { Buffer, URL, resolve: require('node:path').posix.resolve, activeTimers: 0 };
      const source = fixture[variant].replace(/\bexport /g, '') +
        '\nconst setInterval = () => (++globalThis.activeTimers); const clearInterval = () => (--globalThis.activeTimers);\n' +
        `const f = ${functionName};\n${triggers[fixture.id]}`;
      let observed;
      try { observed = await vm.runInNewContext(source, context, { timeout: 100 }); }
      catch (error) {
        if (fixture.id !== 'infinite-loop' || error.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error;
        observed = true;
      }
      assert.equal(observed, variant === 'buggy', `${fixture.id} ${variant}: unexpected trigger outcome`);
    }
  });
}
