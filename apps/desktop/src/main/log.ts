import { Redactor } from '@sheep/core';

/**
 * The main process's only way of writing anything down.
 *
 * Every line goes through one redactor, and every secret the process reads is
 * registered with it the moment it is read — not at the point something is
 * logged. That ordering is what makes accidental disclosure hard: a leak does
 * not have to be anticipated to be caught, because by the time any code could
 * log the value, the value is already being masked.
 *
 * There is no way to switch this off. A log that can be configured to include
 * secrets is a log that eventually will.
 */
export const redactor = new Redactor();

function write(stream: NodeJS.WriteStream, level: string, parts: unknown[]): void {
  const message = parts.map((part) => redactor.redactUnknown(part)).join(' ');
  stream.write(`sheep${level ? `:${level}` : ''}: ${message}\n`);
}

export function logInfo(...parts: unknown[]): void {
  write(process.stdout, '', parts);
}

export function logWarn(...parts: unknown[]): void {
  write(process.stderr, 'warn', parts);
}

export function logError(...parts: unknown[]): void {
  write(process.stderr, 'error', parts);
}

/** Redacts a string without writing it, for text bound elsewhere. */
export function redact(text: string): string {
  return redactor.redact(text);
}
