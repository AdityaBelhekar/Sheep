/**
 * @sheep/artifacts — Formulas, diagrams and figures, rendered deterministically
 * from their source.
 */
export const PACKAGE_NAME = '@sheep/artifacts';

export { renderGraphviz, type RenderedFile, type Rendering } from './graphviz';
export {
  compileLatex,
  renderFormula,
  renderTikz,
  tikzDocument,
  typeset,
  type TexFile,
} from './latex';
export { matplotlibScript } from './matplotlib';
export {
  devToolsDir,
  expectedToolsHash,
  locateTools,
  RenderError,
  runTool,
  toolEnv,
  ToolsUnavailableError,
  type RenderTools,
  type ToolRun,
} from './tools';
export {
  formulaDocument,
  formulaHtml,
  formulaProblem,
  KATEX_OPTIONS,
  MAX_FORMULA_LENGTH,
} from './formula';
