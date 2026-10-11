// A deliberately simple site password: set SITE_PASSWORD to require it (unset = open site).
// Logging in sets a cookie holding a hash of the password; the API and live feed check it.
// It keeps casual visitors out — it is not real account security.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const COOKIE = 'artmaker_auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const password = () => process.env.SITE_PASSWORD ?? '';
const tokenFor = (pw: string) => createHash('sha256').update(`artmaker:${pw}`).digest('hex');

export const authRequired = () => password().length > 0;

function same(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isAuthed(req: IncomingMessage): boolean {
  if (!authRequired()) return true;
  const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return !!cookie && same(cookie.slice(COOKIE.length + 1), tokenFor(password()));
}

export function checkPassword(attempt: unknown): boolean {
  return authRequired() && typeof attempt === 'string' && same(tokenFor(attempt), tokenFor(password()));
}

export function loginCookie(req: IncomingMessage): string {
  // behind Render's proxy the original scheme arrives in x-forwarded-proto
  const secure = req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${tokenFor(password())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}

export async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  return body;
}
