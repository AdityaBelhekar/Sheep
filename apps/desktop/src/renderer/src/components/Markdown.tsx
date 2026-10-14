import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Formula } from './Formula';

/**
 * The Markdown models write, drawn as elements: paragraphs, headings, lists,
 * quotes, fenced code, and bold, italic, inline code and `$math$` inside them.
 *
 * Built from React elements, never from HTML, so nothing a model writes can
 * become markup. Links are left as their text: a model's link is not something
 * to make clickable.
 *
 * ponytail: the common cases, not CommonMark. Tables and nested lists read as
 * plain lines; swap in a real parser if they start to matter.
 */
export function Markdown({ text }: { text: string }): ReactElement {
  return <div className="md">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const key = out.length;

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(fence[1] ?? '```')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      out.push(
        <pre key={key} className="md__code">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(4, (heading[1] ?? '#').length + 1);
      const Tag = `h${String(level)}` as 'h2' | 'h3' | 'h4';
      out.push(
        <Tag key={key} className="md__heading">
          {inline(heading[2] ?? '')}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key} className="md__rule" />);
      index += 1;
      continue;
    }

    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1] ?? '');
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? '');
        if (item) items.push(item[2] ?? '');
        else if (/^\s{2,}\S/.test(lines[index] ?? '') && items.length > 0) {
          items[items.length - 1] += ` ${(lines[index] ?? '').trim()}`;
        } else break;
        index += 1;
      }
      const children = items.map((item, at) => <li key={at}>{inline(item)}</li>);
      out.push(
        ordered ? (
          <ol key={key} className="md__list">
            {children}
          </ol>
        ) : (
          <ul key={key} className="md__list">
            {children}
          </ul>
        ),
      );
      continue;
    }

    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      out.push(
        <blockquote key={key} className="md__quote">
          {blocks(quoted.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !/^(\s*(```|~~~)|#{1,6}\s|\s*([-*+]|\d+[.)])\s+|>)/.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    out.push(
      <p key={key} className="md__p">
        {paragraph.map((part, at) => (
          <Fragment key={at}>
            {at > 0 && <br />}
            {inline(part)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

/**
 * `code`, $math$, **bold** and *italic*, in that order of precedence.
 *
 * Math is typeset by KaTeX, run untrusted. A `$` only opens math when text
 * follows it at once and only closes it when text comes just before, so
 * "$5 and $10" stays a sentence about money.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\$\$[^$]+\$\$|\$(?=\S)[^$\n]*?\S\$(?!\d))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    const [token] = match;
    if (match[1])
      out.push(
        <code key={at} className="md__inline">
          {token.slice(1, -1)}
        </code>,
      );
    else if (match[2]) {
      const latex = token.startsWith('$$') ? token.slice(2, -2) : token.slice(1, -1);
      out.push(<Formula key={at} latex={latex} source={token} showLatex={false} />);
    } else if (match[3]) out.push(<strong key={at}>{inline(token.slice(2, -2))}</strong>);
    else out.push(<em key={at}>{inline(token.slice(1, -1))}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
