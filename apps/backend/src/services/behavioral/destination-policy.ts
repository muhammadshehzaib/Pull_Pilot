import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { LIMITS } from './contracts';

export function previewHost(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) || /\.(?:local|localhost|internal|test|invalid|onion)$/.test(value)) throw new Error('Use an exact public DNS preview host');
  return value;
}
export function validateDestination(value: string, host: string): URL {
  previewHost(host);
  const url = new URL(value);
  if (value.length > 2048 || url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash) throw new Error('Destination is outside the approved HTTPS preview');
  return url;
}
export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    // Reject every reserved, private, mapped-private, loopback, link-local,
    // multicast and transition range, including NAT64 and 6to4.
    return ip.range() === 'unicast';
  } catch { return false; }
}
export async function resolvePublic(host: string, resolver = lookup): Promise<{ address: string; family: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    resolver(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timed out')), 2000); }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Preview DNS includes a non-public address');
  return addresses[0];
}
/** Single hop only. Browser redirects are intercepted as new requests and checked again. */
export async function fetchPreview(value: string, host: string, budget: { requests: number; bytes: number }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const url = validateDestination(value, host);
  if (++budget.requests > LIMITS.requests || budget.bytes >= LIMITS.totalBytes) throw new Error('Network budget exhausted');
  const pinned = await resolvePublic(host);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', agent: false, headers: { Accept: '*/*', 'Accept-Encoding': 'identity' }, lookup: (_host, _options, callback: any) => callback(null, pinned.address, pinned.family) }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length; budget.bytes += chunk.length;
        if (size > LIMITS.responseBytes || budget.bytes > LIMITS.totalBytes) { response.destroy(); req.destroy(new Error('Response budget exhausted')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers: Record<string, string> = {};
        // Never relay Set-Cookie, authentication, reporting, refresh or arbitrary headers.
        if (response.headers['content-type']) headers['content-type'] = response.headers['content-type'];
        if (response.headers.location) {
          try { headers.location = validateDestination(new URL(response.headers.location, url).href, host).href; }
          catch { reject(new Error('Unsafe redirect')); return; }
        }
        headers['content-security-policy'] = "default-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
        resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks).toString('base64') });
      });
    });
    // Hard wall-clock deadline includes stalled streams; independent of idle timeout.
    const timer = setTimeout(() => req.destroy(new Error('Preview request timed out')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}
