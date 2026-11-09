/**
 * platform/tools.js — the agent's tools on its own tickets and calendar. It always acts as itself: a tool can never answer in the
 * owner's name, close a ticket, or grant an approval. A call replayed after a crash gets its first answer back (memo + once).
 */
import { Schema as Type, werkzeug as defineTool } from '../lauf/index.js';
import { TICKET_TYPES, SEVERITIES, STATUSES, TicketError } from './tickets.js';

const result = (text, details) => ({ output: [{ type: 'text', text: String(text) }], ...(details ? { details } : {}) });
const refused = (fehler) => {
  if (fehler instanceof TicketError) return result(`Refused: ${fehler.message}`);
  throw fehler;
};
const line = (t) => `${t.id}  ${t.status}  ${t.severity}  @${t.assignee}  „${t.title}“${t.waiting_for ? `  waiting for ${t.waiting_for}` : ''}${t.wiedervorlage ? `  follow-up ${t.wiedervorlage}` : ''}`;

async function requestId(api, context, name) {
  if (typeof api?.memo !== 'function') return null;
  return api.memo(`${name}_request`, `${name}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, context);
}

const Literals = (values) => Type.Union(values.map((v) => Type.Literal(v)));

export function platformTools(platform) {
  const tools = () => platform().tickets;
  const calendar = () => platform().calendar;
  const me = () => tools().agent;
  return [
    defineTool({
      name: 'ticket_create',
      description:
        'Create a ticket: work with a memory over days. INC = something broke, PRB = a measured defect, CHG = a decided change, VOR = an idea nobody wanted yet. ' +
        'Your plans (CHG, VOR) start in triage and wait for the owner. fingerprint: the same one counts as another occurrence instead of a new ticket.',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 300 }),
        type: Type.Optional(Literals(TICKET_TYPES)),
        description: Type.Optional(Type.String({ maxLength: 4000 })),
        severity: Type.Optional(Literals(SEVERITIES)),
        fingerprint: Type.Optional(Type.String({ maxLength: 200 })),
        links: Type.Optional(Type.String({ description: 'comma-separated ticket ids, "see also"' })),
        master: Type.Optional(Type.String({ description: 'the parent ticket' })),
        waiting_for: Type.Optional(Type.String({ maxLength: 200 })),
        wiedervorlage: Type.Optional(Type.String({ description: 'follow-up for triage: YYYY-MM-DD or +14t, +2w, +3m' })),
      }),
      replay: 'safe',
      execute: async (p, api, context) => {
        const id = await requestId(api, context, 'ticket_create');
        try {
          const out = tools().once(id, () => tools().create(p, { actor: me() }));
          return result(out.created ? `Created ${line(out.ticket)}` : `Counted on the existing ticket: ${line(out.ticket)} (occurrences ${out.ticket.occurrences})`, out);
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'ticket_get',
      description: 'Read one ticket with its history (newest first).',
      parameters: Type.Object({ id: Type.String({ minLength: 3, maxLength: 32 }) }),
      replay: 'safe',
      execute: async (p) => {
        try {
          const t = tools().detail(p.id, { history: 30 });
          return result(JSON.stringify(t, null, 1).slice(0, 24000), { ticket: t });
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'ticket_list',
      description: 'List tickets, newest change first. Without filters: all open ones. Use it before creating one, and to see your backlog.',
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: `comma-separated: ${STATUSES.join(', ')}` })),
        type: Type.Optional(Literals(TICKET_TYPES)),
        assignee: Type.Optional(Type.String()),
        q: Type.Optional(Type.String({ description: 'search text' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      replay: 'safe',
      execute: async (p) => {
        const out = tools().list({ status: 'new,triage,in_progress,waiting_approval', ...p });
        if (!out.tickets.length) return result('No tickets match.');
        return result(`${out.total} tickets\n${out.tickets.map(line).join('\n')}`, { total: out.total });
      },
    }),
    defineTool({
      name: 'ticket_update',
      description:
        'Change a ticket. status: new, triage (needs a follow-up date, default 14 days), in_progress, waiting_approval (a question to the owner; pass risiko, zerstoererisch and kontext, 3 to 5 sentences), resolved. ' +
        'Only the owner closes tickets and only the owner answers approvals. A closing note that hands work on turns resolved into waiting_approval.',
      parameters: Type.Object({
        id: Type.String({ minLength: 3, maxLength: 32 }),
        status: Type.Optional(Literals(STATUSES)),
        title: Type.Optional(Type.String({ maxLength: 300 })),
        description: Type.Optional(Type.String({ maxLength: 4000 })),
        severity: Type.Optional(Literals(SEVERITIES)),
        assignee: Type.Optional(Type.String()),
        waiting_for: Type.Optional(Type.String({ maxLength: 200 })),
        wiedervorlage: Type.Optional(Type.String()),
        links: Type.Optional(Type.String()),
        master: Type.Optional(Type.String()),
        master_begruendung: Type.Optional(Type.String({ maxLength: 2000 })),
        master_muster: Type.Optional(Type.String({ maxLength: 32 })),
        risiko: Type.Optional(Literals(['low', 'medium', 'high'])),
        zerstoererisch: Type.Optional(Type.Boolean()),
        kontext: Type.Optional(Type.String({ maxLength: 800 })),
      }),
      replay: 'safe',
      execute: async ({ id, ...patch }) => {
        try {
          const t = tools().update(id, patch, { actor: me() });
          return result(`Now: ${line(t)}`, { ticket: t });
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'ticket_comment',
      description: 'Add a comment to a ticket: what you found, did, measured. Comments stay in the history for good.',
      parameters: Type.Object({ id: Type.String({ minLength: 3, maxLength: 32 }), text: Type.String({ minLength: 1, maxLength: 20000 }) }),
      replay: 'safe',
      execute: async (p, api, context) => {
        const request = await requestId(api, context, 'ticket_comment');
        try {
          tools().once(request, () => tools().comment(p.id, p.text, { actor: me() }));
          return result(`Comment added to ${p.id}.`);
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'calendar_list',
      description: 'The calendar in a time window (default the next 7 days), with every source that could not be read: an empty answer only means empty if none is missing.',
      parameters: Type.Object({
        from: Type.Optional(Type.String({ description: 'ISO 8601' })),
        to: Type.Optional(Type.String({ description: 'ISO 8601' })),
      }),
      replay: 'safe',
      execute: async (p) => {
        try {
          const w = calendar().window(p);
          const lines = w.entries.map((e) => `${e.id}  ${e.from} → ${e.to}  „${e.title}“${e.exklusiv ? `  exclusive ${e.exklusiv}` : ''}${e.ticket ? `  ${e.ticket}` : ''}`);
          const gaps = w.unreachable.map((u) => `NOT READABLE: ${u.source} (${u.reason})`);
          return result([...lines, ...gaps].join('\n') || 'Nothing planned in this window.', w);
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'calendar_add',
      description:
        'Put something on the calendar. exklusiv: a target (a machine, a resource) that is taken during this time; ask calendar_busy before heavy work on it. ' +
        'remind_min: you get an event that many minutes before the start.',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        from: Type.String({ description: 'ISO 8601' }),
        to: Type.Optional(Type.String({ description: 'ISO 8601, default one hour later' })),
        description: Type.Optional(Type.String({ maxLength: 4000 })),
        location: Type.Optional(Type.String({ maxLength: 200 })),
        ticket: Type.Optional(Type.String({ maxLength: 32 })),
        exklusiv: Type.Optional(Type.String({ maxLength: 64 })),
        remind_min: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      replay: 'safe',
      execute: async (p, api, context) => {
        const request = await requestId(api, context, 'calendar_add');
        try {
          const e = calendar().once(request, () => calendar().add(p, { actor: me() }));
          return result(`Planned ${e.id} „${e.title}“ ${e.from} → ${e.to}.`, { entry: e });
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'calendar_update',
      description: 'Change or move a calendar entry. Only `from` moves it and keeps its length; `from` and `to` together re-lay it.',
      parameters: Type.Object({
        id: Type.String({ minLength: 2, maxLength: 40 }),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        from: Type.Optional(Type.String()),
        to: Type.Optional(Type.String()),
        description: Type.Optional(Type.String({ maxLength: 4000 })),
        ticket: Type.Optional(Type.String({ maxLength: 32 })),
        exklusiv: Type.Optional(Type.String({ maxLength: 64 })),
        remind_min: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      replay: 'safe',
      execute: async ({ id, ...patch }) => {
        try {
          const e = calendar().update(id, patch, { actor: me() });
          return result(`Now ${e.id} „${e.title}“ ${e.from} → ${e.to}.`, { entry: e });
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
    defineTool({
      name: 'calendar_busy',
      description: 'Is a target exclusively taken now? Ask before heavy work on a shared machine. `unknown` means wait, not go.',
      parameters: Type.Object({ target: Type.String({ minLength: 1, maxLength: 64 }), at: Type.Optional(Type.String({ description: 'ISO 8601, default now' })) }),
      replay: 'safe',
      execute: async (p) => {
        try {
          const b = calendar().busy(p.target, p.at);
          if (b.unknown) return result(`Unknown: ${b.reason}. Wait.`, b);
          return result(b.busy ? `${p.target} is taken: „${b.by.title}“ until ${b.by.to}.` : `${p.target} is free.`, b);
        } catch (fehler) {
          return refused(fehler);
        }
      },
    }),
  ];
}
