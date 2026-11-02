/**
 * documents.js — the durable state next to the conversations, in the same SQLite file and the same commits.
 */
import { defineDoc } from './pi.js';

const never = () => false;

/** Events accepted for the agent and not handed over yet. A restart loses none of them. */
export const Queue = defineDoc({
  kind: 'fle.queue',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, entries: [], recent: [], paused: false, pausedSince: null, seen: 0 }),
  checkpointWhen: never,
});

/** Approvals: only destructive steps wait for a human. One document, so the list is right in one commit. */
export const Approvals = defineDoc({
  kind: 'fle.approvals',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, entries: {} }),
  checkpointWhen: never,
});

/** What each source remembers between rounds (cursors, last runs). */
export const SourceState = defineDoc({
  kind: 'fle.sources',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, by: {} }),
  checkpointWhen: never,
});
