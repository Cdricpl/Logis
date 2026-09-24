// Notifications push de Logis — partagé par sw.js (Cloudflare) et sw-gh.js
// (GitHub Pages) via importScripts.
//
// Le serveur (push-worker/) envoie un push VIDE à l'heure choisie, les jours où
// il y a quelque chose à signaler. Le texte est composé ICI, à partir des
// données locales du téléphone : le serveur ne voit jamais le contenu des tâches.

// Adresse du serveur de notifications. Doit rester identique à PUSH_API dans
// Logis.html (vérifié par push-worker/test/config.test.js).
const LOGIS_PUSH_API = 'https://logis-push.pieltain-cedric.workers.dev';

// Page à ouvrir au clic ; chaque service worker la fixe avant l'importScripts.
const LOGIS_APP_URL = self.LOGIS_APP_URL || self.registration.scope;

function logisReadStore() {
  return new Promise((resolve) => {
    // Sans numéro de version : on ouvre la base telle que l'appli l'a créée,
    // sans jamais déclencher (ni bloquer) sa mise à niveau.
    const req = indexedDB.open('logis_db');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tasks')) { db.close(); resolve(null); return; }
      const out = {};
      const tx = db.transaction('tasks', 'readwrite');
      const st = tx.objectStore('tasks');
      st.get('data').onsuccess = (e) => { out.data = e.target.result || null; };
      st.get('pushTest').onsuccess = (e) => { out.pushTest = e.target.result || null; };
      // Le drapeau de test ne sert qu'une fois.
      st.delete('pushTest');
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); resolve(out); };
    };
  });
}

// Même règle que getDueNotifMessages() dans Logis.html.
function logisDueMessage(data) {
  if (!data || !Array.isArray(data.tasks)) return null;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const daysUntil = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round((new Date(y, m - 1, d) - t0) / 86400000); };
  const late = [], prep = [];
  data.tasks.forEach((t) => {
    if (t.archived || !t.due) return;
    const d = daysUntil(t.due);
    if (d < 0) { late.push(t); return; }
    if (Array.isArray(t.reminders) && t.reminders.indexOf(d) !== -1) prep.push({ t, d });
  });
  if (!late.length && !prep.length) return null;
  let body = '';
  if (late.length) body += late.length + ' tâche' + (late.length > 1 ? 's en retard' : ' en retard') + '. ';
  if (prep.length) {
    body += prep.length + ' à préparer : ' +
      prep.slice(0, 3).map((p) => p.t.title.substring(0, 28) + ' (J-' + p.d + ')').join(', ');
    if (prep.length > 3) body += '…';
  }
  return body.trim();
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const store = await logisReadStore();
    const data = store && store.data;
    const title = 'Logis · ' + ((data && data.houseName) || 'Ta maison');
    const opts = { icon: 'icon-192.png', badge: 'icon-192.png', tag: 'logis-daily', data: { url: LOGIS_APP_URL } };

    if (store && store.pushTest && Date.now() - store.pushTest < 5 * 60 * 1000) {
      const due = logisDueMessage(data);
      return self.registration.showNotification('Logis · Test', {
        ...opts, tag: 'logis-test',
        body: 'Les rappels arrivent bien, même appli fermée.' + (due ? '\n' + due : ''),
      });
    }
    // Un push doit TOUJOURS afficher quelque chose : sinon Chrome affiche son
    // propre message générique, et Safari finit par résilier l'abonnement.
    // Ce repli ne sert que si les données ont changé depuis la dernière
    // synchronisation avec le serveur.
    const body = logisDueMessage(data) || 'Ouvre Logis pour voir où en sont tes tâches.';
    return self.registration.showNotification(title, { ...opts, body });
  })());
});

// Le navigateur a renouvelé l'abonnement : on prévient le serveur pour garder
// l'heure et le calendrier. (L'appli se resynchronise aussi à chaque ouverture.)
self.addEventListener('pushsubscriptionchange', (event) => {
  if (!LOGIS_PUSH_API || !event.oldSubscription || !event.newSubscription) return;
  event.waitUntil(fetch(LOGIS_PUSH_API + '/resubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldEndpoint: event.oldSubscription.endpoint, subscription: event.newSubscription.toJSON() }),
  }).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || LOGIS_APP_URL;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if ('focus' in w) return w.focus();
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
