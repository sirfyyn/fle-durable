/**
 * platform/index.js — what the runner brings itself, so that it can run alone: event bus, tickets, calendar.
 * Linked systems attach through bridges (docs/current/RUNNER-EIGENSTAENDIG.md). Everything lives in one SQLite file (store.js).
 */
import { ownerName } from '../ports/contracts.js';
import { CalendarBridges } from './bridges.js';
import { Bus } from './bus.js';
import { Calendar } from './calendar.js';
import { PlatformStore, platformFile } from './store.js';
import { Tickets } from './tickets.js';

export function createPlatform(cfg, { now = () => Date.now() } = {}) {
  const store = new PlatformStore(platformFile(cfg));
  const bus = new Bus({ store, now });
  const tickets = new Tickets({
    store,
    bus,
    owner: ownerName(cfg),
    agent: String(cfg.agent || 'agent').toLowerCase(),
    actors: cfg.platform?.actors ?? {},
    zone: cfg.platform?.zone ?? cfg.agenda?.zone ?? cfg.takt?.zone ?? 'Europe/Berlin',
    now,
  });
  const calendar = new Calendar({ store, bus, actor: (name) => tickets.actor(name), now });
  return {
    store,
    bus,
    tickets,
    calendar,
    bridges: new CalendarBridges({ calendar, store, bus, now }),
    state: () => ({ file: store.file, bus: bus.state(), tickets: tickets.board().columns, waiting: tickets.waiting().anzahl }),
    close: () => store.close(),
  };
}

/** Who acts behind a token: the runner's own token is the owner; another known token acts under its name if registered, else as system. */
export function actorForToken(platform, name) {
  const { tickets } = platform;
  if (name === 'app' || name === 'lokal') return tickets.owner;
  return Object.hasOwn(tickets.actors, name) && name !== tickets.owner ? name : 'system';
}
