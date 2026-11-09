/**
 * Karten (Nr. 827): eine Entscheidung ohne Zerstörendes, mit Ja, Nein und Ändern. Eine Karte erlaubt weder Befehl noch Werkzeug, und „Ändern“ gilt nur für Karten:
 * Ein Lauf behandelt jeden Status außer `abgelehnt` als Zustimmung, eine geänderte Freigabe wäre also eine erteilte.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Freigaben, neueFreigabe } from '../src/documents.js';
import { Runner } from '../src/runner.js';
import { hubWerkzeuge } from '../src/tools.js';

const tmp = mkdtempSync(join(tmpdir(), 'karte-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const leer = { aufrufen: async () => ({ ok: true, result: {} }), melden: async () => ({ ok: true }), bereicheMelden: async () => ({ ok: true }), gesundheit: async () => ({ ok: true }), suchen: async () => [], schema: async () => ({}), eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }) };

function konfig(name, env = {}) {
  return konfigurationLaden(
    { hub: 'http://hub.test', arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } }, pi_durable: { storage: join(tmp, `${name}.sqlite`), security: { token: 'test-token-test-token-test-token-00' }, proactive: { enabled: false }, egress: { enabled: false }, browser: { enabled: false }, desktop: { enabled: false } } },
    env,
  );
}

async function mitRunner(name, fn) {
  const cfg = konfig(name);
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage('ok')));
  const runner = new Runner(cfg, { models, hub: leer });
  await runner.start();
  const anlegen = (id, extra = {}) =>
    runner.harness.commit(async (tx) => {
      const doc = await tx.doc(Freigaben);
      doc.eintraege[id] = neueFreigabe({ id, conversationId: runner.root.id, aktion: 'Hauptserver aktualisieren', kontext: 'Es liegen Updates bereit.', ...extra });
    }, BACKGROUND_CONTEXT);
  try {
    await fn({ runner, anlegen });
  } finally {
    await runner.close().catch(() => {});
  }
}

test('Karte: nie zerstörerisch, ohne Befehl und Werkzeug, auch wenn der Aufrufer sie mitgibt', () => {
  const k = neueFreigabe({ id: 'k', art: 'karte', aktion: 'x', risiko: 'high', zerstoererisch: true, werkzeug: 'bash', befehl: 'rm -rf /' });
  assert.equal(k.art, 'karte');
  assert.equal(k.zerstoererisch, false);
  assert.equal(k.werkzeug, null);
  assert.equal(k.befehl, null);
  assert.equal(neueFreigabe({ id: 'f', aktion: 'x' }).art, 'freigabe');
});

test('Ändern: nur bei Karten und nur mit Notiz; die Notiz erreicht den Agenten', async () => {
  await mitRunner('aendern', async ({ runner, anlegen }) => {
    await anlegen('ka-1', { art: 'karte' });
    await anlegen('fr-1', { risiko: 'high' });
    await assert.rejects(runner.entscheideFreigabe('fr-1', { entscheidung: 'geaendert', notiz: 'anders' }), /nur bei Karten/);
    await assert.rejects(runner.entscheideFreigabe('ka-1', { entscheidung: 'geaendert', notiz: '  ' }), /braucht eine Notiz/);
    await assert.rejects(runner.entscheideFreigabe('ka-1', { entscheidung: 'vielleicht' }), /Entscheidung:/);
    const gesendet = [];
    runner.sende = async (_id, satz) => void gesendet.push(satz);
    const liste = await runner.entscheideFreigabe('ka-1', { entscheidung: 'geaendert', notiz: 'Erst am Sonntag', von: 'mensch' });
    assert.equal(liste.find((f) => f.id === 'ka-1').status, 'geaendert');
    assert.equal(liste.find((f) => f.id === 'fr-1').status, 'offen', 'die Freigabe blieb unentschieden');
    assert.match(gesendet[0], /Gewünscht ist etwas anderes.*Erst am Sonntag/);
  });
});

test('Ja und Nein auf einer Karte: klare Sätze; Ja erlaubt nichts Zerstörendes', async () => {
  await mitRunner('janein', async ({ runner, anlegen }) => {
    await anlegen('ka-1', { art: 'karte' });
    await anlegen('ka-2', { art: 'karte' });
    const gesendet = [];
    runner.sende = async (_id, satz) => void gesendet.push(satz);
    await runner.entscheideFreigabe('ka-1', { entscheidung: 'erteilt' });
    await runner.entscheideFreigabe('ka-2', { entscheidung: 'abgelehnt', notiz: 'Lohnt nicht' });
    assert.match(gesendet[0], /Die Antwort ist ja.*Zerstörendes braucht weiter eine eigene Freigabe/);
    assert.match(gesendet[1], /Die Antwort ist nein.*Lohnt nicht.*nicht erneut vorlegen/);
  });
});

test('Werkzeug karte_vorlegen: aus als Vorgabe, an legt eine Karte im Dokument an, Wiederholung ändert nichts', async () => {
  const namen = (cfg) => hubWerkzeuge({ cfg, hub: leer }).map((t) => t.name);
  assert.ok(!namen(konfig('w1')).includes('karte_vorlegen'));
  const cfg = konfig('w2', { FYOS_KARTEN: '1' });
  const wz = hubWerkzeuge({ cfg, hub: leer }).find((t) => t.name === 'karte_vorlegen');
  assert.ok(wz);
  const doc = { eintraege: {} };
  const eintraege = [];
  const api = {
    conversationId: 'g1',
    taskId: null,
    memo: async () => 'ka-fest',
    commit: async (fn) => fn({ doc: async () => doc, appendEntry: async (_g, e) => void eintraege.push(e) }),
  };
  const ein = { vorschlag: 'Jetson am Sonntag neu starten', kontext: 'Zehn Pakete warten. Der Neustart behebt das. Ohne ihn bleibt der alte Kernel. Der Rückweg ist nicht nötig.' };
  const r = await wz.execute(ein, api, {});
  assert.match(r.output[0].text, /Karte ka-fest liegt beim Menschen/);
  await wz.execute(ein, api, {});
  assert.equal(eintraege.length, 1);
  assert.equal(doc.eintraege['ka-fest'].art, 'karte');
  assert.equal(doc.eintraege['ka-fest'].zerstoererisch, false);
  assert.equal(doc.eintraege['ka-fest'].status, 'offen');
});
