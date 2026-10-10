/**
 * @sheep/artifacts — Formulas, diagrams and figures, rendered deterministically
 * from their source.
 */
export const PACKAGE_NAME = '@sheep/artifacts';

export { renderGraphviz, type RenderedFile, type Rendering } from './graphviz';
export { compileLatex, renderFormula, renderTikz, tikzDocument } from './latex';
export { matplotlibScript } from './matplotlib';
export {
  devToolsDir,
  expectedToolsHash,
  locateTools,
  RenderError,
  ToolsUnavailableError,
  type RenderTools,
} from './tools';
export {
  formulaDocument,
  formulaHtml,
  formulaProblem,
  KATEX_OPTIONS,
  MAX_FORMULA_LENGTH,
} from './formula';
