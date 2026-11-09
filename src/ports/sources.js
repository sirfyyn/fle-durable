/**
 * ports/sources.js — the builtin event sources of FLE Durable (port `sources`, ports/contracts.js).
 *
 *   schedule  timed events (takt.js): daily, weekly, every N minutes
 *   jobs      a background job finished (jobs.js)
 *   agenda    planned at runtime by the owner or the agent (agenda.js)
 *
 * The webhook (`POST /api/events`) is no source of its own: the server enqueues directly, like the chat.
 *
 * Each entry wraps the existing class without changing it; `inner` is the class itself for the parts of the runner that need
 * more than the contract (control channel, work loop).
 */
import { Jobmeldungen } from '../jobs.js';
import { Taktgeber } from '../takt.js';
import { busSource } from '../platform/bus.js';
import { calendarClock } from '../platform/calendar.js';
import { ticketClock } from '../platform/tickets.js';
import { agendaSource } from './agenda.js';

/** Wrap an object with start/stop/zustand into the `sources` contract. */
export function asSource(inner, extra = {}) {
  return {
    inner,
    start: () => inner.start(),
    stop: () => inner.stop(),
    state: () => inner.zustand?.() ?? null,
    ...extra,
  };
}

/** A source that does nothing (switched off by its own config, e.g. jobs without a folder). */
export const idleSource = () => ({ inner: null, start() {}, stop() {}, state: () => null });

export const builtinSources = Object.freeze({
  schedule: {
    builtin: true,
    create: ({ cfg, hub, harness, enqueue, runner }) =>
      asSource(
        new Taktgeber({
          cfg,
          hub,
          harness,
          einreihen: enqueue,
          ruhe: runner?.ruhe ?? null,
          nachtwerkstatt: runner ? (opt) => runner.nachtwerkstattStarten(opt) : undefined,
        }),
      ),
  },
  jobs: {
    builtin: true,
    create: ({ cfg, enqueue }) => (Jobmeldungen.aktiv(cfg) ? asSource(new Jobmeldungen({ cfg, einreihen: enqueue })) : idleSource()),
  },
  // What the owner and the agent planned at runtime (ports/agenda.js); only with `agenda.an`, the store belongs to the runner.
  agenda: {
    builtin: true,
    create: ({ runner, enqueue, options }) => (runner?.agendaAn ? agendaSource({ store: runner.agenda, enqueue, options }) : idleSource()),
  },
  // The runner's own platform (src/platform/, `platform.an`): the inbox topic of its bus goes to the agent; both clocks only move
  // things onto that bus. Without the platform these do nothing.
  bus: {
    builtin: true,
    create: ({ runner, enqueue }) => (runner?.platform ? busSource({ bus: runner.platform.bus, enqueue }) : idleSource()),
  },
  tickets: {
    builtin: true,
    create: ({ runner, options }) => (runner?.platform ? ticketClock({ tickets: runner.platform.tickets, everyS: options?.every_s }) : idleSource()),
  },
  calendar: {
    builtin: true,
    create: ({ runner, options }) => (runner?.platform ? calendarClock({ calendar: runner.platform.calendar, everyS: options?.every_s }) : idleSource()),
  },
});
