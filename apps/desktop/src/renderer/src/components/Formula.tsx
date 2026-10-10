import { useEffect, useRef, type ReactElement } from 'react';
import katex from 'katex';
import { KATEX_OPTIONS } from '@sheep/artifacts/formula';

/**
 * A statement, typeset.
 *
 * Drawn by KaTeX from the LaTeX — the canonical form, and the same text the
 * paper is typeset from — with that LaTeX shown as source when asked for.
 * When there is no LaTeX the statement is shown as it was written.
 *
 * The LaTeX comes from something a model wrote. KaTeX builds the nodes itself
 * rather than handing markup to the HTML parser, and is run untrusted, so
 * nothing in a formula can be anything but math.
 */
export function Formula({
  latex,
  source,
  showLatex,
}: {
  latex: string | null;
  /** The statement as it was written, for when the checker could not read it. */
  source: string;
  showLatex: boolean;
}): ReactElement {
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!host.current) return;
    if (latex === null) host.current.replaceChildren(document.createTextNode(source));
    else katex.render(latex, host.current, KATEX_OPTIONS);
  }, [latex, source]);

  return (
    <span className="formula">
      <span ref={host} className="formula__math" data-typeset={latex === null ? 'no' : 'yes'} />
      {showLatex && latex !== null && <code className="formula__latex">{latex}</code>}
    </span>
  );
}
