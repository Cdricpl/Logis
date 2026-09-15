#!/usr/bin/env node
/**
 * Génère index.html (GitHub Pages) à partir de Logis.html (Cloudflare Workers).
 *
 * Les deux fichiers sont la même application ; ils ne diffèrent que par la façon
 * dont les ressources sont servies. Les maintenir à la main a déjà produit de la
 * dérive (variables mortes d'un côté, règles CSS placées ailleurs de l'autre),
 * d'où cette génération déterministe.
 *
 * Usage :  node sync-index.js          régénère index.html
 *          node sync-index.js --check  vérifie la synchro sans écrire (code 1 si écart)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(DIR, 'Logis.html');
const OUT = path.join(DIR, 'index.html');

// Chaque règle doit s'appliquer exactement `count` fois : si Logis.html change
// au point qu'une règle ne matche plus, on veut un échec bruyant, pas un
// index.html silencieusement faux.
const RULES = [
  {
    what: 'commentaire du manifeste',
    from: "<!-- Manifeste PWA (chemin absolu : l'app est servie depuis /api/logis) -->",
    to: '<!-- Manifeste PWA (chemins relatifs pour GitHub Pages /Logis/) -->',
    count: 1,
  },
  { what: 'manifeste', from: 'href="/manifest.webmanifest"', to: 'href="manifest.webmanifest"', count: 1 },
  { what: 'apple-touch-icon', from: 'href="/apple-touch-icon.png"', to: 'href="apple-touch-icon.png"', count: 1 },
  { what: 'icône 32', from: 'href="/icon-32.png"', to: 'href="icon-32.png"', count: 1 },
  { what: 'icône 192', from: 'href="/icon-192.png"', to: 'href="icon-192.png"', count: 1 },
  { what: 'icône 512', from: 'href="/icon-512.png"', to: 'href="icon-512.png"', count: 1 },
  {
    what: 'service worker',
    from: "navigator.serviceWorker.register('/sw.js')",
    to:
      "// sw-gh.js sur GitHub Pages (sans /api/logis), sw.js sur Cloudflare Workers\n" +
      "      var swFile = host.indexOf('github.io') !== -1 ? './sw-gh.js' : './sw.js';\n" +
      '      navigator.serviceWorker.register(swFile)',
    count: 1,
  },
];

function build(src) {
  let out = src;
  for (const r of RULES) {
    const n = out.split(r.from).length - 1;
    if (n !== r.count) {
      throw new Error(`Règle « ${r.what} » : ${n} occurrence(s) trouvée(s), ${r.count} attendue(s).\n` +
        `Logis.html a changé — mets à jour sync-index.js avant de régénérer.`);
    }
    out = out.split(r.from).join(r.to);
  }
  return out;
}

const generated = build(fs.readFileSync(SRC, 'utf8'));

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current === generated) {
    console.log('index.html est synchronisé avec Logis.html.');
  } else {
    console.error('index.html DIVERGE de Logis.html — lance « node sync-index.js ».');
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, generated);
  console.log(`index.html régénéré depuis Logis.html (${generated.split('\n').length} lignes).`);
}
