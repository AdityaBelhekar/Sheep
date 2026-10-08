import { useEffect, useRef, type ReactElement } from 'react';

const MATHML = 'http://www.w3.org/1998/Math/MathML';

/** Presentation MathML the browser lays out. Anything else is dropped. */
const ELEMENTS = new Set([
  'mrow',
  'mi',
  'mn',
  'mo',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'munder',
  'mover',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'mstyle',
  'mfenced',
]);

const ATTRIBUTES = new Set(['mathvariant', 'stretchy', 'fence', 'separator', 'displaystyle']);

/**
 * Copies a MathML tree node by node, keeping only what is on the lists above.
 *
 * The markup comes from the checker, which builds it from a statement a model
 * wrote. It is never handed to the HTML parser: each element is created by
 * name in the MathML namespace, so nothing in it can be anything but math.
 */
function copy(source: Element): Element {
  // <mfenced> is not in MathML Core and browsers no longer draw its brackets,
  // but SymPy still emits it. Spell it out as a row with explicit fences.
  const fenced = source.localName === 'mfenced';
  const target = document.createElementNS(MATHML, fenced ? 'mrow' : source.localName);
  for (const attribute of source.attributes) {
    if (ATTRIBUTES.has(attribute.name)) target.setAttribute(attribute.name, attribute.value);
  }

  const operator = (text: string): Element => {
    const mo = document.createElementNS(MATHML, 'mo');
    mo.textContent = text;
    return mo;
  };
  if (fenced) target.append(operator(source.getAttribute('open') ?? '('));

  let children = 0;
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(child.textContent ?? ''));
    } else if (child instanceof Element && ELEMENTS.has(child.localName)) {
      if (fenced && children > 0) target.append(operator(','));
      target.append(copy(child));
      children += 1;
    }
  }

  if (fenced) target.append(operator(source.getAttribute('close') ?? ')'));
  return target;
}

function build(mathml: string): Element | null {
  // Parsed as HTML, into a document that is never displayed: SymPy writes
  // named entities such as &InvisibleTimes; that only the HTML parser knows.
  // Nothing from that document is used directly — it is only read, and copied.
  const parsed = new DOMParser().parseFromString(`<math>${mathml}</math>`, 'text/html');
  const root = parsed.querySelector('math');
  if (!root) return null;

  const math = document.createElementNS(MATHML, 'math');
  for (const child of root.children) {
    if (ELEMENTS.has(child.localName)) math.append(copy(child));
  }
  return math.childElementCount > 0 ? math : null;
}

/**
 * A statement, typeset.
 *
 * Rendered from the MathML the checker produced, with the LaTeX — the
 * canonical form — shown as source when asked for, and as the fallback when
 * there is nothing to typeset.
 */
export function Formula({
  mathml,
  latex,
  source,
  showLatex,
}: {
  mathml: string | null;
  latex: string | null;
  /** The statement as it was written, for when the checker could not read it. */
  source: string;
  showLatex: boolean;
}): ReactElement {
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const math = mathml === null ? null : build(mathml);
    host.current?.replaceChildren(math ?? document.createTextNode(source));
  }, [mathml, source]);

  return (
    <span className="formula">
      <span ref={host} className="formula__math" data-typeset={mathml === null ? 'no' : 'yes'} />
      {showLatex && latex !== null && <code className="formula__latex">{latex}</code>}
    </span>
  );
}
