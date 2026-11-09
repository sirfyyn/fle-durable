/**
 * platform/envelope.js — one vocabulary for events on both sides (docs/current/RUNNER-SECO.md, step 1).
 *
 * Three forms exist and stay: the hub's envelope (plugins/seco/fyos_plugin_seco/_umschlag.py), the hub inbox (`_agenteneingang.py`) and
 * this runner's bus. They differ in names and in their severity scales. This module is the only place that translates, so a bridge
 * never guesses. Pure, no I/O. The cases in test/fixtures/umschlag-vertrag.json are checked from both languages.
 */
const SEVERITY_FROM_ENVELOPE = Object.freeze({ info: 'low', normal: 'medium', hoch: 'high', kritisch: 'critical' });
const SEVERITY_TO_ENVELOPE = Object.freeze({ low: 'info', medium: 'normal', high: 'hoch', critical: 'kritisch' });
// The inbox has three steps and the reflexes read its words, so critical counts as its highest step.
const SEVERITY_TO_INBOX = Object.freeze({ low: 'niedrig', medium: 'mittel', high: 'hoch', critical: 'hoch' });
const NAME = /[^a-z0-9._:-]/g;
const TEXT_FIELDS = ['text', 'titel', 'grund', 'ergebnis', 'status'];

const clean = (value) => {
  const text = String(value ?? '').toLowerCase().replace(NAME, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  return text || null;
};

/** Severity word of this bus for the hub inbox; what the reflexes and the alarm calm read. */
export const inboxSeverity = (severity) => SEVERITY_TO_INBOX[severity] ?? null;

/** Hub envelope → event for `Bus.publish`, or null if it names no topic. The event's own time stays in `data.occurred_at` (ms). */
export function busEventFromEnvelope(envelope) {
  const topic = clean(envelope?.thema);
  if (!topic) return null;
  const daten = envelope.daten && typeof envelope.daten === 'object' ? envelope.daten : {};
  const detail = TEXT_FIELDS.map((field) => daten[field]).find((value) => value !== undefined && value !== null && value !== '');
  const ref = envelope.verweis ?? null;
  return {
    topic,
    id: String(envelope.id ?? ''),
    source: clean(envelope.quelle) ?? 'hub',
    severity: SEVERITY_FROM_ENVELOPE[envelope.schwere] ?? 'medium',
    text: `${topic}${ref ? ` ${ref}` : ''}${detail === undefined ? '' : `: ${detail}`}`,
    ref,
    from: envelope.von ?? null,
    data: { ...daten, stream: envelope.strom ?? null, occurred_at: Number(envelope.zeit_unix) > 0 ? Math.round(Number(envelope.zeit_unix) * 1000) : null },
  };
}

/** Stored bus event → hub envelope, for a bridge going the other way. */
export function envelopeFromBusEvent(event) {
  const { stream = null, occurred_at: occurredAt = null, ...daten } = event?.data && typeof event.data === 'object' ? event.data : {};
  const ms = Number(occurredAt) > 0 ? Number(occurredAt) : Number(event?.t) || 0;
  return {
    id: String(event?.id ?? ''),
    strom: stream ?? `runner:${event?.topic ?? ''}`,
    thema: event?.topic ?? null,
    zeit: ms ? new Date(ms).toISOString() : null,
    zeit_unix: ms ? ms / 1000 : 0,
    schwere: SEVERITY_TO_ENVELOPE[event?.severity] ?? 'normal',
    quelle: event?.source ?? null,
    verweis: event?.ref ?? null,
    von: event?.from ?? null,
    daten,
  };
}

/** Same rule as `passt` in _umschlag.py: exact, `prefix.*` or `*`. */
export function topicMatches(topic, patterns) {
  return (patterns ?? []).some((pattern) => pattern === '*' || pattern === topic || (pattern.endsWith('.*') && String(topic).startsWith(pattern.slice(0, -1))));
}
