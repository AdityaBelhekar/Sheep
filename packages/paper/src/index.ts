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
export { bundleFiles, zip, type LoggedEvent } from './bundle';
export {
  buildPaper,
  paperFiles,
  typesetPaper,
  type BuiltPaper,
  type PaperOptions,
  type TypesetPaper,
} from './paper';
export {
  assertProvenanced,
  provenanceAppendix,
  ProvenanceError,
  unprovenanced,
  withoutUnprovenanced,
  type BuildFacts,
  type Unprovenanced,
} from './provenance';
export {
  emitLatex,
  templateById,
  TEMPLATE_IDS,
  TEMPLATES,
  type PaperTemplate,
  type TemplateId,
} from './templates';
