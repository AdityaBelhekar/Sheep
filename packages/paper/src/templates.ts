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

export const TEMPLATE_IDS = ['sheep', 'neurips', 'icml', 'iclr', 'ieee', 'acm', 'arxiv'] as const;
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

const abstract = (document: PaperDocument): string =>
  `\\begin{abstract}\n${abstractText(document)}\n\\end{abstract}`;

/** `\title`, `\author` joined the way the class wants, `\maketitle`, then the abstract. */
const standardFront =
  (join: string, author: (value: Author) => string) =>
  (document: PaperDocument): string =>
    [
      `\\title{${title(document)}}`,
      `\\author{${document.authors.map(author).join(join) || 'No participants recorded'}}`,
      '\\maketitle',
      abstract(document),
    ].join('\n');

const stacked = (author: Author): string => `${name(author)} \\\\ ${detail(author)}`;

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

const NEURIPS: PaperTemplate = {
  id: 'neurips',
  label: 'NeurIPS',
  description: 'The official NeurIPS 2025 style, as a preprint.',
  styleFiles: ['neurips/neurips_2025.sty'],
  head: '\\documentclass{article}',
  preamble: '\\usepackage[preprint]{neurips_2025}',
  front: standardFront(' \\And ', stacked),
};

const ICML: PaperTemplate = {
  id: 'icml',
  label: 'ICML',
  description: 'The official ICML 2026 style, two columns.',
  styleFiles: ['icml/icml2026.sty', 'icml/algorithm.sty', 'icml/algorithmic.sty'],
  head: '\\documentclass{article}',
  preamble: '\\usepackage[accepted]{icml2026}',
  front(document) {
    return [
      `\\icmltitlerunning{${title(document)}}`,
      '\\twocolumn[',
      `\\icmltitle{${title(document)}}`,
      '\\begin{icmlauthorlist}',
      ...document.authors.map(
        (author, index) => `\\icmlauthor{${name(author)}}{m${String(index + 1)}}`,
      ),
      '\\end{icmlauthorlist}',
      ...document.authors.map(
        (author, index) => `\\icmlaffiliation{m${String(index + 1)}}{${detail(author)}}`,
      ),
      '\\icmlkeywords{Sheep Research Record}',
      '\\vskip 0.3in',
      ']',
      '\\printAffiliationsAndNotice{}',
      abstract(document),
    ].join('\n');
  },
};

const ICLR: PaperTemplate = {
  id: 'iclr',
  label: 'ICLR',
  description: 'The official ICLR 2026 conference style.',
  styleFiles: ['iclr/iclr2026_conference.sty'],
  head: '\\documentclass{article}',
  preamble: '\\usepackage{iclr2026_conference,times}\n\\iclrfinalcopy',
  front: standardFront(' \\And ', stacked),
};

const IEEE: PaperTemplate = {
  id: 'ieee',
  label: 'IEEE',
  description: 'IEEEtran, conference mode, two columns.',
  styleFiles: [],
  head: '\\documentclass[conference]{IEEEtran}',
  preamble: '',
  front: standardFront(
    ' \\and ',
    (author) => `\\IEEEauthorblockN{${name(author)}}\\\\\\IEEEauthorblockA{${detail(author)}}`,
  ),
};

const ACM: PaperTemplate = {
  id: 'acm',
  label: 'ACM',
  description: 'acmart, sigconf layout, without the ACM rights block.',
  styleFiles: [],
  // acmart loads hyperxmp, which writes the wall-clock time into the PDF's
  // metadata and so makes every compile a different file. Declaring the
  // package already loaded leaves the metadata out and the paper reproducible.
  head: String.raw`\expandafter\def\csname ver@hyperxmp.sty\endcsname{9999/01/01}
\documentclass[sigconf,nonacm]{acmart}`,
  preamble: '',
  front(document) {
    // acmart wants the abstract before \maketitle, and one \author per person.
    return [
      `\\title{${title(document)}}`,
      ...document.authors.map(
        (author) =>
          `\\author{${name(author)}}\n\\affiliation{\\institution{${detail(author)}}\\country{}}`,
      ),
      abstract(document),
      '\\maketitle',
    ].join('\n');
  },
};

const ARXIV: PaperTemplate = {
  id: 'arxiv',
  label: 'arXiv',
  description: 'A plain one-column preprint. arXiv has no style of its own; this is the usual one.',
  styleFiles: [],
  head: '\\documentclass[11pt,letterpaper]{article}',
  preamble: '\\usepackage[margin=1in]{geometry}\n\\usepackage{mathptmx}\n\\date{}',
  front: standardFront(' \\and ', stacked),
};

export const TEMPLATES: readonly PaperTemplate[] = [SHEEP, NEURIPS, ICML, ICLR, IEEE, ACM, ARXIV];

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
