import type { PaperDocument } from './ir';
import { abstractText, BODY_PREAMBLE, emitBody, escapeLatex, mono } from './latex';

/**
 * Templates: the same paper, on a different page.
 *
 * A template chooses the document class, the title block and where the
 * abstract goes. The body it wraps is identical for all of them, so a claim
 * cannot appear in the NeurIPS version and be missing from the arXiv one.
 *
 * The models are listed where a class expects authors, because that is where a
 * reader looks for who produced the work — as participants, by vendor and
 * model, with the version each reported.
 */

export const TEMPLATE_IDS = ['sheep'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface PaperTemplate {
  readonly id: TemplateId;
  readonly label: string;
  readonly description: string;
  /**
   * Style files this template needs beside the document, relative to the
   * bundled styles directory. Conference styles are in no TeX distribution.
   */
  readonly styleFiles: readonly string[];
  /** `\documentclass` and anything that must precede the shared preamble. */
  readonly head: string;
  /** Loaded after the shared preamble. */
  readonly preamble: string;
  /** Title, participants and abstract, in the order and the macros the class wants. */
  front(document: PaperDocument): string;
}

type Author = PaperDocument['authors'][number];

const title = (document: PaperDocument): string => escapeLatex(document.title);
const name = (author: Author): string => escapeLatex(author.name);
const detail = (author: Author): string => escapeLatex(author.detail);

const SHEEP: PaperTemplate = {
  id: 'sheep',
  label: 'Sheep Research Record',
  description: 'The native format: one column, the record first, provenance in full.',
  styleFiles: [],
  head: '\\documentclass[11pt,a4paper]{article}',
  preamble: String.raw`\usepackage[margin=2.6cm,headheight=14pt]{geometry}
\usepackage{fancyhdr}
\usepackage{titlesec}
\usepackage{parskip}
\usepackage{microtype}
\definecolor{sheepgreen}{HTML}{2F6F4F}
\titleformat{\section}{\Large\sffamily\bfseries\color{sheepgreen}}{\thesection}{0.6em}{}
\titleformat{\paragraph}[runin]{\sffamily\bfseries}{}{0pt}{}[\quad]
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0.4pt}
\fancyhead[L]{\small\sffamily Sheep Research Record}
\fancyfoot[C]{\small\thepage}`,
  front(document) {
    return [
      `\\fancyhead[R]{\\small session ${mono(document.sessionId.slice(0, 8))}}`,
      '\\thispagestyle{fancy}',
      '\\begin{flushleft}',
      '{\\small\\sffamily\\color{sheepgreen}SHEEP RESEARCH RECORD}\\\\[0.6em]',
      `{\\LARGE\\sffamily\\bfseries ${title(document)}}\\\\[0.8em]`,
      `{\\small Session ${mono(document.sessionId)}}\\\\[0.4em]`,
      `{\\small Participants: ${
        document.authors.map((author) => `${name(author)} (${detail(author)})`).join('; ') ||
        'none recorded'
      }}`,
      '\\end{flushleft}',
      '\\vspace{0.5em}\\hrule\\vspace{0.8em}',
      '\\noindent\\textbf{Abstract.}',
      abstractText(document),
      '\\vspace{0.8em}\\hrule',
    ].join('\n');
  },
};

export const TEMPLATES: readonly PaperTemplate[] = [SHEEP];

/** The template with this id. Takes any string: the id arrives from outside. */
export function templateById(id: string): PaperTemplate {
  const template = TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`unknown template: ${id}`);
  return template;
}

/** The whole document, as one LaTeX source. */
export function emitLatex(document: PaperDocument, template: PaperTemplate): string {
  return [
    `% ${template.label} — compiled by Sheep from session ${document.sessionId}` +
      // Read by the fetch script, which must warm the cache with the same files beside it.
      (template.styleFiles.length === 0 ? '' : `\n% styles: ${template.styleFiles.join(' ')}`),
    template.head,
    BODY_PREAMBLE,
    template.preamble,
    '\\begin{document}',
    template.front(document),
    emitBody(document),
    '\\end{document}',
    '',
  ].join('\n\n');
}
