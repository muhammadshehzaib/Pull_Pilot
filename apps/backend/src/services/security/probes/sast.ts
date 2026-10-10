import { FindingSeverity } from '../../ai/finding-taxonomy';
import { collectAddedLines } from '../../diff-lines';
import {
  SecurityProbeResult,
  SecuritySuggestion,
  MAX_FINDINGS_PER_RULE,
  checkForProbe,
} from '../probe-types';

/**
 * Deterministic static-analysis probe.
 *
 * Each rule is a hand-written pattern — not a model opinion — matched against
 * every *added* line of the filtered diff. Rules deliberately aim for the
 * obvious anti-pattern (string-concatenated SQL, interpolated shell, unsafe
 * HTML sinks, credentials in URLs) because a false-free scanner that only
 * fires on the unambiguous cases is worth more than a noisy one that buries
 * the real findings.
 */

export interface SastRule {
  key: string;
  name: string;
  description: string;
  remediation: string;
  severity: FindingSeverity;
  /** Restrict to matching filenames; omit to check every file. */
  filePattern?: RegExp;
  /** Matched against a single added line (the leading `+` already stripped). */
  pattern: RegExp;
  /** Secondary check on the match aimed at cutting false positives. */
  validate?: (text: string, match: RegExpExecArray) => boolean;
}

const JS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PY = /\.py$/;
const ALL = undefined;

const SAST_RULES: SastRule[] = [
  /* ── SQL injection ─────────────────────────────────────────────────────── */
  {
    key: 'sast-sql-template-js',
    name: 'SQL injection via template literal',
    filePattern: JS,
    pattern: /\.(?:query|execute|exec|executemany|run|raw)\s*\(\s*`[^`]*\$\{/i,
    severity: 'CRITICAL',
    description: 'A query API receives a template literal that interpolates runtime values — classic SQL injection. An attacker who controls the interpolated value can alter the statement.',
    remediation: 'Use parameterised queries or a query builder that binds values (e.g. `WHERE id = $1` with a params array). Never concatenate or interpolate user input into SQL.',
  },
  {
    key: 'sast-sql-concat',
    name: 'SQL injection via string concatenation',
    filePattern: ALL,
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)[^"'`\n]*["'`]\s*\+|["'`]\s*\+\s*["'`]?\s*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)/i,
    severity: 'CRITICAL',
    description: 'A string containing SQL is assembled by concatenating runtime values. Anything the user controls becomes part of the statement.',
    remediation: 'Build the statement with bound parameters instead of splicing values into a SQL string.',
  },
  {
    key: 'sast-sql-python-fstring',
    name: 'SQL injection via f-string',
    filePattern: PY,
    pattern: /\.(?:execute|executemany|exec)\s*\(\s*f["'`][^"'`\n]*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)[^"'`\n]*\{|\bf["'`][^"'`\n]*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)[^"'`\n]*\{/i,
    severity: 'CRITICAL',
    description: 'SQL is built with an f-string that interpolates variables into the statement text — SQL injection.',
    remediation: 'Pass values as query parameters (e.g. psycopg `%s` placeholders with a params tuple) instead of formatting them into the SQL string.',
  },

  /* ── Command injection ─────────────────────────────────────────────────── */
  {
    key: 'sast-cmd-exec-template',
    name: 'Command execution with interpolated input',
    filePattern: JS,
    pattern: /\b(?:exec|execSync|execFile|spawn|system)\s*\(\s*`[^`]*\$\{/i,
    severity: 'CRITICAL',
    description: 'A shell command is built from a template literal with interpolated values. User-controlled text becomes shell syntax.',
    remediation: 'Pass arguments as a separate array (`spawn(cmd, [args])`) and avoid `shell: true`. Never build shell strings from input.',
  },
  {
    key: 'sast-cmd-exec-concat',
    name: 'Command execution via string concatenation',
    filePattern: JS,
    pattern: /\b(?:exec|execSync|execFile|spawn|system)\s*\(\s*["'`][^"'`\n]{2,}["'`]\s*\+/i,
    severity: 'CRITICAL',
    description: 'A command string is concatenated with runtime values — command injection if any value is user-influenced.',
    remediation: 'Use `execFile`/`spawn` with an argument array and no shell so arguments are never reinterpreted.',
  },
  {
    key: 'sast-cmd-python-shell',
    name: 'Command execution from a dynamic string',
    filePattern: PY,
    pattern: /\bos\.(?:system|popen)\s*\(\s*f?["'`][^"'`\n]{2,}(?:\{|\s*\+|\s*%)/i,
    severity: 'CRITICAL',
    description: 'os.system/os.popen receives a string assembled from runtime values — command injection.',
    remediation: 'Use subprocess with a list of arguments (`subprocess.run([...])`) and never `os.system` of a dynamic string.',
  },
  {
    key: 'sast-cmd-shell-true',
    name: 'subprocess with shell=True',
    filePattern: PY,
    pattern: /\.(?:Popen|call|run|check_call)\s*\(\s*[^)]*shell\s*=\s*True/i,
    severity: 'HIGH',
    description: 'subprocess is invoked with `shell=True`, turning the command into a shell invocation. Combined with any variable input this is command injection.',
    remediation: 'Drop `shell=True` and pass the command as an argument list so nothing is interpreted by a shell.',
  },
  {
    key: 'sast-eval-user-input',
    name: 'Code execution via eval',
    filePattern: ALL,
    pattern: /\beval\s*\(\s*`[^`]*\$\{|\beval\s*\(\s*(?:req|request|params|query|body|args|input|payload)\b|(?:eval|new\s+Function)\s*\(\s*`[^`]*\$\{/i,
    severity: 'CRITICAL',
    description: 'eval()/Function() runs a string that contains interpolated or request-derived content. If any of it is attacker-influenced the result is arbitrary code execution.',
    remediation: 'Replace eval with JSON.parse (data), switch on explicit values, or evaluate in a sandboxed VM — never eval user input.',
  },

  /* ── XSS ───────────────────────────────────────────────────────────────── */
  {
    key: 'sast-xss-innerhtml',
    name: 'XSS via innerHTML assignment',
    filePattern: JS,
    pattern: /\.innerHTML\s*=\s*(.*)/i,
    severity: 'HIGH',
    validate: (text, match) => isDynamicHtmlRhs(match, text),
    description: 'innerHTML is assigned a runtime expression rather than a constant string. If the value contains HTML output from user data, it is DOM XSS.',
    remediation: 'Use textContent, createElement + setting text props, or run the HTML through a sanitizer before assignment.',
  },
  {
    key: 'sast-xss-insertadjacent',
    name: 'XSS via insertAdjacentHTML',
    filePattern: JS,
    pattern: /\.insertAdjacentHTML\s*\([^)]*,\s*(.*)/i,
    severity: 'HIGH',
    validate: (text, match) => isDynamicHtmlRhs(match, text),
    description: 'insertAdjacentHTML receives a runtime-built HTML string, an XSS sink when it includes user data.',
    remediation: 'Insert text nodes, or sanitise the HTML (e.g. DOMPurify) before calling insertAdjacentHTML.',
  },
  {
    key: 'sast-xss-documentwrite',
    name: 'XSS via document.write',
    filePattern: JS,
    pattern: /document\.write\s*\(\s*(.*)/i,
    severity: 'HIGH',
    validate: (text, match) => isDynamicHtmlRhs(match, text),
    description: 'document.write is fed a dynamic value. User-controlled HTML here executes as mark-up in the caller\'s origin.',
    remediation: 'Render content through DOM APIs (textContent / createElement) or a server-escaped template.',
  },
  {
    key: 'sast-xss-react',
    name: 'dangerouslySetInnerHTML',
    filePattern: /\.(tsx|jsx)$/,
    pattern: /dangerouslySetInnerHTML\s*=\s*\{/i,
    severity: 'MEDIUM',
    description: 'dangerouslySetInnerHTML bypasses React\'s escaping. It is safe only when every interpolated value is server-sanitised.',
    remediation: 'Sanitise the HTML with a library (DOMPurify) or restructure to avoid raw HTML interpolation.',
  },
  {
    key: 'sast-xss-markup-binding',
    name: 'Raw HTML binding for a framework',
    filePattern: ALL,
    pattern: /\[\s*innerHTML\s*\]\s*=|v-html\s*=/i,
    severity: 'MEDIUM',
    description: 'A raw-HTML binding with (potentially) dynamic content. Angular `[innerHTML]` and Vue `v-html` do not escape their input.',
    remediation: 'Render text through the framework\'s text binding, or sanitise before assigning to an HTML binding.',
  },

  /* ── SSRF ──────────────────────────────────────────────────────────────── */
  {
    key: 'sast-ssrf-fetch-template',
    name: 'Server-side request to a runtime-built URL',
    filePattern: JS,
    pattern: /\.?(?:fetch|get|post|put|patch|request|download)\s*\(\s*`[^`]*\$\{/i,
    severity: 'HIGH',
    description: 'An HTTP client fetches a URL assembled from interpolated values. If the host portion is user-influenced this is server-side request forgery (SSRF).',
    remediation: 'Validate the URL: allow-list schemes/hosts, reject private ranges, and fetch only server-controlled URLs.',
  },
  {
    key: 'sast-ssrf-url-concat',
    name: 'HTTP client with a concatenated URL',
    filePattern: JS,
    pattern: /\.?(?:fetch|get|post|put|patch|request|download)\s*\(\s*["'`]https?:\/\/[^"'`\n]*["'`]\s*\+/i,
    severity: 'MEDIUM',
    description: 'A URL string is concatenated with runtime values before a request. At minimum this allows path/query control; if the host is included, SSRF.',
    remediation: 'Construct URLs via a validated base and reject user-controlled hosts or literal IP ranges.',
  },
  {
    key: 'sast-ssrf-python',
    name: 'SSRF via f-string request URL',
    filePattern: PY,
    pattern: /\b(?:requests\.(?:get|post|put|patch|request)|urlopen)\s*\(\s*f["'`][^"'`\n]*\{/i,
    severity: 'HIGH',
    description: 'An HTTP request URL is built with an f-string containing variables — potentially SSRF when the host is user-controlled.',
    remediation: 'Resolve the host server-side, validate against an allow-list, and block private/loopback ranges.',
  },

  /* ── Insecure authentication ───────────────────────────────────────────── */
  {
    key: 'sast-basic-auth-literal',
    name: 'Hardcoded HTTP Basic credentials',
    filePattern: ALL,
    pattern: /\b(?:Authorization|authorization|auth)\s*[=:]\s*["'][^"']*\bBasic\s+([A-Za-z0-9+/=]{8,})["']/i,
    severity: 'CRITICAL',
    validate: (_text, match) => {
      const token = match?.[1] ?? '';
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        return decoded.includes(':') && decoded.length >= 4;
      } catch {
        return false;
      }
    },
    description: 'Literal Basic-auth credentials (a base64 user:password pair) are embedded in source. Anyone with read access to the repo now has those credentials.',
    remediation: 'Move credentials to a secret store / environment and reference them at runtime; rotate the exposed credential immediately.',
  },
  {
    key: 'sast-trusted-client-role',
    name: 'Client-supplied identity headers trusted for authorization',
    filePattern: JS,
    pattern: /\.(?:headers|getHeader|header)[\[(]\s*["']([^"']+)["']/i,
    severity: 'MEDIUM',
    validate: (_text, match) => {
      const header = String(match?.[1] ?? '').toLowerCase();
      if (/user-?agent/.test(header)) return false;
      return /(?:role|admin|is[-_]?admin|user|account|tenant)/.test(header);
    },
    description: 'Code reads an identity- or role-carrying request header. If that value is trusted for authorization decisions, a client can escalate by sending the header — an authentication/authorization bug.',
    remediation: 'Derive identity and roles from the authenticated session, never from client-supplied headers.',
  },

  {
    key: 'sast-jwt-decode-without-verify',
    name: 'JWT decoded without signature verification',
    filePattern: JS,
    pattern: /\b(?:jwt|jsonwebtoken|jose)\.decode\s*\(/i,
    severity: 'HIGH',
    description: 'jsonwebtoken/jose decode() parses the token payload WITHOUT verifying its signature or claims. Authenticating a caller from a decoded-only token trusts forged tokens.',
    remediation: 'Use jwt.verify(token, key, { algorithms: [...] }) and act only on the verified payload; never treat decode() output as authenticated.',
  },

  /* ── Weak cryptography / transport ────────────────────────────────────── */
  {
    key: 'sast-jwt-alg-none',
    name: 'JWT accepts the none algorithm',
    filePattern: ALL,
    pattern: /(?:algorithm|alg)\s*[:=]\s*["'`]none["'`]/i,
    severity: 'CRITICAL',
    description: 'The JWT algorithm is configured as `none`, which can allow attackers to forge unsigned tokens if accepted by the verifier.',
    remediation: 'Require an explicit asymmetric or HMAC algorithm and pin the allowed algorithm on both signing and verification.',
  },
  {
    key: 'sast-tls-verification-disabled',
    name: 'TLS certificate verification disabled',
    filePattern: ALL,
    pattern: /(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|CERT_NONE|_create_unverified_context\s*\()/,
    severity: 'HIGH',
    description: 'TLS peer verification is disabled. Connections can be intercepted without the client detecting an invalid certificate.',
    remediation: 'Keep certificate verification enabled; install the correct CA certificate instead of bypassing validation.',
  },
  {
    key: 'sast-weak-hash',
    name: 'Weak cryptographic hash',
    filePattern: JS,
    pattern: /\bcreateHash\s*\(\s*["'`](?:md5|sha1)["'`]\s*\)/i,
    severity: 'MEDIUM',
    description: 'MD5 and SHA-1 are collision-broken and should not be used for security-sensitive integrity or signature operations.',
    remediation: 'Use SHA-256 or a stronger modern hash; use a password-hashing function such as Argon2id or scrypt for passwords.',
  },
  {
    key: 'sast-python-pickle-untrusted',
    name: 'Unsafe Python pickle deserialization',
    filePattern: PY,
    pattern: /\bpickle\.(?:loads?|Unpickler)\s*\(/,
    severity: 'HIGH',
    description: 'Python pickle can execute arbitrary code while deserializing. Loading attacker-controlled or tampered data can result in code execution.',
    remediation: 'Use a non-executable format such as JSON for untrusted data; authenticate trusted serialized data before loading it.',
  },

  /* ── Authorization bugs / open redirects ──────────────────────────────── */
  {
    key: 'sast-open-redirect-server',
    name: 'Server-side open redirect',
    filePattern: JS,
    pattern: /\.redirect\s*\(\s*(?:req|request)\./i,
    severity: 'MEDIUM',
    description: 'The redirect target comes straight from the request (query/body). An open redirect lets an attacker funnel users to phishing pages.',
    remediation: 'Resolve the target from a server-side allow-list; reject or neutralise caller-supplied URLs.',
  },
  {
    key: 'sast-location-user-input',
    name: 'Navigation to request-derived URL',
    filePattern: JS,
    pattern: /\blocation(?:\.href)?\s*=\s*[^;\n]*(?:req|request|query|params|body)\b/i,
    severity: 'MEDIUM',
    description: 'The page navigates to a URL taken from request input — client-side open redirect and a potential XSS vector (`javascript:` URLs).',
    remediation: 'Validate the target against an allow-list and reject `javascript:`/`data:` schemes.',
  },
  {
    key: 'sast-authz-request-role',
    name: 'Authorization decision from client-supplied role',
    filePattern: JS,
    pattern: /\b(?:if|while|return|\?|&&|\|\|)\s*\(?\s*(?:req|request)\.(?:body|query|params|headers)[^\n;)]*\b(?:admin|isAdmin|is_admin|role|permission|scope|privilege)\b/i,
    severity: 'HIGH',
    description: 'A control-flow decision (authorization) reads a role/admin field directly from the request. A client can set that field and grant itself privileges.',
    remediation: 'Derive the caller role from the authenticated session or a server-side store, and enforce authorization there — never from request parameters or headers.',
  },

  /* ── Unsafe file handling / path traversal ────────────────────────────── */
  {
    key: 'sast-path-traversal-concat',
    name: 'Path traversal via concatenated path',
    filePattern: ALL,
    pattern: /["'`][^"'`\n]*\.\.\/(?:\.\.\/)+[^"'`\n]*["'`]\s*\+|`[^`]*\.\.\/[^`]*\$\{/i,
    severity: 'HIGH',
    description: 'A path containing `../../` is concatenated with runtime values. Combined with unvalidated input this reads or writes files outside the intended directory.',
    remediation: 'Resolve paths against a fixed root and reject any path containing `..` segments before using it.',
  },
  {
    key: 'sast-fileop-request-path',
    name: 'File operation on a request-derived path',
    filePattern: JS,
    pattern: /\.(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|unlinkSync|appendFile|appendFileSync|rm|rmSync|stat|exists|existsSync)\s*\(\s*[^)]*\b(?:req|request|query|params|body)\.[^)]*/i,
    severity: 'HIGH',
    description: 'A filesystem API is called with a path constructed from request input — path traversal / arbitrary file read-write unless the input is validated.',
    remediation: 'Do not pass raw request values to file APIs; map identifiers to allow-listed paths inside a chrooted root.',
  },
  {
    key: 'sast-path-join-user-input',
    name: 'path.join/resolve with request-derived input',
    filePattern: JS,
    pattern: /\bpath\.(?:join|resolve)\s*\([^)]*\b(?:req|request|query|params|body)\.[^)]*/i,
    severity: 'HIGH',
    description: 'A path is joined/resolved from request-derived components. `..` segments in the input escape the intended directory.',
    remediation: 'Validate the input against an allow-list, or resolve and then confirm the result stays under the intended root.',
  },
];

function describeMatch(match: RegExpExecArray): string {
  const snippet = (match[0] ?? '').replace(/\s+/g, ' ').trim();
  return snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet;
}

/** A literal-string RHS (constant markup) is the only safe innerHTML-like use. */
function isDynamicHtmlRhs(match: RegExpExecArray | null, fallback: string): boolean {
  const rhs = String(match?.[1] ?? fallback)
    // Drop a trailing statement terminator / closing paren: the template
    // captures "..." ; or "...") as part of the RHS.
    .replace(/[;)\s]*$/, '')
    .trim();
  if (rhs.length === 0) return false;
  // Constant literal of any quote flavour — and template literals without
  // interpolation — are not eligible dynamic sinks.
  const literal = /^(["'`])[^"'`]*\1$/.test(rhs) || /^`[^`${]*`$/.test(rhs);
  return !literal;
}

/**
 * Runs every SAST rule against the added lines of a filtered diff.
 */
export function scanSast(diff: string): SecurityProbeResult {
  const findings: SecuritySuggestion[] = [];
  const counts = new Map<string, number>();

  for (const line of collectAddedLines(diff)) {
    for (const rule of SAST_RULES) {
      if (rule.filePattern && !rule.filePattern.test(line.filename)) continue;

      const match = rule.pattern.exec(line.text);
      if (!match) continue;
      if (rule.validate && !rule.validate(line.text, match)) continue;

      const hitCount = counts.get(rule.key) ?? 0;
      if (hitCount >= MAX_FINDINGS_PER_RULE) continue;
      counts.set(rule.key, hitCount + 1);

      const snippet = describeMatch(match);
      findings.push({
        filePath: line.filename,
        lineNumber: line.lineNumber,
        agentType: 'SECURITY',
        source: 'SAST',
        ruleKey: rule.key,
        issue: `${rule.name} — ${snippet || rule.description}`,
        suggestion: rule.remediation,
        priority: rule.severity,
      });
    }
  }

  return {
    findings,
    checks: [checkForProbe('SAST', 'sast', 'Static code security scan', findings.length)],
  };
}
