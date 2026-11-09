/**
 * unteragent.js — der Agent gibt eine Aufgabe an sich selbst (Besitzer 19.10.: „bis zu 2 subagenten erlaubt“, 06.11.: volle Ausstattung, Nr. 814).
 *
 * Werkzeug `unteragent {aufgabe, art?, ordner?, frist_s?}` legt ein Kindgespräch an (derselbe Lauf wie `aufgabe_starten`), wartet auf das Ergebnis
 * und gibt es zurück. Das Kind hat alle Werkzeuge: Hub, Desktop, Browser. Der Unterschied zu `aufgabe_starten`: dort läuft die Arbeit im Hintergrund
 * und der Zug geht weiter; hier wartet der Zug. Früher startete dieses Werkzeug ein eigenes pi ohne Hub und Desktop.
 *
 *  - Höchstens 2 gleichzeitig. Zwei Aufrufe in einer Antwort laufen nebeneinander; am Modell wechseln sie sich ab, solange das Tor nur eine Anfrage
 *    zugleich durchlässt (deploy/hausmodell/hausmodell_tor.py). Sind beide Plätze belegt, sagt das Werkzeug es sofort, statt zu warten.
 *  - Ein Kind startet keine weiteren Kinder: sonst stünde am Ende jeder auf den anderen wartend vor demselben Modell.
 *  - Überlebt einen Neustart: Der wiederholte Aufruf findet seinen Lauf über die gemerkte Anfrage und wartet weiter.
 *  - `art=lesen` ist eine Anweisung, keine Sperre (Besitzer 24.10.: Beschränkungen weich, nur Zerstörendes geht durch eine Freigabe; die Wache gilt auch im Kind).
 *  - Desktop und Browser gibt es nur einmal: Mutter und Kinder teilen sie sich.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { AgentMeta, LaufListe } from './documents.js';
import { KONTEXT, Schema as Type, werkzeug as defineTool } from './lauf/index.js';
import { tx } from './i18n.js';

export const PLAETZE = 2;
const FRIST_VORGABE_S = 15 * 60;
const FRIST_MAX_S = 60 * 60;
const FRIST_MIN_S = 10;
const AUFGABE_MAX = 8000;
const AUSGABE_MAX = 16_000;
const QUELLE = 'unteragent';

const text = (t, details) => ({ output: [{ type: 'text', text: t }], ...(details !== undefined ? { details } : {}) });

function auftragFuer(aufgabe, art) {
  const regel = art === 'arbeiten'
    ? tx('Du darfst Befehle ausführen und Dateien ändern.', 'You may run commands and change files.')
    : tx('Nur lesen und nachsehen: Ändere nichts und führe nichts aus, was etwas verändert.', 'Only read and look things up: change nothing and run nothing that changes anything.');
  return [
    tx(
      'Du bist ein Unteragent. Erledige genau diese Aufgabe mit deinen Werkzeugen. Du hast keinen Rückkanal: Frage nicht nach, triff vernünftige Annahmen und nenne sie.',
      'You are a subagent. Do exactly this task with your tools. You have no way back: do not ask, make reasonable assumptions and name them.',
    ),
    regel,
    tx(
      'Deine letzte Nachricht ist das Ergebnis und geht unverändert an den Auftraggeber: knapp, mit Belegen, ohne Einleitung. Wenn etwas nicht geht, sag genau was.',
      'Your last message is the result and goes unchanged to whoever asked: short, with evidence, no preamble. If something does not work, say exactly what.',
    ),
    '',
    aufgabe,
  ].join('\n');
}

const titelVon = (aufgabe) => {
  const erste = aufgabe.split('\n')[0].trim();
  return `Unteragent: ${erste.length > 90 ? `${erste.slice(0, 89)}…` : erste}`;
};

const schlafen = (ms, signal) =>
  new Promise((fertig) => {
    const ende = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', ende);
      fertig();
    };
    const t = setTimeout(ende, ms);
    t.unref?.();
    signal?.addEventListener('abort', ende, { once: true });
  });

/**
 * @param harness  () => der offene Harness (das Werkzeug entsteht vor ihm)
 * @param Lauf, laufAnlegen  die Aufgabe aus lauf.js
 * @param cwdFuer  (conversationId) => Ordner des Gesprächs, wenn kein `ordner` angegeben ist
 */
export function unteragentWerkzeuge({ cfg, harness, Lauf, laufAnlegen, cwdFuer, fristMinS = FRIST_MIN_S, schrittMs = 500, jetzt = () => Date.now() } = {}) {
  const werkzeug = defineTool({
    name: 'unteragent',
    description: tx(
      'Gibt eine in sich geschlossene Aufgabe an einen Unteragenten (du selbst in einem eigenen Gespräch, mit frischem Kontext und allen Werkzeugen) und wartet auf sein Ergebnis. ' +
        `Höchstens ${PLAETZE} gleichzeitig; zwei Aufrufe in einer Antwort laufen nebeneinander. Die Aufgabe muss Pfade, Ziel und gewünschte Antwortform selbst nennen, er kennt dieses Gespräch nicht. ` +
        'art=lesen (Vorgabe) soll nur nachsehen, art=arbeiten darf ändern. Desktop und Browser gibt es nur einmal: gib sie nicht zwei zugleich. ' +
        'Für lange Arbeit, auf die du nicht warten willst, nimm aufgabe_starten. Sein Ergebnis prüfst du, bevor du es weitergibst.',
      'Hands a self-contained task to a subagent (yourself in a separate conversation, with fresh context and all tools) and waits for the result. ' +
        `At most ${PLAETZE} at a time; two calls in one answer run side by side. The task must name paths, goal and the wanted answer itself, the subagent does not know this conversation. ` +
        'art=lesen (default) should only look things up, art=arbeiten may change things. There is only one desktop and browser: do not give them to two at once. ' +
        'For long work you do not want to wait for, use aufgabe_starten. Check the result before you pass it on.',
    ),
    parameters: Type.Object({
      aufgabe: Type.String({ minLength: 10, maxLength: AUFGABE_MAX }),
      art: Type.Optional(Type.Union([Type.Literal('lesen'), Type.Literal('arbeiten')])),
      ordner: Type.Optional(Type.String({ maxLength: 500 })),
      frist_s: Type.Optional(Type.Integer({ minimum: FRIST_MIN_S, maximum: FRIST_MAX_S })),
    }),
    replay: 'safe',
    execute: async (p, api, context) => {
      const aufgabe = String(p?.aufgabe ?? '').trim();
      if (aufgabe.length < 10) return text(tx('Aufgabe zu kurz.', 'Task too short.'));
      const art = p?.art === 'arbeiten' ? 'arbeiten' : 'lesen';
      const h = harness();
      const elternId = api?.conversationId;

      const meta = elternId === undefined ? null : await h.snapshot(AgentMeta, elternId, KONTEXT).catch(() => null);
      if (String(meta?.aufrufer ?? '').startsWith('persona-kind')) {
        return text(tx('Ein Unteragent startet keine weiteren Unteragenten. Erledige es selbst.', 'A subagent starts no further subagents. Do it yourself.'));
      }

      let ordner = p?.ordner ? String(p.ordner) : null;
      if (!ordner) {
        const vomGespraech = await Promise.resolve(cwdFuer?.(elternId)).catch(() => null);
        ordner = vomGespraech ?? cfg?.arbeitsbereiche?.standard?.pfad ?? process.cwd();
      }
      if (!ordner.startsWith('/') || !existsSync(ordner) || !statSync(ordner).isDirectory()) {
        return text(tx(`Ordner „${ordner}“ gibt es nicht (absoluter Pfad nötig).`, `Folder “${ordner}” does not exist (absolute path needed).`));
      }
      const fristS = Number.isInteger(p?.frist_s) ? Math.min(FRIST_MAX_S, Math.max(fristMinS, p.frist_s)) : FRIST_VORGABE_S;
      const anfrage = typeof api?.memo === 'function' ? await api.memo('unteragent_anfrage', randomUUID(), context) : randomUUID();
      const t0 = jetzt();

      // In einer Transaktion: Platz prüfen und Lauf anlegen, damit zwei Aufrufe in einer Antwort nicht beide den letzten Platz bekommen.
      let id = null;
      let bis = t0 + fristS * 1000;
      await api.commit(async (doc) => {
        const liste = await doc.doc(LaufListe);
        const alle = Object.values(liste.eintraege ?? {});
        const schon = alle.find((e) => e.anfrage === anfrage);
        if (schon) {
          id = schon.id;
          bis = schon.frist_bis ?? bis;
          return;
        }
        // Ein Eintrag über seine Frist hinaus zählt nicht mehr: ein gestorbener Lauf darf keinen Platz für immer halten.
        const belegt = alle.filter((e) => e.quelle === QUELLE && e.status === 'laeuft' && Number(e.frist_bis ?? 0) > t0).length;
        if (belegt >= PLAETZE) return;
        id = await laufAnlegen(doc, Lauf, { titel: titelVon(aufgabe), auftrag: auftragFuer(aufgabe, art), cwd: ordner, quelle: QUELLE, elternId });
        const e = liste.eintraege[String(id)];
        e.anfrage = anfrage;
        e.frist_bis = bis;
        e.art = art;
      }, context);
      if (id === null) {
        return text(tx(
          `Beide Plätze für Unteragenten sind belegt (höchstens ${PLAETZE} gleichzeitig). Warte auf ein anderes Ergebnis oder erledige es selbst.`,
          `Both subagent places are taken (at most ${PLAETZE} at a time). Wait for another result or do it yourself.`,
        ));
      }

      const abbrechen = () => h.abortTask(Number(id), KONTEXT).catch(() => {});
      const signal = context?.signal;
      const kopf = () => `Unteragent (${art}, ${Math.round((jetzt() - t0) / 1000)} s)`;
      for (;;) {
        if (signal?.aborted) {
          await abbrechen();
          return text(`${kopf()} ${tx('beendet: Zug abgebrochen.', 'ended: turn aborted.')}`, { lauf: id, art, grund: 'abgebrochen' });
        }
        const doc = await h.snapshot(LaufListe, KONTEXT);
        const e = doc?.eintraege?.[String(id)];
        if (e && e.status !== 'laeuft') {
          const details = { lauf: id, art, status: e.status, kind: e.kindId ?? null };
          if (e.status === 'abgeschlossen') {
            const a = String(e.antwort ?? '');
            if (!a) return text(`${kopf()}: ${tx('keine Antwort.', 'no answer.')}`, details);
            return text(`${kopf()}:\n${a.length > AUSGABE_MAX ? `[… vorn gekürzt]\n${a.slice(-AUSGABE_MAX)}` : a}`, details);
          }
          return text(`${kopf()} ${tx('fehlgeschlagen', 'failed')} (${e.status}): ${String(e.fehler ?? e.notiz ?? tx('ohne Meldung', 'no message')).slice(0, 800)}`, details);
        }
        // Ein Lauf kann enden, ohne seinen Eintrag zu ändern (Fehler in einer Phase): dann zählt, was die Aufgabe selbst sagt.
        const aufgabeStand = await h.getTask(Number(id), KONTEXT).catch(() => null);
        if (aufgabeStand?.state?.status === 'terminal' && e?.status === 'laeuft') {
          const outcome = aufgabeStand.state.outcome;
          return text(`${kopf()} ${tx('fehlgeschlagen', 'failed')}: ${String(outcome?.error?.message ?? outcome?.reason ?? outcome?.status ?? tx('ohne Meldung', 'no message')).slice(0, 800)}`, { lauf: id, art, status: 'fehler' });
        }
        if (jetzt() >= bis) {
          await abbrechen();
          return text(`${kopf()} ${tx(`beendet: Zeitgrenze von ${fristS} s erreicht.`, `ended: time limit of ${fristS} s reached.`)}`, { lauf: id, art, grund: 'frist', kind: e?.kindId ?? null });
        }
        await schlafen(schrittMs, signal);
      }
    },
  });
  return [werkzeug];
}
