/**
 * Zeigt Vorgänge, Kalender und Ereignisse der Hülle (apps/fyos-shell, Profil agent) gegen einen echten Runner mit Faux-Modell und Beispieldaten:
 *   node test/hilfen/plattform-vorfuehren.mjs [port]   →   http://127.0.0.1:8778/
 * Nur Testwerte in einem Temp-Ordner; nie gegen Hauptserver oder den Produktivrunner.
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { starte } from './agent-chat-pruefstand.js';

const HIER = dirname(fileURLToPath(import.meta.url));
const ps = await starte({
  port: Number(process.argv[2]) || 8778,
  ui: join(HIER, '..', '..', '..', '..', '..', 'apps', 'fyos-shell', 'app', 'ui', 'agent'),
  startseite: '/chat.html',
  konfig: { owner: 'besitzer', agent: 'agent', platform: { an: true } },
});
ps.faux.setResponses([fauxAssistantMessage('Beispielantwort.')]);

const { tickets, calendar, bus } = ps.runner.platform;
const ich = { actor: 'besitzer' };
const agent = { actor: 'agent' };
const kontext = 'Wir starten den Dienst neu. Das ändert nur den laufenden Prozess. Betroffen ist der Rechenknoten. Zurück geht es mit einem weiteren Neustart.';
const offen = tickets.create({ type: 'CHG', title: 'Rechenknoten neu starten', status: 'waiting_approval', severity: 'high', risiko: 'medium', zerstoererisch: false, kontext, description: 'Nach dem Treiber-Update nötig.' }, agent).ticket;
tickets.create({ type: 'INC', title: 'Build auf main ist rot', severity: 'critical', fingerprint: 'ci-main', source: 'webhook' }, { actor: 'webhook' });
tickets.create({ type: 'INC', title: 'Build auf main ist rot', severity: 'critical', fingerprint: 'ci-main', description: 'wieder' }, { actor: 'webhook' });
const arbeit = tickets.create({ type: 'PRB', title: 'Speicher wächst über Nacht', severity: 'medium' }, ich).ticket;
tickets.update(arbeit.id, { status: 'in_progress' }, agent);
tickets.comment(arbeit.id, 'Messung läuft, erste Kurve sieht nach einem Leck im Cache aus.', agent);
tickets.create({ type: 'VOR', title: 'Backup auf zweiten Standort spiegeln', wiedervorlage: '+14t' }, agent);
tickets.create({ type: 'VOR', title: 'Nachtlauf für die Doku', severity: 'low' }, agent);
const fertig = tickets.create({ type: 'INC', title: 'Zertifikat lief ab', severity: 'high' }, ich).ticket;
tickets.update(fertig.id, { status: 'resolved' }, agent);

const heute = new Date();
heute.setHours(0, 0, 0, 0);
const am = (tage, stunde, minute = 0) => new Date(heute.getTime() + tage * 86_400_000 + stunde * 3_600_000 + minute * 60_000).toISOString();
calendar.add({ title: 'Wartung Rechenknoten', from: am(0, 18), to: am(0, 20), exklusiv: 'rechenknoten', ticket: offen.id }, ich);
calendar.add({ title: 'Lasttest', from: am(1, 9), to: am(1, 11, 30), exklusiv: 'rechenknoten' }, agent);
calendar.add({ title: 'Sprechstunde', from: am(1, 14), location: 'Büro', remind_min: 15 }, ich);
calendar.add({ title: 'Release vorbereiten', from: am(2, 10), to: am(2, 12), ticket: arbeit.id }, agent);

bus.publish({ id: 'ci-1', source: 'ci', text: 'Build 412 auf main fehlgeschlagen', severity: 'high', ref: 'CI-412', from: 'ci' });
bus.publish({ id: 'chat-1', source: 'web', text: 'Schau bitte heute noch auf den Build.' }, { owner: true });
bus.publish({ id: 'wh-1', source: 'webhook', text: 'Paket zugestellt', from: 'shop' });

console.log(`Prüfstand: ${ps.basis}/  (Strg+C beendet)`);
process.on('SIGINT', async () => {
  await ps.stopp();
  process.exit(0);
});
