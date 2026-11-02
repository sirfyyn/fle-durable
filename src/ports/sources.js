/**
 * ports/sources.js — the builtin event sources.
 *
 *   agenda   planned at runtime by the owner or the agent (../agenda.js)
 *
 * The webhook (`POST /api/events`) and the owner's chat are no sources of their own: the server enqueues directly.
 * Your own source is a module with `create(ctx)` (see contracts.js, examples/folder-source.js).
 */
import { agendaSource } from '../agenda.js';

export const builtinSources = Object.freeze({
  agenda: {
    builtin: true,
    create: ({ agenda, enqueue, options, log }) => agendaSource({ store: agenda, enqueue, options, log }),
  },
});
