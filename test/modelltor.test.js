/**
 * Das Modell-Tor (FLE Durable): Ereignisse warten, solange der Modellserver nicht antwortet, und laufen danach;
 * eine Nachricht über die FLE-Link-Schnittstelle wird in dieser Zeit abgelehnt statt verbraucht.
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
import { Wartend } from '../src/documents.js';
import { routeFleLink } from '../src/fle-link.js';
import { Ingress } from '../src/ingress.js';
import { ModellTor } from '../src/modelltor.js';
import { Runner } from '../src/runner.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

test('das Tor fragt /models, merkt sich die Antwort kurz und nennt den Grund', async () => {
  let uhr = 1000;
  const anfragen = [];
  let antwort = { status: 503 };
  const tor = new ModellTor({
    baseUrl: 'http://modell.test/v1/',
    apiKey: 'k',
    jetzt: () => uhr,
    frischMs: 4000,
    fetchImpl: async (url, opt) => {
      anfragen.push([url, opt.headers.Authorization]);
      if (antwort === 'weg') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return antwort;
    },
  });
  assert.equal(tor.stand, null);
  assert.equal(await tor.offen(), false);
  assert.deepEqual(anfragen, [['http://modell.test/v1/models', 'Bearer k']]);
  assert.deepEqual(tor.stand, { offen: false, grund: 'Status 503' });
  // innerhalb der Frist keine neue Anfrage, auch wenn der Server inzwischen antworten würde
  antwort = { status: 200 };
  uhr += 3000;
  assert.equal(await tor.offen(), false);
  assert.equal(anfragen.length, 1);
  uhr += 1500;
  assert.equal(await tor.offen(), true);
  assert.deepEqual(tor.stand, { offen: true, grund: '' });
  // Server ganz weg
  antwort = 'weg';
  uhr += 5000;
  assert.equal(await tor.offen(), false);
  assert.equal(tor.stand.grund, 'ECONNREFUSED');
});

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-modelltor-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('ein Ereignis wartet bei geschlossenem Tor und läuft, sobald es offen ist; die Chat-Route lehnt solange ab', async () => {
  const cfg = konfigurationLaden(
    {
      hub: '',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [],
      pi_durable: {
        lokal: true,
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    { FYOS_RUNNER_LOKAL: '1' },
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: cfg.pi_durable.model.default }, { id: cfg.pi_durable.model.max }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let anfragenAnsModell = 0;
  faux.setResponses(
    Array.from({ length: 4 }, () => () => {
      anfragenAnsModell += 1;
      return fauxAssistantMessage('ok');
    }),
  );
  const runner = new Runner(cfg, { models });
  await runner.start();
  let offen = false;
  const modellTor = { offen: async () => offen, stand: { offen: false, grund: 'Status 503' } };
  const ingress = new Ingress({ cfg, runner, hub: null, modellTor, ruhe: runner.ruhe });
  await ingress.start();
  try {
    await ingress.einreihen({ id: 'e-1', text: 'Build 42 ist rot', quelle: 'ci', von: 'ci' });
    // Tor zu: das Ereignis bleibt liegen, das Modell wird nicht gefragt
    await warte(2500);
    const wartend = await runner.harness.snapshot(Wartend, CTX);
    assert.equal((wartend?.eintraege ?? []).length, 1, 'bleibt in der Warteschlange');
    assert.equal(anfragenAnsModell, 0, 'keine Anfrage an ein Modell, das nicht antwortet');
    // die Chat-Route nimmt in dieser Zeit nichts an
    const fehler = (status, text) => Object.assign(new Error(text), { status });
    await assert.rejects(
      routeFleLink({
        req: {},
        res: {},
        path: '/api/message',
        method: 'POST',
        runner,
        readJson: async () => ({ text: 'hallo' }),
        json: () => assert.fail('darf nicht annehmen'),
        stream: async () => {},
        error: fehler,
        modellTor,
      }),
      (e) => e.status === 503 && /Modell antwortet nicht/.test(e.message),
    );
    assert.equal(anfragenAnsModell, 0);
    // Tor auf: das Ereignis geht hinaus
    offen = true;
    ingress.anstossen();
    await bis(async () => ((await runner.harness.snapshot(Wartend, CTX))?.eintraege ?? []).length === 0, { was: 'Warteschlange leer' });
    await bis(() => anfragenAnsModell >= 1, { was: 'Modell gefragt' });
  } finally {
    await ingress.stop();
    await runner.close();
  }
});

test('die Warteschlange hat für FLE Link englische Feldnamen und den Stand des Modell-Tors', async () => {
  const { queueView } = await import('../src/fle-link.js');
  const { OWNER_CLASS, BACKGROUND_CLASS } = await import('../src/ports/contracts.js');
  const sicht = queueView(
    [
      { id: 'webhook:ci-42', quelle: 'webhook', von: 'ci', klasse: BACKGROUND_CLASS, bezug: null, angenommen: 17, text: 'Build 42 failed' },
      { id: 'chat:1', quelle: 'chat', von: 'owner', klasse: OWNER_CLASS, bezug: 'x', angenommen: 18, text: 'hallo' },
    ],
    { modell: { offen: false, grund: 'Status 503' } },
  );
  assert.deepEqual(sicht.entries[0], { id: 'webhook:ci-42', source: 'webhook', from: 'ci', priority: 'background', ref: null, accepted: 17, text: 'Build 42 failed' });
  assert.equal(sicht.entries[1].priority, 'owner');
  assert.deepEqual(sicht.model, { open: false, reason: 'Status 503' });
  assert.equal(queueView([], {}).model, null);
});
