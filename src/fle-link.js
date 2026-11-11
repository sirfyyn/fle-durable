/**
 * fle-link.js — the door FLE Link's chat talks to (decisions 879 and 881, docs/current/FYOS-CLIENT-PROTOKOLL.md#fle-link).
 *
 * The chat in FLE Link is the agent's main conversation. These routes are the agreed contract and map onto what the runner already does, so a
 * future FLE Durable can offer the same ones. The token named `fle-link` reaches only this list. FLE Link shows approvals but never decides them:
 * that stays with the app, so there is no route that decides and the existing one is out of reach for this token.
 */
export const FLE_LINK_CALLER = 'fle-link';

import { isOwnerClass } from './ports/contracts.js';

const OWN_ROUTES = new Set(['/api/message', '/api/conversation', '/api/stream', '/api/abort', '/api/approvals']);
const ALLOWED = new Set([
  'GET /api/health',
  'POST /api/message',
  'GET /api/conversation',
  'GET /api/stream',
  'POST /api/abort',
  'GET /api/approvals',
  'GET /api/agenda',
  'POST /api/agenda',
  'GET /api/queue',
]);

export const isFleLinkRoute = (path) => OWN_ROUTES.has(path) || path.startsWith('/api/approvals/');
export const fleLinkMay = (method, path) => ALLOWED.has(`${method} ${path}`);

/**
 * The queue in the shape FLE Link expects (its Agent page reads `entries`, `source`, `priority`, `accepted`): since the
 * full runner became FLE Durable (0.2.0) the page got the runner's own field names and showed nothing waiting.
 * `model`: the model gate's last answer ({open, reason}), null without a gate.
 */
export const queueView = (eintraege, { modell = null } = {}) => ({
  entries: (eintraege ?? []).map((e) => ({
    id: e.id,
    source: e.quelle,
    from: e.von,
    priority: isOwnerClass(e.klasse) ? 'owner' : 'background',
    ref: e.bezug ?? null,
    accepted: e.angenommen,
    text: e.text,
  })),
  model: modell ? { open: modell.offen, reason: modell.grund } : null,
});

/**
 * `GET /api/health` in English, next to the runner's own fields (FLE Durable only: its README names model, storage,
 * queue and sources, and someone who reads the API should not need German for that).
 */
export const healthView = (h, { cfg, waiting = 0, paused = false, sources = [], model = null } = {}) => ({
  device: h?.geraet ?? null,
  conversations: h?.gespraeche ?? 0,
  storage: h?.speicher ?? null,
  model: { name: cfg?.pi_durable?.model?.default ?? null, url: cfg?.pi_durable?.model?.baseUrl ?? null, answers: model ? model.offen : null },
  queue: { waiting, paused },
  sources,
  time: h?.zeit ?? null,
});

/** Open approvals in the shape FLE Link expects. */
export const approvalsView = (approvals) =>
  (approvals ?? []).filter((a) => a.status === 'offen').map((a) => ({ id: a.id, status: 'open', action: a.aktion, context: a.kontext, command: a.befehl ?? null }));

export async function routeFleLink({ req, res, path, method, runner, readJson, json, stream, error, modellTor = null }) {
  if (path.startsWith('/api/approvals/') && method === 'POST') {
    const body = await readJson(req);
    const entscheidung = body.decision === 'granted' ? 'erteilt' : 'abgelehnt';
    await runner.entscheideFreigabe(decodeURIComponent(path.slice('/api/approvals/'.length)), { entscheidung, notiz: body.note, von: 'owner' });
    json(res, 200, { ok: true, approvals: approvalsView(await runner.freigaben()) });
    return;
  }
  const rootId = runner.root?.id;
  if (rootId === undefined) throw error(503, 'Der Runner startet noch');
  if (path === '/api/message' && method === 'POST') {
    if (runner.ruhe?.sperrtMax()) throw error(423, 'Ruhe (tief): Nachrichten werden nicht bearbeitet, bis die Ruhe aufgehoben ist');
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    if (!text) throw error(400, 'text fehlt');
    // Ohne Modell bekäme die Nachricht drei Fehlversuche und wäre verbraucht: lieber gleich sagen, dass keines antwortet.
    if (modellTor && !(await modellTor.offen())) throw error(503, 'Das Modell antwortet nicht; die Nachricht wurde nicht angenommen');
    const sent = await runner.sende(rootId, text, { art: 'folgen', requestId: body.requestId });
    json(res, 200, { ok: true, ...sent });
    return;
  }
  if (path === '/api/conversation' && method === 'GET') {
    const view = await runner.ansicht(rootId, {});
    json(res, 200, { ok: true, entries: view?.entries ?? [] });
    return;
  }
  if (path === '/api/stream' && method === 'GET') {
    await stream(res, runner, rootId);
    return;
  }
  if (path === '/api/abort' && method === 'POST') {
    await runner.abbrechen(rootId);
    json(res, 200, { ok: true });
    return;
  }
  if (path === '/api/approvals' && method === 'GET') {
    json(res, 200, { ok: true, approvals: approvalsView(await runner.freigaben()) });
    return;
  }
  throw error(405, `${method} ist hier nicht erlaubt`);
}
