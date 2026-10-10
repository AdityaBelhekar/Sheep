import type { Block, PaperDocument, Section, Sentence } from './ir';
import { STATUS_WORDS } from './ir';

/**
 * The document as LaTeX.
 *
 * Everything in a paper that is not Sheep's own wording was written by a
 * model, so nothing reaches the engine unescaped: text is escaped character by
 * character, and the only LaTeX in the output is what this file puts there. A
 * model cannot typeset its way out of a quotation.
 *
 * The body is the same for every template. A template decides the class, the
 * title block and the page; it does not get to decide what the paper says.
 */

const SPECIAL: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  _: '\\_',
  '%': '\\%',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  // Characters the text fonts do not carry, set in math where they exist.
  // ponytail: a short list of what models actually write; a symbol not on it
  // prints as a missing glyph. Load a Unicode math font if that ever matters.
  '→': '$\\rightarrow$',
  '←': '$\\leftarrow$',
  '↔': '$\\leftrightarrow$',
  '⇒': '$\\Rightarrow$',
  '≥': '$\\geq$',
  '≤': '$\\leq$',
  '≠': '$\\neq$',
  '≈': '$\\approx$',
  '×': '$\\times$',
  '±': '$\\pm$',
  '∞': '$\\infty$',
  '∈': '$\\in$',
  '√': '$\\surd$',
  '∑': '$\\sum$',
  α: '$\\alpha$',
  β: '$\\beta$',
  γ: '$\\gamma$',
  δ: '$\\delta$',
  ε: '$\\epsilon$',
  θ: '$\\theta$',
  λ: '$\\lambda$',
  μ: '$\\mu$',
  π: '$\\pi$',
  σ: '$\\sigma$',
  φ: '$\\phi$',
  ω: '$\\omega$',
  Δ: '$\\Delta$',
  Σ: '$\\Sigma$',
  Ω: '$\\Omega$',
};

const SPECIAL_PATTERN = new RegExp(
  `[${Object.keys(SPECIAL)
    .map((char) => (/[\\^\]-]/.test(char) ? `\\${char}` : char))
    .join('')}]`,
  'g',
);

/** One line of text, safe to typeset. Control characters are dropped; they are never content. */
export function escapeLatex(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(SPECIAL_PATTERN, (char) => SPECIAL[char] ?? char)
  );
}

/** Text of several lines and paragraphs, keeping both. */
export function prose(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => escapeLatex(line.trim()))
        .filter((line) => line !== '')
        .join('\\newline\n'),
    )
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

/** An id or a hash, set fixed-width and allowed to break, so 64 characters fit a column. */
export function mono(value: string): string {
  const pieces = value.match(/[^-]{1,8}|-/g) ?? [value];
  return `\\texttt{${pieces.map(escapeLatex).join('\\allowbreak{}')}}`;
}

/**
 * What every template shares: the packages the body uses and the few macros it
 * is written in. Loaded after the class, so a class that already loads one of
 * these keeps its own options. Deliberately few: every class here brings its
 * own mathematics fonts, and a second set (amssymb beside acmart's newtxmath)
 * is an error rather than a redundancy.
 */
export const BODY_PREAMBLE = String.raw`\usepackage{graphicx}
\usepackage{xcolor}
\usepackage{listings}
\usepackage{hyperref}
\lstset{basicstyle=\ttfamily\footnotesize,breaklines=true,columns=fullflexible,keepspaces=true,frame=single,framesep=3pt,xleftmargin=4pt,xrightmargin=4pt}
% A sentence the paper asserts, and the ledger claim(s) it rests on: label, then id.
\newcommand{\sheepclaim}[2]{\textsuperscript{\,[#1]}}
% A figure at its own size, or the width of the column if it is wider.
\newsavebox{\sheepbox}
\newcommand{\sheepfigure}[1]{\sbox{\sheepbox}{\includegraphics{#1}}\ifdim\wd\sheepbox>\linewidth\includegraphics[width=\linewidth]{#1}\else\usebox{\sheepbox}\fi}
% The record, quoted, and who wrote it.
\newcommand{\sheepquote}[2]{\begin{quote}\small #1\par\nopagebreak\raggedleft--- #2\end{quote}}
\setlength{\emergencystretch}{3em}`;

function sentence(value: Sentence, labelOf: ReadonlyMap<string, string>): string {
  const text = escapeLatex(value.text);
  if (!value.asserts || value.claimIds.length === 0) return text;
  const labels = value.claimIds.map((claimId) => labelOf.get(claimId) ?? '?').join(', ');
  return `${text}\\sheepclaim{${escapeLatex(labels)}}{${value.claimIds.join(',')}}`;
}

function block(value: Block, labelOf: ReadonlyMap<string, string>): string {
  switch (value.kind) {
    case 'paragraph': {
      const lead = value.lead === undefined ? '' : `\\textbf{${escapeLatex(value.lead)}.} `;
      return lead + value.sentences.map((entry) => sentence(entry, labelOf)).join('\n');
    }
    case 'quote':
      return `\\sheepquote{${prose(value.text)}}{${escapeLatex(value.attribution)}}`;
    case 'finding':
      return [
        `% claim ${value.claimId}`,
        `\\paragraph{${escapeLatex(value.label)} \\textnormal{(${value.claimType.toLowerCase()}, ${escapeLatex(
          STATUS_WORDS[value.status],
        )})}}`,
        `${escapeLatex(value.statement)}\\sheepclaim{${escapeLatex(value.label)}}{${value.claimId}}`,
      ].join('\n');
    case 'figure': {
      const supports =
        value.labels.length === 0 ? '' : ` Supports ${escapeLatex(value.labels.join(', '))}.`;
      return [
        `% artifact ${value.artifactId} sha256 ${value.hash}`,
        '\\begin{figure}[htbp]',
        '\\centering',
        `\\sheepfigure{${value.file}}`,
        `\\caption{${escapeLatex(value.title)}.${supports} Artifact ${mono(value.artifactId.slice(0, 8))}, regenerable from its recorded source.}`,
        '\\end{figure}',
      ].join('\n');
    }
    case 'code':
      return [
        `\\noindent\\textit{${escapeLatex(value.caption)}}`,
        '\\begin{lstlisting}',
        // The one string that would end the listing early.
        value.text.replaceAll('\\end{lstlisting}', '\\end {lstlisting}').trimEnd(),
        '\\end{lstlisting}',
      ].join('\n');
    case 'facts':
      return [
        ...(value.title === undefined ? [] : [`\\noindent\\textbf{${escapeLatex(value.title)}}`]),
        '\\begin{description}',
        ...value.facts.map(
          (fact) =>
            `\\item[${escapeLatex(fact.term)}] ${fact.mono ? mono(fact.value) : escapeLatex(fact.value)}`,
        ),
        '\\end{description}',
      ].join('\n');
  }
}

function section(value: Section, labelOf: ReadonlyMap<string, string>): string {
  return [
    `\\section{${escapeLatex(value.title)}}`,
    ...value.blocks.map((entry) => block(entry, labelOf)),
  ].join('\n\n');
}

/** The abstract's text, for a template to put where its class wants it. */
export function abstractText(document: PaperDocument): string {
  const labelOf = new Map(document.labels.map((entry) => [entry.claimId, entry.label]));
  return document.abstract.map((entry) => sentence(entry, labelOf)).join('\n');
}

/** Everything between the title block and `\end{document}`. */
export function emitBody(document: PaperDocument): string {
  const labelOf = new Map(document.labels.map((entry) => [entry.claimId, entry.label]));
  const parts = document.sections.map((entry) => section(entry, labelOf));

  if (document.references.length > 0) {
    parts.push(
      // A plain numbered list, not `thebibliography`: the conference styles load
      // natbib in author-year mode, which refuses entries that have no year.
      [
        '\\section*{References}',
        '\\begin{description}',
        ...document.references.map(
          (reference, index) => `\\item[{[${String(index + 1)}]}] ${escapeLatex(reference)}`,
        ),
        '\\end{description}',
      ].join('\n'),
    );
  }
  if (document.appendix.length > 0) {
    parts.push('\\appendix', ...document.appendix.map((entry) => section(entry, labelOf)));
  }
  return parts.join('\n\n');
}
