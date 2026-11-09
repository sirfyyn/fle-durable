/**
 * Die Tür für den Chat in FLE Link (Nr. 879, 881): der vereinbarte Vertrag auf Ginnys Hauptgespräch, Freigaben nur zum Ansehen.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { approvalsView, fleLinkMay } from '../src/fle-link.js';
import { konfigurationLaden } from '../src/config.js';
import { erstelleServer } from '../src/server.js';

const HAUPT = 'haupt-geheimnis-0123456789';
const FLE = 'fle-link-geheimnis-0123456789';

function attrappe(extra = {}) {
  const r = {
    gesendet: [],
    abgebrochen: [],
    entschieden: [],
    root: { id: 7 },
    ruhe: { sperrtMax: () => false },
    ruheZustand: () => ({}),
    sende: async (id, text, o) => {
      r.gesendet.push({ id, text, art: o.art, requestId: o.requestId });
      return { id: 'n1', art: o.art };
    },
    ansicht: async (id) => ({ id, entries: [{ id: 'e1', kind: 'fyos.mensch', data: { text: 'hallo' } }] }),
    abbrechen: async (id) => void r.abgebrochen.push(id),
    freigaben: async () => [
      { id: 'f1', status: 'offen', aktion: 'Löschen', kontext: 'Warum', befehl: 'rm x', risiko: 'high' },
      { id: 'f2', status: 'erteilt', aktion: 'Alt', kontext: 'x', befehl: null },
    ],
    entscheideFreigabe: async (id) => {
      r.entschieden.push(id);
      return [];
    },
    health: async () => ({ agent: 'persona' }),
    watchConversation: async () => ({
      snapshot: { type: 'snapshot', entries: [] },
      start: (fn) => void setImmediate(() => fn([{ type: 'run_end' }])),
      stop: async () => {},
    }),
    ...extra,
  };
  return r;
}

async function mitServer(runner, fn) {
  const cfg = { pi_durable: { security: { token: HAUPT, tokens: { 'fle-link': FLE }, allowedOrigins: [] }, limits: { maxBodyBytes: 65536 }, clientDir: '/tmp' } };
  const server = erstelleServer({ runner, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const frage = (methode, pfad, koerper, token = FLE) =>
    new Promise((fertig, scheitern) => {
      const inhalt = koerper === undefined ? null : JSON.stringify(koerper);
      const q = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, agent: false, headers: { Authorization: `Bearer ${token}`, ...(inhalt ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => fertig({ status: res.statusCode, text, daten: text.startsWith('{') ? JSON.parse(text) : null }));
      });
      q.on('error', scheitern);
      q.end(inhalt);
    });
  const strom = (pfad) =>
    new Promise((fertig, scheitern) => {
      const q = http.get({ host: '127.0.0.1', port, path: pfad, agent: false, headers: { Authorization: `Bearer ${FLE}` } }, (res) => {
        let text = '';
        res.on('data', (d) => {
          text += d;
          if (text.includes('event: events')) {
            q.destroy();
            fertig({ status: res.statusCode, text });
          }
        });
      });
      q.on('error', (f) => (f.code === 'ECONNRESET' ? null : scheitern(f)));
    });
  try {
    await fn(frage, strom);
  } finally {
    server.closeAllConnections?.();
    await new Promise((ok) => server.close(ok));
  }
}

test('Nachricht geht als Folge-Nachricht ins Hauptgespräch', async () => {
  const r = attrappe();
  await mitServer(r, async (frage) => {
    const a = await frage('POST', '/api/message', { text: ' hallo ', requestId: 'q1' });
    assert.equal(a.status, 200);
    assert.deepEqual(r.gesendet, [{ id: 7, text: 'hallo', art: 'folgen', requestId: 'q1' }]);
    assert.equal((await frage('POST', '/api/message', { text: '  ' })).status, 400);
  });
});

test('Tiefe Ruhe hält auch diesen Weg an, wie in der App', async () => {
  const r = attrappe({ ruhe: { sperrtMax: () => true } });
  await mitServer(r, async (frage) => {
    assert.equal((await frage('POST', '/api/message', { text: 'x' })).status, 423);
    assert.deepEqual(r.gesendet, []);
  });
});

test('Verlauf, Abbruch und Strom betreffen das Hauptgespräch; der Strom nennt die Ereignisse events', async () => {
  const r = attrappe();
  await mitServer(r, async (frage, strom) => {
    assert.deepEqual((await frage('GET', '/api/conversation')).daten.entries.map((e) => e.kind), ['fyos.mensch']);
    assert.equal((await frage('POST', '/api/abort')).status, 200);
    assert.deepEqual(r.abgebrochen, [7]);
    const s = await strom('/api/stream');
    assert.equal(s.status, 200);
    assert.match(s.text, /event: snapshot/);
    assert.match(s.text, /event: events\ndata: \[\{"type":"run_end"\}\]/);
    assert.doesNotMatch(s.text, /event: ereignisse/);
  });
});

test('Freigaben: nur offene, in den Feldern von FLE Link', async () => {
  const r = attrappe();
  await mitServer(r, async (frage) => {
    assert.deepEqual((await frage('GET', '/api/approvals')).daten.approvals, [{ id: 'f1', status: 'open', action: 'Löschen', context: 'Warum', command: 'rm x' }]);
  });
});

test('Das Token fle-link reicht nur für die vereinbarten Wege', async () => {
  const r = attrappe();
  await mitServer(r, async (frage) => {
    for (const [m, p] of [['GET', '/api/gespraeche'], ['POST', '/api/ruhe'], ['GET', '/api/datei'], ['POST', '/api/steuern/neustart'], ['GET', '/api/verwaltung'], ['POST', '/api/gespraech/7/nachricht'], ['GET', '/']]) {
      assert.equal((await frage(m, p, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p}`);
    }
    assert.equal((await frage('GET', '/api/conversation')).status, 200);
  });
  assert.equal(fleLinkMay('GET', '/api/health'), true);
  assert.equal(fleLinkMay('GET', '/api/queue'), true);
  assert.equal(fleLinkMay('POST', '/api/agenda'), true);
  assert.equal(fleLinkMay('DELETE', '/api/agenda'), false);
});

test('Ohne Hauptgespräch sagt der Runner 503, unbekannte Methode 405', async () => {
  await mitServer(attrappe({ root: null }), async (frage) => {
    assert.equal((await frage('GET', '/api/conversation')).status, 503);
  });
  await mitServer(attrappe(), async (frage) => {
    assert.equal((await frage('GET', '/api/message', undefined, HAUPT)).status, 405);
  });
  assert.deepEqual(approvalsView(null), []);
});

test('Das Token kommt aus der Umgebung, zu kurz zählt nicht', () => {
  const basis = { arbeitsbereiche: { standard: { pfad: '/tmp' } } };
  assert.equal(konfigurationLaden(basis, { FYOS_FLE_LINK_TOKEN: 'x'.repeat(32) }).pi_durable.security.tokens['fle-link'], 'x'.repeat(32));
  assert.equal(konfigurationLaden(basis, { FYOS_FLE_LINK_TOKEN: 'kurz' }).pi_durable.security.tokens?.['fle-link'], undefined);
});
