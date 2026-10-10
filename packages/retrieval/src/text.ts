/**
 * Text from outside, reduced to text.
 *
 * A provider's response carries markup of its own — Atom entities from arXiv,
 * JATS tags from Crossref — and nothing downstream should have to know which.
 * What leaves here is plain characters on one line, cut to a stated length.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text from a field of a provider's response: tags dropped, entities
 * decoded, whitespace collapsed, and cut at `limit` with the cut marked.
 *
 * Tags are dropped before entities are decoded, so an escaped `&lt;script&gt;`
 * comes out as the characters it stands for and not as markup that was
 * stripped — and nothing here is ever rendered as markup anyway.
 */
export function plainText(raw: string, limit: number): string {
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()} […]`;
}
