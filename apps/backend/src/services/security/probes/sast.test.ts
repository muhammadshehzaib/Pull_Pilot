import { describe, it, expect } from 'vitest';
import { scanSast } from './sast';

function diffWith(filename: string, addedLines: string[]): string {
  const body = addedLines.map((l) => `+${l}`).join('\n');
  return (
    `diff --git a/${filename} b/${filename}\n` +
    `--- a/${filename}\n` +
    `+++ b/${filename}\n` +
    '@@ -1,1 +1,1 @@\n' +
    ' context\n' +
    body
  );
}

function keys(diff: string): string[] {
  return scanSast(diff).findings.map((f) => f.ruleKey);
}

describe('SAST probe — additional cryptography and deserialization checks', () => {
  it('flags JWT none algorithm configuration', () => {
    expect(keys(diffWith('src/auth.ts', ['const options = { algorithm: "none" };']))).toContain('sast-jwt-alg-none');
  });

  it('flags disabled TLS peer verification', () => {
    expect(keys(diffWith('src/client.ts', ['const agent = new https.Agent({ rejectUnauthorized: false });']))).toContain('sast-tls-verification-disabled');
  });

  it('flags weak Node hash algorithms', () => {
    expect(keys(diffWith('src/hash.ts', ["createHash('md5')"])) ).toContain('sast-weak-hash');
  });

  it('flags Python pickle deserialization', () => {
    expect(keys(diffWith('src/cache.py', ['pickle.loads(payload)']))).toContain('sast-python-pickle-untrusted');
  });
});

describe('SAST probe — SQL injection', () => {
  it('flags a template-literal query in JS/TS', () => {
    const diff = diffWith('src/db.ts', ['db.query(`SELECT * FROM users WHERE id = ${id}`);']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-sql-template-js');
    expect(f.priority).toBe('CRITICAL');
    expect(f.lineNumber).toBe(2);
  });

  it('flags a concatenated SQL string with a runtime value', () => {
    const diff = diffWith('src/db.ts', ['db.query("SELECT * FROM users WHERE id = " + req.params.id);']);
    expect(keys(diff)).toContain('sast-sql-concat');
  });

  it('does NOT flag a parameterised query', () => {
    const diff = diffWith('src/db.ts', ['db.query("SELECT * FROM users WHERE id = ?", [id]);']);
    expect(keys(diff)).not.toContain('sast-sql-concat');
  });

  it('flags an f-string SQL query in Python', () => {
    const diff = diffWith('server/app.py', ['cursor.execute(f"SELECT * FROM users WHERE id = {uid}")']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-sql-python-fstring');
    expect(f.priority).toBe('CRITICAL');
  });
});

describe('SAST probe — command injection', () => {
  it('flags interpolated exec in JS/TS', () => {
    const diff = diffWith('server/util.ts', ['exec(`git pull ${branch}`);']);
    expect(keys(diff)).toContain('sast-cmd-exec-template');
  });

  it('flags concatenated exec in JS/TS', () => {
    const diff = diffWith('server/util.ts', ["exec('git pull ' + branch);"]);
    expect(keys(diff)).toContain('sast-cmd-exec-concat');
  });

  it('flags os.system with a dynamic string', () => {
    const diff = diffWith('tools/clean.py', ['os.system(f"rm -rf {path}")']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-cmd-python-shell');
    expect(f.priority).toBe('CRITICAL');
  });

  it('flags subprocess with shell=True', () => {
    const diff = diffWith('tools/run.py', ['subprocess.run(cmd, shell=True)']);
    expect(keys(diff)).toContain('sast-cmd-shell-true');
  });

  it('flags eval of request input', () => {
    const diff = diffWith('server/mw.ts', ['eval(req.body.code);']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-eval-user-input');
    expect(f.priority).toBe('CRITICAL');
  });
});

describe('SAST probe — XSS sinks', () => {
  it('flags dynamic innerHTML assignment', () => {
    const diff = diffWith('web/chat.ts', ['el.innerHTML = userMessage;']);
    expect(keys(diff)).toContain('sast-xss-innerhtml');
  });

  it('does NOT flag a constant innerHTML assignment', () => {
    const diff = diffWith('web/chat.ts', ['el.innerHTML = "static markup";']);
    expect(keys(diff)).not.toContain('sast-xss-innerhtml');
  });

  it('flags insertAdjacentHTML with a runtime value', () => {
    const diff = diffWith('web/list.ts', ['list.insertAdjacentHTML("beforeend", rowHtml);']);
    expect(keys(diff)).toContain('sast-xss-insertadjacent');
  });

  it('flags document.write with a runtime value', () => {
    const diff = diffWith('web/app.ts', ['document.write(location.hash);']);
    expect(keys(diff)).toContain('sast-xss-documentwrite');
  });

  it('flags dangerouslySetInnerHTML in React and v-html / [innerHTML] bindings elsewhere', () => {
    expect(keys(diffWith('web/App.tsx', ['<div dangerouslySetInnerHTML={{ __html: html }} />']))).toContain('sast-xss-react');
    expect(keys(diffWith('web/App.vue', ['<div v-html="userHtml"></div>']))).toContain('sast-xss-markup-binding');
  });

  it('does not run JS-only XSS rules against Python files', () => {
    const diff = diffWith('web/view.py', ['element.innerHTML = userHtml']);
    expect(keys(diff).filter((k) => k.startsWith('sast-xss'))).toEqual([]);
  });
});

describe('SAST probe — SSRF', () => {
  it('flags a fetch to an interpolated URL', () => {
    const diff = diffWith('api/client.ts', ['fetch(`https://api.x/${org}/repos`);']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-ssrf-fetch-template');
    expect(f.priority).toBe('HIGH');
  });

  it('flags concatenated http-client URL', () => {
    const diff = diffWith('api/client.ts', ['request("https://host/api/" + path);']);
    expect(keys(diff)).toContain('sast-ssrf-url-concat');
  });

  it('flags f-string request URL in Python', () => {
    const diff = diffWith('api/client.py', ['requests.get(f"https://{host}/data")']);
    expect(keys(diff)).toContain('sast-ssrf-python');
  });
});

describe('SAST probe — auth & authz', () => {
  it('flags literal Basic auth whose base64 decodes to user:pass', () => {
    const diff = diffWith('api/client.ts', ['authorization: "Basic dXNlcjpwYXNzd29yZA=="']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-basic-auth-literal');
    expect(f.priority).toBe('CRITICAL');
  });

  it('does NOT flag Basic auth that is not a user:pass pair', () => {
    const diff = diffWith('api/client.ts', ['authorization: "Basic bm90Y29sb24="']); // "notcolon"
    expect(keys(diff)).not.toContain('sast-basic-auth-literal');
  });

  it('flags trusting a client-provided role header', () => {
    const diff = diffWith('app/auth.ts', ['req.headers["x-user-role"];']);
    const f = keys(diff);
    expect(f).toContain('sast-trusted-client-role');
  });

  it('ignores headers unrelated to identity', () => {
    const diff = diffWith('app/auth.ts', ['req.headers["user-agent"];']);
    expect(keys(diff)).not.toContain('sast-trusted-client-role');
  });

  it('flags JWT decoded without signature verification', () => {
    const diff = diffWith('app/auth.ts', ['const claims = jwt.decode(token);']);
    const f = scanSast(diff).findings[0];
    expect(f.ruleKey).toBe('sast-jwt-decode-without-verify');
    expect(f.priority).toBe('HIGH');
  });

  it('does NOT flag JWT verification', () => {
    const diff = diffWith('app/auth.ts', ['const claims = jwt.verify(token, key);']);
    expect(keys(diff)).not.toContain('sast-jwt-decode-without-verify');
  });

  it('flags an authorization decision from a client-supplied role', () => {
    const diff = diffWith('app/mw.ts', ["if (req.body.role === 'admin') grantAccess();"]);
    const f = keys(diff);
    expect(f).toContain('sast-authz-request-role');
  });

  it('does NOT flag reading a role header outside an authorization decision', () => {
    const diff = diffWith('app/mw.ts', ['const role = req.body.role;']);
    expect(keys(diff)).not.toContain('sast-authz-request-role');
  });

  it('flags server-side open redirect', () => {
    const diff = diffWith('app/web.ts', ['res.redirect(req.query.next);']);
    expect(keys(diff)).toContain('sast-open-redirect-server');
  });
});

describe('SAST probe — unsafe file handling', () => {
  it('flags a filesystem call on a request-derived path', () => {
    const diff = diffWith('api/files.ts', ['fs.readFileSync("/srv/" + req.params.file);']);
    const f = keys(diff);
    expect(f).toContain('sast-fileop-request-path');
  });

  it('flags path.join with request input', () => {
    const diff = diffWith('api/files.ts', ['path.join(ROOT, req.body.name);']);
    expect(keys(diff)).toContain('sast-path-join-user-input');
  });

  it('flags a concatenated path containing ..', () => {
    const diff = diffWith('api/files.py', ['open("/data/../../etc/passwd" + name, "r")']);
    expect(keys(diff)).toContain('sast-path-traversal-concat');
  });
});

describe('SAST probe — provenance metadata', () => {
  it('stamps findings with source SAST and agentType SECURITY', () => {
    const diff = diffWith('src/db.ts', ['db.query(`SELECT 1 WHERE x = ${y}`);']);
    const f = scanSast(diff).findings[0];
    expect(f.source).toBe('SAST');
    expect(f.agentType).toBe('SECURITY');
    expect(f.issue).toContain('SQL injection');
  });
});
