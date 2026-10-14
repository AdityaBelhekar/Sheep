import type { Message } from '@sheep/core';
import { describe, expect, it } from 'vitest';
import { messageTokens, sinceSummary, splitForSummary, transcriptFor } from './chat-context';

const ROOM = null;
const PRIVATE = '77777777-7777-4777-8777-777777777777';
const MODEL = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  vendorId: 'openai',
  modelId: 'gpt-oss:120b',
};

let counter = 0;
function turn(text: string, overrides: Partial<Message> = {}): Message {
  counter += 1;
  return {
    messageId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    sessionId: '22222222-2222-4222-8222-222222222222',
    phaseId: null,
    roundId: null,
    author: { kind: 'HUMAN' },
    role: null,
    body: { kind: 'text', text },
    reasoning: null,
    attachments: [],
    summaryThrough: null,
    usage: null,
    finish: null,
    params: null,
    promptHash: null,
    privateTo: null,
    recordedAt: '2026-10-14T09:00:00.000Z',
    ...overrides,
  };
}

const summaryOf = (through: Message, privateTo: string | null = ROOM): Message =>
  turn('what was said', {
    author: { kind: 'SYSTEM' },
    summaryThrough: through.messageId,
    privateTo,
  });

describe('sinceSummary', () => {
  it('is the whole thread before anything has been summarized', () => {
    const thread = [turn('a'), turn('b')];
    expect(sinceSummary(thread, ROOM)).toEqual({ summary: null, turns: thread });
  });

  it('keeps the turns the summary does not cover, including ones said while it was written', () => {
    const [a, b, c] = [turn('a'), turn('b'), turn('c')];
    // The summary covers a and b, but was recorded after c had been said.
    const summary = summaryOf(b);
    const d = turn('d');
    const view = sinceSummary([a, b, c, summary, d], ROOM);
    expect(view.summary).toBe(summary);
    expect(view.turns).toEqual([c, d]);
  });

  it('reads only its own view’s summary', () => {
    const [a, b] = [turn('a'), turn('b')];
    const room = summaryOf(a, ROOM);
    const mine = summaryOf(b, PRIVATE);
    const c = turn('c');
    expect(sinceSummary([a, b, room, mine, c], PRIVATE).turns).toEqual([c]);
    expect(sinceSummary([a, b, room, mine, c], ROOM).turns).toEqual([b, c]);
  });

  it('keeps everything in view when the summary covers past the start of the window', () => {
    const outside = turn('long gone');
    const [x, y] = [turn('x'), turn('y')];
    expect(sinceSummary([x, summaryOf(outside), y], ROOM).turns).toEqual([x, y]);
  });
});

describe('splitForSummary', () => {
  it('keeps the newest turns up to the budget and folds the rest', () => {
    const turns = [turn('a'.repeat(400)), turn('b'.repeat(400)), turn('c'.repeat(400))];
    // 100 tokens each: two fit in 250.
    const { older, recent } = splitForSummary(turns, 250);
    expect(older).toEqual(turns.slice(0, 1));
    expect(recent).toEqual(turns.slice(1));
  });

  it('never folds the latest turn, however long', () => {
    const turns = [turn('a'), turn('z'.repeat(10_000))];
    const { older, recent } = splitForSummary(turns, 10);
    expect(recent).toEqual(turns.slice(1));
    expect(older).toEqual(turns.slice(0, 1));
  });

  it('counts an image as the flat allowance and a file by its size', () => {
    const withFiles = turn('', {
      attachments: [
        { name: 'a.png', mediaType: 'image/png', hash: 'a'.repeat(64), bytes: 5_000_000 },
        { name: 'b.txt', mediaType: 'text/plain', hash: 'b'.repeat(64), bytes: 400 },
      ],
    });
    expect(messageTokens(withFiles)).toBe(350);
  });
});

describe('transcriptFor', () => {
  it('names each speaker, folds in the summary so far, and names files', () => {
    const transcript = transcriptFor('earlier', [
      turn('first', {
        attachments: [
          { name: 'data.csv', mediaType: 'text/plain', hash: 'c'.repeat(64), bytes: 9 },
        ],
      }),
      turn('a reply', { author: { kind: 'MODEL', participantId: PRIVATE, model: MODEL } }),
      turn('aside', { privateTo: PRIVATE }),
    ]);
    expect(transcript).toBe(
      'Summary so far:\nearlier\n\nUser: first (attached: data.csv)\n\ngpt-oss:120b: a reply\n\nUser (privately): aside',
    );
  });

  it('drops the oldest part past the limit', () => {
    expect(transcriptFor(null, [turn('old'), turn('new')], 9)).toBe('User: new');
  });
});
