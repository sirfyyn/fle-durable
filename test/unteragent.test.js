/**
 * unteragent.js am echten Runner mit Faux-Modell: Der Zug wartet auf das Kindgespräch und bekommt dessen Antwort; das Kind hat alle Werkzeuge;
 * Plätze, Verschachtelung, Frist, Fehler, Abbruch und die Wiederaufnahme nach einem Neustart.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { AgentMeta, LaufListe } from '../src/documents.js';
import { Runner } from '../src/runner.js';
import { PLAETZE, unteragentWerkzeuge } from '../src/unteragent.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'unteragent-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
// Das Werkzeug wartet mit einem unref-Timer (im Betrieb hält der Server die Schleife wach). Ohne diesen Griff leert Node 22 die
// Ereignisschleife mitten im Test und bricht die übrigen Tests ab; Node 26 nicht (10.11.2026, Hauptserver, Node 22.23).
const wach = setInterval(() => {}, 1000);
after(() => clearInterval(wach));

const hub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
});

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, was, ms = 15000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const w = await fn();
    if (w) return w;
    await warte(25);
  }
  assert.fail(`nicht erreicht: ${was}`);
}

async function mitRunner(name, fn, antworten = [], fauxExtra = {}) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'paula',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, `${name}.sqlite`),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }], ...fauxExtra });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(antworten);
  const runner = new Runner(cfg, { models, hub: hub() });
  await runner.start();
  try {
    await fn({ runner, cfg, faux });
  } finally {
    await runner.close().catch(() => {});
  }
}

const LANGSAM = { tokensPerSecond: 5 };
const LANG = () => [fauxAssistantMessage('Wort '.repeat(4000))];

const liste = async (runner) => Object.values((await runner.harness.snapshot(LaufListe, CTX))?.eintraege ?? {});
const textVon = (r) => r.output[0].text;

/** Das Werkzeug direkt, mit einem `api`, das in eine Transaktion des Harness schreibt: für alles, was keinen ganzen Zug braucht. */
function direkt(runner, cfg, extra = {}) {
  const gebaut = { Lauf: runner.Lauf, laufAnlegen: runner.laufAnlegen };
  const [wz] = unteragentWerkzeuge({ cfg, harness: () => runner.harness, ...gebaut, schrittMs: 10, ...extra });
  const memo = new Map();
  const api = {
    conversationId: runner.root.id,
    memo: async (k, v) => (memo.has(k) ? memo.get(k) : (memo.set(k, v), v)),
    commit: (fn) => runner.root.commit(fn, CTX),
  };
  return { rufe: (p, context = {}) => wz.execute(p, api, context), api, memo };
}

test('der ganze Weg: das Modell ruft unteragent, das Kind arbeitet, die Antwort kommt in den Zug zurück', async () => {
  await mitRunner(
    'weg',
    async ({ runner, faux }) => {
      const start = faux.getPendingResponseCount();
      await runner.root.submit({ type: 'input', content: 'Sieh bitte nach', requestId: 'r1', whenBusy: 'followUp' }, CTX);
      await bis(() => faux.getPendingResponseCount() === 0, 'alle Antworten verbraucht');
      assert.equal(start, 3);
      const [e] = await bis(async () => {
        const l = await liste(runner);
        return l.length && l[0].status === 'abgeschlossen' ? l : null;
      }, 'Lauf fertig');
      assert.equal(e.quelle, 'unteragent');
      assert.equal(e.antwort, 'Befund: alles in Ordnung');
      assert.equal(e.art, 'lesen');
      const meta = await runner.harness.snapshot(AgentMeta, e.kindId, CTX);
      assert.equal(meta.aufrufer, 'persona-kind:lauf', 'das Tor legt das Kind auf den zweiten Slot');
    },
    [
      fauxAssistantMessage([fauxToolCall('unteragent', { aufgabe: 'Lies die Notiz und fasse sie zusammen' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Befund: alles in Ordnung')]),
      fauxAssistantMessage('Der Unteragent meldet: alles in Ordnung.'),
    ],
  );
});

test('direkt: Ergebnis, Art im Auftrag, Ordner geprüft, kurze Aufgabe abgewiesen', async () => {
  await mitRunner(
    'direkt',
    async ({ runner, cfg }) => {
      const { rufe } = direkt(runner, cfg);
      assert.match(textVon(await rufe({ aufgabe: 'kurz' })), /zu kurz/);
      assert.match(textVon(await rufe({ aufgabe: 'irgendeine Aufgabe', ordner: join(tmp, 'gibtsnicht') })), /gibt es nicht/);
      const r = await rufe({ aufgabe: 'Ändere die Notiz bitte', art: 'arbeiten', ordner: tmp });
      assert.match(textVon(r), /^Unteragent \(arbeiten, \d+ s\):\nFertig/);
      assert.equal(r.details.status, 'abgeschlossen');
      const [e] = await liste(runner);
      assert.match(e.auftrag, /Du darfst Befehle ausführen/);
      assert.match(e.auftrag, /Ändere die Notiz/);
    },
    [fauxAssistantMessage('Fertig, Notiz geändert')],
  );
});

test('Plätze: der dritte wird sofort abgewiesen; ein gestorbener Lauf über seine Frist hält keinen Platz', async () => {
  await mitRunner('plaetze', async ({ runner, cfg }) => {
    const belege = (frist) =>
      runner.harness.commit(async (doc) => {
        const l = await doc.doc(LaufListe);
        for (let i = 0; i < PLAETZE; i += 1) l.eintraege[`b${i}`] = { id: `b${i}`, quelle: 'unteragent', status: 'laeuft', frist_bis: frist };
      }, CTX);
    await belege(Date.now() + 60_000);
    const voll = await direkt(runner, cfg).rufe({ aufgabe: 'noch eine Aufgabe bitte', frist_s: 10 });
    assert.match(textVon(voll), /Beide Plätze/);
    assert.equal((await liste(runner)).length, PLAETZE);

    await belege(Date.now() - 1000);
    const t0 = Date.now();
    const r = await direkt(runner, cfg, { jetzt: () => Date.now(), fristMinS: 1 }).rufe({ aufgabe: 'noch eine Aufgabe bitte', frist_s: 1 });
    assert.doesNotMatch(textVon(r), /Beide Plätze/);
    assert.match(textVon(r), /Zeitgrenze von 1 s/);
    assert.ok(Date.now() - t0 < 10_000);
    await bis(async () => (await liste(runner)).some((e) => e.quelle === 'unteragent' && e.status === 'abgebrochen'), 'Lauf über die Frist abgebrochen');
  }, LANG(), LANGSAM);
});

test('ein Kind startet keine weiteren Kinder', async () => {
  await mitRunner('kind', async ({ runner, cfg }) => {
    await runner.root.commit(async (doc) => {
      const meta = await doc.doc(AgentMeta, runner.root.id);
      meta.aufrufer = 'persona-kind:lauf';
    }, CTX);
    assert.match(textVon(await direkt(runner, cfg).rufe({ aufgabe: 'noch eine Ebene tiefer' })), /keine weiteren/);
    assert.equal((await liste(runner)).length, 0);
  });
});

test('Wiederholung nach einem Neustart: dieselbe Anfrage legt keinen zweiten Lauf an und wartet auf den ersten', async () => {
  await mitRunner(
    'wiederholung',
    async ({ runner, cfg }) => {
      const { rufe } = direkt(runner, cfg);
      const a = await rufe({ aufgabe: 'Sieh dir das bitte an', ordner: tmp });
      const b = await rufe({ aufgabe: 'Sieh dir das bitte an', ordner: tmp });
      assert.equal(a.details.lauf, b.details.lauf);
      assert.equal((await liste(runner)).length, 1);
      assert.match(textVon(b), /Einmal gearbeitet/);
    },
    [fauxAssistantMessage('Einmal gearbeitet')],
  );
});

test('Abbruch des Zugs beendet das Kind', async () => {
  await mitRunner('abbruch', async ({ runner, cfg }) => {
    const c = new AbortController();
    const p = direkt(runner, cfg).rufe({ aufgabe: 'Das dauert sehr lange hier', ordner: tmp }, { signal: c.signal });
    await bis(async () => (await liste(runner)).length === 1, 'Lauf angelegt');
    c.abort();
    const r = await p;
    assert.match(textVon(r), /Zug abgebrochen/);
    assert.equal(r.details.grund, 'abgebrochen');
    await bis(async () => (await liste(runner))[0].status === 'abgebrochen', 'Lauf abgebrochen');
  }, LANG(), LANGSAM);
});

test('ein gescheitertes Kind wird als Fehler gemeldet, der Zug hängt nicht', async () => {
  await mitRunner('fehler', async ({ runner, cfg, faux }) => {
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Modell weg' })]);
    const r = await direkt(runner, cfg, { fristMinS: 1 }).rufe({ aufgabe: 'Das geht schief hier', ordner: tmp, frist_s: 8 });
    assert.match(textVon(r), /fehlgeschlagen/);
    assert.equal(r.details?.status, 'fehler');
  });
});

test('der Agent bekommt das Werkzeug im Runner, und zwar nur einmal', async () => {
  await mitRunner('register', async ({ runner }) => {
    const namen = runner.extension.tools.map((t) => t.name);
    assert.equal(namen.filter((n) => n === 'unteragent').length, 1);
    assert.ok(namen.includes('aufgabe_starten'));
  });
});
