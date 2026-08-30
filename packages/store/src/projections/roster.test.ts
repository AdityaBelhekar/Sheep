import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainEventType } from '@sheep/core';
import { EVENT_FIXTURES, PARTICIPANT_A, PARTICIPANT_B, SESSION_ID } from '@sheep/core/fixtures';
import { describe, expect, it } from 'vitest';
import { EventLog } from '../events/log';
import type { JsonValue } from '../events/json';
import { MIGRATIONS } from '../migrations/definitions';
import { runMigrations } from '../migrations/runner';
import { openDatabase } from '../sqlite/open';
import type { SqliteDatabase, SqliteDriverName } from '../sqlite/types';
import { TESTABLE_DRIVERS, useTempDir } from '../test-support';
import { ProjectionRunner } from './runner';
import { SESSIONS_PROJECTION, getParticipant, getSession, listParticipants } from './sessions';

const tempDir = useTempDir('sheep-roster-');

let counter = 0;

interface Harness {
  readonly db: SqliteDatabase;
  emit(type: DomainEventType, overrides?: Record<string, unknown>): void;
  /** The whole payload, so a test can prove what an *absent* field means. */
  emitPayload(type: DomainEventType, payload: Record<string, unknown>): void;
  catchUp(): void;
  rebuild(): void;
  close(): void;
}

function harness(driver: SqliteDriverName): Harness {
  counter += 1;
  const dir = join(tempDir(), `run-${String(counter)}`);
  mkdirSync(dir, { recursive: true });

  const opened = openDatabase({ path: join(dir, 'sheep.sqlite'), driver });
  runMigrations(opened.db, { migrations: MIGRATIONS });

  let clock = Date.parse('2026-08-30T09:00:00.000Z');
  const log = new EventLog(opened.db, {
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
  });
  const runner = new ProjectionRunner(opened.db, log);
  runner.ensure();

  return {
    db: opened.db,
    emit(type, overrides) {
      const payload = { ...EVENT_FIXTURES[type], ...overrides } as unknown as JsonValue;
      log.append({ type, payload, sessionId: type === 'app.started' ? null : SESSION_ID });
    },
    emitPayload(type, payload) {
      log.append({ type, payload: payload as JsonValue, sessionId: SESSION_ID });
    },
    catchUp() {
      runner.catchUp(SESSIONS_PROJECTION);
    },
    rebuild() {
      runner.rebuild(SESSIONS_PROJECTION);
    },
    close() {
      opened.db.close();
    },
  };
}

/** A second participant on different weights, so vendor diversity is testable. */
const SECOND = {
  participantId: PARTICIPANT_B,
  model: {
    connectionId: EVENT_FIXTURES['roster.model-attached'].model.connectionId,
    vendorId: 'openai',
    modelId: 'gpt-5',
  },
  weight: 0.5,
};

describe.each(TESTABLE_DRIVERS)('the roster projection on %s', (driver) => {
  it('projects an attached model with its full provenance', () => {
    const h = harness(driver);
    try {
      h.emit('session.created');
      h.emit('roster.model-attached');
      h.catchUp();

      const fixture = EVENT_FIXTURES['roster.model-attached'];
      expect(listParticipants(h.db, SESSION_ID)).toEqual([
        {
          participantId: PARTICIPANT_A,
          sessionId: SESSION_ID,
          model: fixture.model,
          weight: fixture.weight,
          budgetCapUsd: fixture.budgetCapUsd,
          preferredRole: fixture.preferredRole,
          attachedAt: '2026-08-30T09:00:02.000Z',
          detachedAt: null,
        },
      ]);
    } finally {
      h.close();
    }
  });

  it('counts attached models on the session row', () => {
    const h = harness(driver);
    try {
      h.emit('session.created');
      h.emit('roster.model-attached');
      h.emit('roster.model-attached', SECOND);
      h.catchUp();

      expect(getSession(h.db, SESSION_ID)?.participantCount).toBe(2);
    } finally {
      h.close();
    }
  });

  it('restates a participant in full rather than patching it', () => {
    const h = harness(driver);
    try {
      h.emit('session.created');
      h.emit('roster.model-attached');
      // Both optionals absent: the payload says this participant now has
      // neither a cap nor a preferred role, not that they are unchanged.
      h.emitPayload('roster.model-reconfigured', {
        sessionId: SESSION_ID,
        participantId: PARTICIPANT_A,
        weight: 0,
      });
      h.catchUp();

      const entry = getParticipant(h.db, PARTICIPANT_A);
      expect(entry?.weight).toBe(0);
      expect(entry?.budgetCapUsd).toBeNull();
      expect(entry?.preferredRole).toBeNull();
    } finally {
      h.close();
    }
  });

  it('keeps a detached model in the roster but out of the count', () => {
    const h = harness(driver);
    try {
      h.emit('session.created');
      h.emit('roster.model-attached');
      h.emit('roster.model-attached', SECOND);
      h.emit('roster.model-detached', { participantId: PARTICIPANT_B });
      h.catchUp();

      expect(getSession(h.db, SESSION_ID)?.participantCount).toBe(1);
      // Still listed: it may have authored messages that are still in the record.
      expect(listParticipants(h.db, SESSION_ID)).toHaveLength(2);
      expect(listParticipants(h.db, SESSION_ID, { attachedOnly: true })).toHaveLength(1);
      expect(getParticipant(h.db, PARTICIPANT_B)?.detachedAt).toBe('2026-08-30T09:00:04.000Z');
    } finally {
      h.close();
    }
  });

  it('lets a detached model be attached again', () => {
    const h = harness(driver);
    try {
      h.emit('session.created');
      h.emit('roster.model-attached');
      h.emit('roster.model-detached', { participantId: PARTICIPANT_A });
      h.emit('roster.model-attached');
      h.catchUp();

      expect(getParticipant(h.db, PARTICIPANT_A)?.detachedAt).toBeNull();
      expect(getSession(h.db, SESSION_ID)?.participantCount).toBe(1);
    } finally {
      h.close();
    }
  });

  /**
   * The property that makes the projected tables disposable: replaying the log
   * over rows that already reflect it must not double anything.
   */
  it('lands on the same rows whether folded once or replayed', () => {
    const h = harness(driver);
    try {
      h.emit('session.created');
      h.emit('roster.model-attached');
      h.emit('roster.model-attached', SECOND);
      h.emit('roster.model-reconfigured', { participantId: PARTICIPANT_A, weight: 2 });
      h.emit('roster.model-detached', { participantId: PARTICIPANT_B });
      h.catchUp();

      const once = listParticipants(h.db, SESSION_ID);
      const countOnce = getSession(h.db, SESSION_ID)?.participantCount;

      h.rebuild();

      expect(listParticipants(h.db, SESSION_ID)).toEqual(once);
      expect(getSession(h.db, SESSION_ID)?.participantCount).toBe(countOnce);
    } finally {
      h.close();
    }
  });

  it('keeps two rosters apart', () => {
    const h = harness(driver);
    const other = '9c0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    try {
      h.emit('session.created');
      h.emit('session.created', { sessionId: other, title: 'Other', question: 'Something else' });
      h.emit('roster.model-attached');
      h.emit('roster.model-attached', { ...SECOND, sessionId: other });
      h.catchUp();

      expect(listParticipants(h.db, SESSION_ID)).toHaveLength(1);
      expect(listParticipants(h.db, other)).toHaveLength(1);
      expect(getSession(h.db, other)?.participantCount).toBe(1);
    } finally {
      h.close();
    }
  });
});
