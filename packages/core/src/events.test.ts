import { describe, expect, it } from 'vitest';
import {
  DOMAIN_EVENT_TYPES,
  EVENT_PAYLOADS,
  EventPayloadError,
  UnknownEventTypeError,
  domainEvent,
  isDomainEventType,
  isSessionScoped,
  parseDomainEvent,
  payloadSchemaFor,
  safeParseDomainEvent,
  sessionIdOf,
  type DomainEventType,
} from './events';
import { EVENT_FIXTURES, PARTICIPANT_A, SESSION_ID } from './fixtures';

const TYPES = DOMAIN_EVENT_TYPES;

describe('the event type registry', () => {
  it('covers every declared payload schema, with no gaps or extras', () => {
    expect([...TYPES].sort()).toEqual(Object.keys(EVENT_PAYLOADS).sort());
    expect(Object.keys(EVENT_FIXTURES).sort()).toEqual(Object.keys(EVENT_PAYLOADS).sort());
  });

  it('recognises its own types and nothing else', () => {
    for (const type of TYPES) expect(isDomainEventType(type)).toBe(true);
    for (const type of ['', 'session', 'session.created ', 'Session.Created', '__proto__']) {
      expect(isDomainEventType(type)).toBe(false);
    }
  });

  it('names every event with a dotted lower-case scope', () => {
    for (const type of TYPES) expect(type).toMatch(/^[a-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/);
  });
});

describe.each(TYPES)('%s', (type) => {
  const payload = EVENT_FIXTURES[type];

  it('parses its fixture unchanged', () => {
    const event = parseDomainEvent(type, payload);
    expect(event.type).toBe(type);
    expect(event.payload).toEqual(payload);
  });

  it('round-trips through JSON without losing or inventing a field', () => {
    const wire = JSON.parse(JSON.stringify(payload)) as unknown;
    const event = parseDomainEvent(type, wire);
    expect(event.payload).toEqual(payload);
    // Byte-for-byte: parsing must not reorder, coerce or default anything.
    expect(JSON.stringify(event.payload)).toBe(JSON.stringify(payload));
  });

  it('rejects an unknown field rather than persisting it', () => {
    const result = safeParseDomainEvent(type, { ...payload, smuggled: 'value' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(EventPayloadError);
    expect(result.error.message).toContain('smuggled');
  });

  it('rejects a payload that is not an object', () => {
    for (const bad of [null, 'text', 42, [], true]) {
      expect(safeParseDomainEvent(type, bad).ok).toBe(false);
    }
  });

  it('exposes the same schema by lookup as by direct access', () => {
    expect(payloadSchemaFor(type)).toBe(EVENT_PAYLOADS[type]);
  });

  it('scopes itself to a session unless it is app lifecycle', () => {
    const event = parseDomainEvent(type, payload);
    const expected = type === 'app.started' ? null : SESSION_ID;
    expect(sessionIdOf(event)).toBe(expected);
    expect(isSessionScoped(type)).toBe(type !== 'app.started');
  });
});

describe('parsing failures', () => {
  it('reports an unknown type distinctly from a bad payload', () => {
    const unknown = safeParseDomainEvent('session.exploded', {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toBeInstanceOf(UnknownEventTypeError);
      expect(unknown.error.message).toContain('session.exploded');
    }

    const bad = safeParseDomainEvent('session.created', { sessionId: SESSION_ID });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBeInstanceOf(EventPayloadError);
  });

  it('throws from parseDomainEvent so a writer cannot ignore the failure', () => {
    expect(() => parseDomainEvent('nope', {})).toThrow(UnknownEventTypeError);
    expect(() => {
      parseDomainEvent('session.budget-set', { sessionId: SESSION_ID, capUsd: -1 });
    }).toThrow(EventPayloadError);
  });

  it('lists the offending path in the message', () => {
    const result = safeParseDomainEvent('session.created', {
      sessionId: 'not-a-uuid',
      title: 'x',
      question: 'y',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('sessionId');
  });

  it('refuses ids that are not uuids and timestamps in payloads', () => {
    expect(
      safeParseDomainEvent('phase.opened', {
        sessionId: SESSION_ID,
        phaseId: '1',
        kind: 'FRAMING',
        index: 0,
      }).ok,
    ).toBe(false);

    // Payloads carry no time of their own; the log's recordedAt is the time.
    expect(
      safeParseDomainEvent('session.created', {
        ...EVENT_FIXTURES['session.created'],
        createdAt: '2026-08-17T09:12:33.041Z',
      }).ok,
    ).toBe(false);
  });

  it('refuses out-of-range numbers', () => {
    const cases: [DomainEventType, unknown][] = [
      ['session.budget-set', { sessionId: SESSION_ID, capUsd: Number.POSITIVE_INFINITY }],
      ['session.spend-recorded', { sessionId: SESSION_ID, costUsd: -0.01 }],
      ['phase.opened', { ...EVENT_FIXTURES['phase.opened'], index: -1 }],
      ['phase.opened', { ...EVENT_FIXTURES['phase.opened'], index: 1.5 }],
      ['claim.recorded', { ...EVENT_FIXTURES['claim.recorded'], confidence: 1.01 }],
      ['roster.model-attached', { ...EVENT_FIXTURES['roster.model-attached'], weight: -1 }],
    ];
    for (const [type, payload] of cases) {
      expect(safeParseDomainEvent(type, payload).ok, `${type} should reject`).toBe(false);
    }
  });

  it('refuses an enum value outside the vocabulary', () => {
    expect(
      safeParseDomainEvent('phase.opened', { ...EVENT_FIXTURES['phase.opened'], kind: 'PUBLISH' })
        .ok,
    ).toBe(false);
    expect(
      safeParseDomainEvent('claim.recorded', {
        ...EVENT_FIXTURES['claim.recorded'],
        claimType: 'VIBES',
      }).ok,
    ).toBe(false);
  });

  it('requires at least one role assignment', () => {
    expect(
      safeParseDomainEvent('roster.roles-assigned', {
        ...EVENT_FIXTURES['roster.roles-assigned'],
        assignments: [],
      }).ok,
    ).toBe(false);
  });
});

describe('domainEvent()', () => {
  it('validates on the way in and returns the pair', () => {
    const event = domainEvent('session.created', EVENT_FIXTURES['session.created']);
    expect(event).toEqual({ type: 'session.created', payload: EVENT_FIXTURES['session.created'] });
  });

  it('throws before a malformed payload can reach the hash chain', () => {
    expect(() => {
      // A caller reaching for `any` still cannot get an invalid payload through.
      domainEvent('session.retitled', { sessionId: SESSION_ID, title: '' });
    }).toThrow(EventPayloadError);
  });
});

describe('message bodies', () => {
  it('accepts inline text or a content-addressed blob, and nothing in between', () => {
    const base = EVENT_FIXTURES['message.recorded'];

    expect(
      safeParseDomainEvent('message.recorded', {
        ...base,
        body: { kind: 'blob', hash: 'b'.repeat(64), bytes: 4_096, mediaType: 'text/markdown' },
      }).ok,
    ).toBe(true);

    for (const body of [
      { kind: 'blob', hash: 'not-a-hash', bytes: 1, mediaType: 'text/plain' },
      { kind: 'blob', hash: 'B'.repeat(64), bytes: 1, mediaType: 'text/plain' },
      { kind: 'blob', hash: 'b'.repeat(64), bytes: -1, mediaType: 'text/plain' },
      { kind: 'blob', hash: 'b'.repeat(64), bytes: 1 },
      { kind: 'text' },
      { kind: 'audio', text: 'x' },
    ]) {
      expect(safeParseDomainEvent('message.recorded', { ...base, body }).ok).toBe(false);
    }
  });

  it('allows a human or system author with no model attached', () => {
    const { role, ...base } = EVENT_FIXTURES['message.recorded'];
    expect(role).toBe('PROPOSER');

    for (const author of [{ kind: 'HUMAN' }, { kind: 'SYSTEM' }]) {
      expect(safeParseDomainEvent('message.recorded', { ...base, author }).ok).toBe(true);
    }

    // A model author must say which model, so provenance survives roster edits.
    expect(
      safeParseDomainEvent('message.recorded', {
        ...base,
        author: { kind: 'MODEL', participantId: PARTICIPANT_A },
      }).ok,
    ).toBe(false);
  });
});
