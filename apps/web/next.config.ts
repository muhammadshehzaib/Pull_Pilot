import type { NextConfig } from "next";

/**
 * Response security headers.
 *
 * These are set here rather than in deploy/nginx/*.conf on purpose:
 *   - they live in git and are reviewable/testable;
 *   - `certbot --nginx` rewrites server blocks and can drop hand-written
 *     `add_header` lines;
 *   - nginx `add_header` is NOT inherited into a `location` block that
 *     declares its own, which is an easy way to silently lose them.
 *
 * A nonce-based strict CSP is intentionally NOT used yet: per the Next docs,
 * nonces require a proxy/middleware that generates them AND force every page
 * to be dynamically rendered, which would cost the static rendering the site
 * currently benefits from. See the comment on script-src below.
 */

import { ANALYTICS_ORIGIN } from "./src/config/analytics";

const backendUrl =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

/**
 * The dashboard calls the API directly from the browser and opens a socket.io
 * WebSocket to the same origin (src/app/page.tsx). Both the http(s) and ws(s)
 * forms of the API origin must therefore be allowed by connect-src, otherwise
 * live updates and API reads break in the browser.
 */
const apiSources = (() => {
  try {
    const { protocol, host } = new URL(backendUrl);
    const httpScheme = protocol === "http:" ? "http" : "https";
    const wsScheme = httpScheme === "https" ? "wss" : "ws";
    return `${httpScheme}://${host} ${wsScheme}://${host}`;
  } catch {
    return "";
  }
})();

const isDev = process.env.NODE_ENV !== "production";

/**
 * The self-hosted analytics tracker is allowed only when the deployment
 * configures an https host for it. Both script-src (loading the tracker) and
 * connect-src (the beacon POST it sends back) must name that origin, or the
 * script loads and then reports nothing.
 */
const analyticsSrc = ANALYTICS_ORIGIN ? ` ${ANALYTICS_ORIGIN}` : "";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js emits the RSC flight payload as inline <script>, so 'unsafe-inline'
  // is required for hydration until a nonce-based policy is introduced.
  // This still blocks script loading from third-party origins, except the
  // configured analytics host.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${analyticsSrc}`,
  "style-src 'self' 'unsafe-inline'",
  // GitHub avatars are rendered from arbitrary user avatar hosts
  // (Sidebar.tsx), so img-src cannot use a tight allowlist.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${apiSources ? ` ${apiSources}` : ""}${analyticsSrc}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // HSTS and upgrade-insecure-requests are omitted in development so that
  // plain-http localhost is not upgraded or pinned to HTTPS.
  ...(isDev
    ? []
    : [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]),
];

const nextConfig: NextConfig = {
  // Slim self-contained server bundle for the Docker runtime image
  output: "standalone",
  // Do not advertise the framework: removes the X-Powered-By response header.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;