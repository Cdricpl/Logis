// L'adresse du serveur de notifications est écrite à deux endroits : l'appli
// (qui s'abonne) et le service worker (qui gère les renouvellements). Ce test
// empêche qu'on ne mette à jour que l'un des deux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, ROOT), 'utf8');

test('PUSH_API identique dans Logis.html, index.html et sw-push.js', () => {
  const app = read('Logis.html').match(/const PUSH_API = '([^']*)';/);
  const gh = read('index.html').match(/const PUSH_API = '([^']*)';/);
  const sw = read('sw-push.js').match(/const LOGIS_PUSH_API = '([^']*)';/);
  assert.ok(app && gh && sw, 'constante introuvable');
  assert.equal(gh[1], app[1]);
  assert.equal(sw[1], app[1]);
  if (app[1]) {
    assert.match(app[1], /^https:\/\/[^/]+$/, 'https, sans chemin ni barre finale');
  }
});

test('index.html est bien généré depuis Logis.html', () => {
  execFileSync('node', [new URL('sync-index.js', ROOT).pathname, '--check'], { stdio: 'pipe' });
});

test('les deux service workers chargent sw-push.js', () => {
  assert.match(read('sw.js'), /importScripts\("\/sw-push\.js"\)/);
  assert.match(read('sw-gh.js'), /importScripts\("\.\/sw-push\.js"\)/);
});
