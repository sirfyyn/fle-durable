/**
 * Eine gescheiterte Runde parkt nicht, was dahinter wartet (afterFailedRun: 'continue'). Mit der Vorgabe von pi-durable ("keep") blieb eine
 * angereihte Nachricht liegen, bis von außen das nächste Ereignis kam: Der Runner stand still, ohne Meldung. Echter Runner, künstliches Modell.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { konfigurationLaden } from '../src/config.js';
import { Runner } from '../src/runner.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await fn()) return;
    await warte(50);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-gescheitert-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const hub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => {
    await warte(150);
    return { eintraege: [], letzte: nach };
  },
});

test('die zweite Nachricht kommt dran, obwohl die Runde davor scheitert, ohne weiteres Ereignis', async () => {
  const aufrufe = [];
  const bauen = () => (_model, context) => {
    const s = createAssistantMessageEventStream();
    const nr = aufrufe.push(JSON.stringify(context.messages));
    setTimeout(() => {
      // nicht wiederholbar und kein Grund zum Rückfall: die Runde endet sofort mit model_error
      const m = nr === 1 ? fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'invalid request' }) : fauxAssistantMessage('zweite-ok');
      if (nr === 1) s.push({ type: 'error', reason: 'error', error: m });
      else s.push({ type: 'done', reason: 'stop', message: m });
      s.end(m);
    }, nr === 1 ? 600 : 0);
    return s;
  };
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const runner = new Runner(cfg, { basis: { stream: bauen(), streamSimple: bauen() }, hub: hub() });
  await runner.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Erste');
    await bis(() => aufrufe.length === 1, { was: 'erste Anfrage' });
    await runner.sende(root.id, 'Zweite Nachricht', { art: 'folgen' });
    await bis(() => aufrufe.length >= 2, { was: 'die zweite Nachricht erreicht das Modell' });
    assert.match(aufrufe[1], /Zweite Nachricht/);
  } finally {
    await runner.close();
  }
});
