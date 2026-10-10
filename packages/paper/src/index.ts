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
