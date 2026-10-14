/**
 * Files a person attaches to a chat message, read here before they are sent.
 *
 * An image is sent as it is. Anything else is sent as the text read out of it:
 * a PDF's text through pdf.js, any other file only if it is text already. The
 * main process checks all of it again; this is where a person is told early.
 */

export interface OutgoingAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly base64: string;
}

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** What the file picker offers. Anything else that is text is still accepted by drop or paste. */
export const ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.csv,.tsv,.json,.jsonl,.yaml,.yml,' +
  '.xml,.html,.tex,.bib,.py,.ipynb,.js,.ts,.tsx,.jsx,.java,.c,.h,.cpp,.hpp,.rs,.go,.rb,.r,.m,' +
  '.jl,.sql,.sh,.toml,.ini,.log';

const NUL = String.fromCharCode(0);

export function isImage(file: File): boolean {
  return IMAGE_TYPES.has(file.type);
}

export async function readAttachment(file: File): Promise<OutgoingAttachment> {
  if (isImage(file)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 8 MB`);
    return {
      name: file.name,
      mediaType: file.type,
      base64: toBase64(new Uint8Array(await file.arrayBuffer())),
    };
  }

  const text =
    file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      ? await pdfText(file)
      : decodeText(file.name, new Uint8Array(await file.arrayBuffer()));
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error(`${file.name} has more than 2 MB of text`);
  if (text.trim() === '') throw new Error(`${file.name} has no text in it to send`);
  return { name: file.name, mediaType: 'text/plain', base64: toBase64(bytes) };
}

function decodeText(name: string, bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not an image, a PDF or a text file`);
  }
  if (text.includes(NUL)) throw new Error(`${name} is not an image, a PDF or a text file`);
  return text;
}

/** A PDF's text, page by page. Scanned pages have none, and say so by being empty. */
async function pdfText(file: File): Promise<string> {
  const { getDocument } = await import('./pdf');
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const content = await (await document.getPage(number)).getTextContent();
      const words = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      pages.push(`[page ${String(number)}]\n${words.replace(/\s+/g, ' ').trim()}`);
    }
    return pages.join('\n\n');
  } finally {
    void task.destroy();
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In slices: spreading a whole file into one call overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
