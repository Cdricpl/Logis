// node --test push-worker/test/*.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedEndpoint, b64url, b64urlToBytes, generateVapidKeys, vapidAuthorization,
  localParts, isNotifyDay, isDue, parseSubscribe, parseSchedule, endpointId,
} from '../src/lib.js';

test('liste blanche des services de push', () => {
  assert.ok(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(isAllowedEndpoint('https://web.push.apple.com/QGx'));
  assert.ok(isAllowedEndpoint('https://api.push.apple.com/3/device/x'));
  assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(isAllowedEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'));
  // refusés : autre hôte, http, faux suffixe, port, identifiants
  assert.ok(!isAllowedEndpoint('https://example.com/fcm.googleapis.com'));
  assert.ok(!isAllowedEndpoint('http://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(!isAllowedEndpoint('https://evilpush.apple.com.attacker.net/x'));
  assert.ok(!isAllowedEndpoint('https://fcm.googleapis.com:8443/x'));
  assert.ok(!isAllowedEndpoint('https://user:pw@fcm.googleapis.com/x'));
  assert.ok(!isAllowedEndpoint('pas une url'));
});

test('base64url aller-retour', () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) & 255);
  assert.deepEqual(b64urlToBytes(b64url(bytes)), bytes);
  assert.ok(!/[+/=]/.test(b64url(bytes)));
});

test('VAPID : clé publique brute de 65 octets et JWT ES256 vérifiable', async () => {
  const keys = await generateVapidKeys();
  const pub = b64urlToBytes(keys.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04); // point non compressé, ce qu'attend applicationServerKey

  const now = Date.UTC(2026, 8, 24, 7, 0);
  const auth = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://github.com/Cdricpl/Logis', now);
  const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, auth);
  const [, h, p, s, k] = m;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'https://github.com/Cdricpl/Logis');
  assert.equal(payload.exp, now / 1000 + 12 * 3600);

  const verifyKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sig = b64urlToBytes(s);
  assert.equal(sig.length, 64);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, new TextEncoder().encode(h + '.' + p));
  assert.ok(ok, 'la signature doit se vérifier avec la clé publique annoncée');
});

test('heure locale : Bruxelles suit les changements d\'heure', () => {
  // été : UTC+2
  assert.deepEqual(localParts(new Date('2026-09-24T07:00:00Z'), 'Europe/Brussels', 0), { date: '2026-09-24', hour: 9 });
  // hiver : UTC+1 — même heure UTC, heure locale différente
  assert.deepEqual(localParts(new Date('2026-12-02T07:00:00Z'), 'Europe/Brussels', 120), { date: '2026-12-02', hour: 8 });
  // passage de minuit : 23 h UTC = lendemain à Bruxelles
  assert.deepEqual(localParts(new Date('2026-09-24T23:00:00Z'), 'Europe/Brussels', 0), { date: '2026-09-25', hour: 1 });
  // repli sur le décalage si le fuseau est invalide
  assert.deepEqual(localParts(new Date('2026-09-24T07:00:00Z'), 'Pas/UnFuseau', 120), { date: '2026-09-24', hour: 9 });
});

test('règle du jour : retard continu, rappels au jour exact', () => {
  const s = { overdueFrom: '2026-09-13', dates: ['2026-10-06', '2026-11-20'] };
  assert.ok(!isNotifyDay(s, '2026-09-12'));
  assert.ok(isNotifyDay(s, '2026-09-13'));
  assert.ok(isNotifyDay(s, '2026-09-30'));
  const r = { overdueFrom: null, dates: ['2026-10-06'] };
  assert.ok(!isNotifyDay(r, '2026-10-05'));
  assert.ok(isNotifyDay(r, '2026-10-06'));
  assert.ok(!isNotifyDay(r, '2026-10-07'));
  assert.ok(!isNotifyDay({ overdueFrom: null, dates: [] }, '2026-10-06'));
});

test('isDue : à l\'heure choisie, une fois par jour, seulement si nécessaire', () => {
  const rec = { hour: 9, tz: 'Europe/Brussels', utcOffsetMinutes: 120, lastSent: null,
    schedule: { overdueFrom: '2026-09-13', dates: [] } };
  const at9 = new Date('2026-09-24T07:00:00Z');
  const at10 = new Date('2026-09-24T08:00:00Z');
  assert.ok(isDue(rec, at9));
  assert.ok(!isDue(rec, at10), 'pas à une autre heure');
  assert.ok(!isDue({ ...rec, lastSent: '2026-09-24' }, at9), 'pas deux fois le même jour');
  assert.ok(isDue({ ...rec, lastSent: '2026-09-23' }, at9));
  assert.ok(!isDue({ ...rec, schedule: { overdueFrom: null, dates: [] } }, at9), 'rien à signaler, rien envoyé');
});

test('validation de /subscribe', () => {
  const ok = parseSubscribe({
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'x', auth: 'y' } },
    hour: 8, tz: 'Europe/Brussels', utcOffsetMinutes: 120,
    schedule: { overdueFrom: '2026-09-13', dates: ['2026-10-06', '2026-10-06', 'n\'importe quoi', 42] },
  });
  assert.deepEqual(ok.record, {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc', hour: 8, tz: 'Europe/Brussels', utcOffsetMinutes: 120,
    schedule: { overdueFrom: '2026-09-13', dates: ['2026-10-06'] },
  });
  assert.ok(!('keys' in ok.record), 'les clés de chiffrement ne sont pas conservées (push sans contenu)');
  assert.equal(parseSubscribe({ subscription: { endpoint: 'https://evil.example/x' } }).error, 'endpoint');
  assert.equal(parseSubscribe({}).error, 'endpoint');
  const d = parseSubscribe({ subscription: { endpoint: 'https://fcm.googleapis.com/x' }, hour: 99, tz: 'x', utcOffsetMinutes: 99999 }).record;
  assert.equal(d.hour, 9);
  assert.equal(d.tz, '');
  assert.equal(d.utcOffsetMinutes, 840);
  assert.equal(parseSchedule({ dates: Array.from({ length: 900 }, (_, i) => `2027-01-${String(i % 28 + 1).padStart(2, '0')}`) }).dates.length, 28);
});

test('identifiant d\'abonnement stable et opaque', async () => {
  const a = await endpointId('https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(a, await endpointId('https://fcm.googleapis.com/fcm/send/abc'));
  assert.notEqual(a, await endpointId('https://fcm.googleapis.com/fcm/send/abd'));
  assert.ok(a.startsWith('sub:') && !a.includes('fcm'));
});
