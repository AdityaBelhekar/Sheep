/**
 * @sheep/paper — Compiles a session's ledger into a typeset, provenanced
 * research record.
 */
export const PACKAGE_NAME = '@sheep/paper';

export {
  compileLatex,
  describeProblem,
  LatexError,
  parseProblems,
  type CompiledPaper,
  type LatexProblem,
  type PaperFile,
} from './compile';
export {
  buildDocument,
  figuresIn,
  labelsIn,
  sentencesOf,
  type Block,
  type Fact,
  type PaperDocument,
  type PaperSource,
  type Section,
  type Sentence,
} from './ir';
export { emitBody, escapeLatex } from './latex';
export { paperFiles, typesetPaper, type TypesetPaper } from './paper';
export {
  emitLatex,
  templateById,
  TEMPLATE_IDS,
  TEMPLATES,
  type PaperTemplate,
  type TemplateId,
} from './templates';
