// VAPID push notification logic — runs in Cloudflare Workers context (Web Crypto API)

export interface Env {
  PUSH_SUBSCRIPTIONS: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string; // JSON-stringified JWK of EC P-256 private key
}

interface StoredSub {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  hour: number;
  utcOffsetMinutes: number;
}

// --------------- base64url helpers ---------------

function b64urlFromBuffer(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function strToB64url(str: string): string {
  return b64urlFromBuffer(new TextEncoder().encode(str));
}

// --------------- VAPID JWT signing ---------------

async function signVapidJwt(privateKeyJwk: JsonWebKey, audience: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = strToB64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = strToB64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: 'mailto:logis-push@noreply.local',
    }),
  );
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return `${header}.${payload}.${b64urlFromBuffer(sig)}`;
}

// --------------- KV key helper ---------------

async function kvKeyForEndpoint(endpoint: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return b64urlFromBuffer(buf).slice(0, 32);
}

// --------------- Send one push ---------------

async function sendOnePush(stored: StoredSub, env: Env): Promise<void> {
  const endpoint = stored.subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const privateKeyJwk: JsonWebKey = JSON.parse(env.VAPID_PRIVATE_KEY);
  const jwt = await signVapidJwt(privateKeyJwk, audience);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      TTL: '86400',
      Urgency: 'normal',
      'Content-Length': '0',
    },
  });

  // 410 Gone = subscription expired, clean it up
  if (resp.status === 410) {
    const key = await kvKeyForEndpoint(endpoint);
    await env.PUSH_SUBSCRIPTIONS.delete(key);
  }
}

// --------------- Public API ---------------

export async function storeSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  hour: number,
  utcOffsetMinutes: number,
  env: Env,
): Promise<void> {
  const key = await kvKeyForEndpoint(sub.endpoint);
  const value: StoredSub = { subscription: sub, hour, utcOffsetMinutes };
  await env.PUSH_SUBSCRIPTIONS.put(key, JSON.stringify(value));
}

export async function removeSubscription(endpoint: string, env: Env): Promise<void> {
  const key = await kvKeyForEndpoint(endpoint);
  await env.PUSH_SUBSCRIPTIONS.delete(key);
}

export async function sendScheduledPush(env: Env): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.PUSH_SUBSCRIPTIONS) return;

  const nowUtcHour = new Date().getUTCHours();
  const { keys } = await env.PUSH_SUBSCRIPTIONS.list();

  await Promise.allSettled(
    keys.map(async ({ name }) => {
      const raw = await env.PUSH_SUBSCRIPTIONS.get(name);
      if (!raw) return;
      const stored: StoredSub = JSON.parse(raw);

      // Compute the subscriber's local hour
      const localHour = ((nowUtcHour + stored.utcOffsetMinutes / 60) % 24 + 24) % 24;

      if (Math.floor(localHour) === stored.hour) {
        await sendOnePush(stored, env);
      }
    }),
  );
}
