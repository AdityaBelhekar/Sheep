import type { Message } from '@sheep/core';

/**
 * What of a chat a model is shown, decided apart from Electron so it can be
 * tested: the latest summary and the turns after it, where to cut when that
 * grows too long, and what the summarizer reads.
 *
 * A summary stands in for everything up to one message (`summaryThrough`).
 * Each view of the chat — the room, or one model's private thread — has its
 * own, so a private summary may cover the room as well as the private turns,
 * and a room summary never covers a private one.
 */

/** Characters a model reads for one image, as the gateway's own estimate counts it. */
const IMAGE_CHARACTERS = 1_000;

/** How much of an attached text file is put in front of a model. */
const FILE_CHARACTERS = 100_000;

export const isSummary = (message: Message): boolean =>
  message.author.kind === 'SYSTEM' && message.summaryThrough !== null;

/** A turn's size in estimated tokens: four characters to a token, as everywhere here. */
export function messageTokens(message: Message): number {
  const text = message.body.kind === 'text' ? message.body.text.length : 0;
  const files = message.attachments.reduce(
    (sum, file) =>
      sum +
      (file.mediaType.startsWith('image/')
        ? IMAGE_CHARACTERS
        : Math.min(file.bytes, FILE_CHARACTERS)),
    0,
  );
  return Math.ceil((text + files) / 4);
}

/**
 * The chat as one view sees it now: its latest summary, and every turn that
 * summary does not already stand in for, oldest first.
 *
 * `window` is the latest stretch of the thread. When the message a summary
 * covers through is older than the window, everything in the window came
 * after it.
 */
export function sinceSummary(
  window: readonly Message[],
  view: string | null,
): { summary: Message | null; turns: Message[] } {
  let at = -1;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const message = window[index];
    if (message && isSummary(message) && message.privateTo === view) {
      at = index;
      break;
    }
  }
  const summary = at === -1 ? null : (window[at] ?? null);
  const covered =
    summary === null
      ? -1
      : window.findIndex((message) => message.messageId === summary.summaryThrough);
  return {
    summary,
    turns: window.filter((message, index) => index > covered && !isSummary(message)),
  };
}

/**
 * Where to cut a thread that has grown too long: the older turns to fold into
 * a summary, and the newest that stay whole — about `keep` tokens of them, and
 * never fewer than the last one, however long it is.
 */
export function splitForSummary(
  turns: readonly Message[],
  keep: number,
): { older: Message[]; recent: Message[] } {
  let cut = turns.length;
  let size = 0;
  while (cut > 0) {
    const turn = turns[cut - 1];
    if (!turn) break;
    const next = size + messageTokens(turn);
    if (next > keep && cut < turns.length) break;
    size = next;
    cut -= 1;
  }
  return { older: turns.slice(0, cut), recent: turns.slice(cut) };
}

/**
 * What a summarizer reads: the summary so far, then each turn it is to fold
 * in, under the name of whoever said it. Files are named, not reproduced; a
 * summary that needs one quotes what was said about it.
 *
 * Past `limit` characters the oldest part is dropped: what the summary so far
 * already says is what that part said.
 */
export function transcriptFor(
  summary: string | null,
  turns: readonly Message[],
  limit = 120_000,
): string {
  const lines = turns.flatMap((message) => {
    if (message.author.kind === 'SYSTEM' || message.body.kind !== 'text') return [];
    const text = message.body.text.trim();
    const files = message.attachments.map((file) => file.name);
    if (text === '' && files.length === 0) return [];
    const who =
      message.author.kind === 'MODEL'
        ? message.author.model.modelId
        : message.privateTo === null
          ? 'User'
          : 'User (privately)';
    const attached = files.length === 0 ? '' : ` (attached: ${files.join(', ')})`;
    return [`${who}: ${text}${attached}`];
  });
  const body = [summary === null ? null : `Summary so far:\n${summary}`, ...lines]
    .filter((part): part is string => part !== null)
    .join('\n\n');
  return body.length > limit ? body.slice(-limit) : body;
}
