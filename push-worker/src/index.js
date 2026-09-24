// Serveur de notifications de Logis — Cloudflare Worker + un Durable Object.
//
// Rôle : réveiller le téléphone à l'heure choisie, les jours où une tâche est
// en retard ou arrive à un rappel. Le push est VIDE : le service worker de
// l'appli compose le texte à partir des données locales du téléphone. Le
// serveur ne reçoit donc que des dates, jamais le contenu des tâches.
//
// Tout l'état (clés VAPID + abonnements) vit dans un Durable Object SQLite :
// contrairement à KV, il n'y a aucun identifiant de ressource à créer à la
// main — un seul `wrangler deploy` suffit.
import { DurableObject } from 'cloudflare:workers';
import {
  endpointId, generateVapidKeys, vapidAuthorization, isDue, localParts,
  parseSubscribe, isAllowedEndpoint,
} from './lib.js';

// Identifie l'expéditeur auprès des services de push (Apple exige une URL
// https ou un mailto valide).
const SUBJECT = 'https://github.com/Cdricpl/Logis';
const MAX_SUBSCRIPTIONS = 50;
const TEST_COOLDOWN_MS = 30 * 1000;

export class PushStore extends DurableObject {
  async vapidKeys() {
    let keys = await this.ctx.storage.get('vapid');
    if (!keys) {
      keys = await generateVapidKeys();
      await this.ctx.storage.put('vapid', keys);
    }
    return keys;
  }

  async publicKey() {
    return (await this.vapidKeys()).publicKey;
  }

  // Crée ou met à jour un abonnement. Conserve lastSent pour ne pas renvoyer
  // la notification du jour quand l'appli se resynchronise.
  async upsert(record) {
    const id = await endpointId(record.endpoint);
    const existing = await this.ctx.storage.get(id);
    if (!existing) {
      const count = (await this.ctx.storage.list({ prefix: 'sub:' })).size;
      if (count >= MAX_SUBSCRIPTIONS) return false;
    }
    await this.ctx.storage.put(id, {
      ...record,
      lastSent: existing ? existing.lastSent : null,
      lastTest: existing ? existing.lastTest : 0,
    });
    return true;
  }

  // Le navigateur a renouvelé l'abonnement : on garde l'heure et le calendrier.
  async move(oldEndpoint, newEndpoint) {
    const oldId = await endpointId(oldEndpoint);
    const rec = await this.ctx.storage.get(oldId);
    if (!rec) return false;
    await this.ctx.storage.delete(oldId);
    await this.ctx.storage.put(await endpointId(newEndpoint), { ...rec, endpoint: newEndpoint });
    return true;
  }

  async remove(endpoint) {
    await this.ctx.storage.delete(await endpointId(endpoint));
  }

  async test(endpoint) {
    const id = await endpointId(endpoint);
    const rec = await this.ctx.storage.get(id);
    if (!rec) return 'unknown';
    if (Date.now() - (rec.lastTest || 0) < TEST_COOLDOWN_MS) return 'too-soon';
    rec.lastTest = Date.now();
    await this.ctx.storage.put(id, rec);
    return this.send(id, rec);
  }

  async send(id, rec) {
    let res;
    try {
      res = await fetch(rec.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(rec.endpoint, await this.vapidKeys(), SUBJECT),
          TTL: String(12 * 3600), // un téléphone éteint le reçoit s'il se rallume dans les 12 h
          Urgency: 'normal',
          'Content-Length': '0',
        },
      });
    } catch {
      return 'error-network';
    }
    // 404 / 410 : l'abonnement n'existe plus (appli désinstallée, permission retirée).
    if (res.status === 404 || res.status === 410) {
      await this.ctx.storage.delete(id);
      return 'gone';
    }
    return res.ok ? 'sent' : 'error-' + res.status;
  }

  // Appelé toutes les heures par le cron.
  async tick(nowMs) {
    const now = new Date(nowMs || Date.now());
    const subs = await this.ctx.storage.list({ prefix: 'sub:' });
    const results = [];
    for (const [id, rec] of subs) {
      if (!isDue(rec, now)) continue;
      const r = await this.send(id, rec);
      if (r === 'sent') {
        rec.lastSent = localParts(now, rec.tz, rec.utcOffsetMinutes).date;
        await this.ctx.storage.put(id, rec);
      }
      results.push(r);
    }
    return results;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function store(env) {
  return env.PUSH_STORE.get(env.PUSH_STORE.idFromName('logis'));
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > 32 * 1024) throw new Error('too-large');
  return JSON.parse(text);
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'GET' && pathname === '/') return json({ ok: true, service: 'logis-push' });
    if (req.method === 'GET' && pathname === '/vapid-key') return json({ publicKey: await store(env).publicKey() });

    if (req.method !== 'POST') return json({ error: 'not-found' }, 404);
    let body;
    try { body = await readJson(req); } catch { return json({ error: 'bad-json' }, 400); }
    const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : null;

    switch (pathname) {
      case '/subscribe': {
        const parsed = parseSubscribe(body);
        if (parsed.error) return json({ error: parsed.error }, 400);
        return (await store(env).upsert(parsed.record)) ? json({ ok: true }) : json({ error: 'full' }, 507);
      }
      case '/resubscribe': {
        const next = body && body.subscription && body.subscription.endpoint;
        if (!body.oldEndpoint || !isAllowedEndpoint(next)) return json({ error: 'endpoint' }, 400);
        return json({ ok: await store(env).move(body.oldEndpoint, next) });
      }
      case '/unsubscribe':
        if (!endpoint) return json({ error: 'endpoint' }, 400);
        await store(env).remove(endpoint);
        return json({ ok: true });
      case '/test': {
        if (!endpoint) return json({ error: 'endpoint' }, 400);
        const r = await store(env).test(endpoint);
        const status = { sent: 200, unknown: 404, 'too-soon': 429, gone: 410 }[r] || 502;
        return json({ result: r }, status);
      }
      default:
        return json({ error: 'not-found' }, 404);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(store(env).tick(event.scheduledTime));
  },
};

