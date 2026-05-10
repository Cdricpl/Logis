// Cloudflare Workers entry — wraps TanStack Start and adds push notification routes + cron
// @ts-ignore — module shape varies by TanStack Start version
import startEntry from '@tanstack/react-start/server-entry';
import { storeSubscription, removeSubscription, sendScheduledPush } from './push-send';
import type { Env } from './push-send';

// Resolve the TanStack fetch handler regardless of export shape
const _start = startEntry as any;
const startFetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> =
  typeof _start === 'function'
    ? _start
    : (_start?.default?.fetch ?? _start?.fetch ?? _start?.default);

// --------------- Push endpoint handlers ---------------

async function handlePushRoute(pathname: string, req: Request, env: Env): Promise<Response> {
  if (pathname === '/api/push/vapid-key' && req.method === 'GET') {
    return Response.json({ publicKey: env.VAPID_PUBLIC_KEY ?? '' });
  }

  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    try {
      const body = (await req.json()) as {
        subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
        hour?: number;
        utcOffsetMinutes?: number;
        resubscribe?: boolean;
      };
      const { subscription, hour = 9, utcOffsetMinutes = 0 } = body;
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return Response.json({ error: 'Invalid subscription' }, { status: 400 });
      }
      await storeSubscription(subscription, hour, utcOffsetMinutes, env);
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: 'Bad request' }, { status: 400 });
    }
  }

  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    try {
      const body = (await req.json()) as { endpoint?: string };
      if (!body?.endpoint) {
        return Response.json({ error: 'Missing endpoint' }, { status: 400 });
      }
      await removeSubscription(body.endpoint, env);
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: 'Bad request' }, { status: 400 });
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

// --------------- Worker export ---------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/push/')) {
      return handlePushRoute(url.pathname, request, env);
    }
    return startFetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendScheduledPush(env));
  },
};
