// Logique pure du serveur de notifications de Logis.
// Aucune dépendance à Cloudflare : tout ce fichier est testable sous Node
// (node --test push-worker/test/*.test.js), parce que Node 22 expose la même Web Crypto
// que les Workers.

// ---------- Services de push autorisés ----------
// Le Worker POSTe toutes les heures vers les adresses qu'on lui confie. Sans
// liste blanche, n'importe qui pourrait lui faire frapper une URL arbitraire.
const PUSH_HOSTS = [
  'fcm.googleapis.com',                // Chrome, Edge, Samsung Internet (Android et bureau)
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com',                // Safari (iOS 16.4+, macOS)
];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

export function isAllowedEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname;
  return PUSH_HOSTS.includes(h) || PUSH_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

// ---------- base64url ----------
export function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Identifiant de stockage d'un abonnement : on ne garde pas l'adresse en clé.
export async function endpointId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return 'sub:' + b64url(new Uint8Array(h)).slice(0, 32);
}

// ---------- VAPID (RFC 8292) ----------
// Le Worker génère sa paire de clés au premier appel et la conserve : personne
// n'a jamais à manipuler de clé privée.
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateJwk, publicKey: b64url(publicRaw) };
}

export async function vapidAuthorization(endpoint, keys, subject, nowMs = Date.now()) {
  const aud = new URL(endpoint).origin;
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = part({ typ: 'JWT', alg: 'ES256' }) + '.' +
    part({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject });
  // Web Crypto signe au format IEEE P1363 (r‖s, 64 octets) : exactement ce
  // qu'attend un JWT ES256.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(new Uint8Array(sig))}, k=${keys.publicKey}`;
}

// ---------- Heure et date locales de l'abonné ----------
// Le fuseau IANA (« Europe/Brussels ») suit les changements d'heure tout seul ;
// le décalage en minutes ne sert que de repli si le fuseau est inconnu.
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

export function localParts(now, tz, offsetMinutes) {
  if (isValidTimeZone(tz)) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
    const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  }
  const d = new Date(now.getTime() + (offsetMinutes || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

// ---------- Faut-il prévenir aujourd'hui ? ----------
// Même règle que l'appli (getDueNotifMessages) : chaque jour tant qu'une tâche
// est en retard, et le jour exact de chaque rappel « J-x ». Le serveur ne
// connaît que des dates, jamais le contenu des tâches.
export function isNotifyDay(schedule, date) {
  if (!schedule) return false;
  if (schedule.overdueFrom && date >= schedule.overdueFrom) return true;
  return Array.isArray(schedule.dates) && schedule.dates.includes(date);
}

export function isDue(record, now) {
  const { date, hour } = localParts(now, record.tz, record.utcOffsetMinutes);
  return hour === record.hour && record.lastSent !== date && isNotifyDay(record.schedule, date);
}

// ---------- Validation des requêtes ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSchedule(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    overdueFrom: typeof s.overdueFrom === 'string' && DATE_RE.test(s.overdueFrom) ? s.overdueFrom : null,
    dates: Array.isArray(s.dates)
      ? [...new Set(s.dates.filter((d) => typeof d === 'string' && DATE_RE.test(d)))].sort().slice(0, 400)
      : [],
  };
}

export function parseSubscribe(body) {
  const sub = body && body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024 || !isAllowedEndpoint(sub.endpoint)) {
    return { error: 'endpoint' };
  }
  const hour = Number.isInteger(body.hour) && body.hour >= 0 && body.hour <= 23 ? body.hour : 9;
  const off = Number.isFinite(body.utcOffsetMinutes)
    ? Math.max(-840, Math.min(840, Math.round(body.utcOffsetMinutes))) : 0;
  return {
    record: {
      endpoint: sub.endpoint,
      hour,
      tz: isValidTimeZone(body.tz) ? body.tz : '',
      utcOffsetMinutes: off,
      schedule: parseSchedule(body.schedule),
    },
  };
}
