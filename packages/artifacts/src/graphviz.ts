import { RenderError, runTool, toolEnv, type RenderTools } from './tools';

/** One file a renderer produced. */
export interface RenderedFile {
  readonly path: string;
  readonly data: Uint8Array;
}

/** Everything one source rendered to, and what rendered it. */
export interface Rendering {
  readonly outputs: readonly RenderedFile[];
  /** With versions, as recorded on the artifact. */
  readonly toolchain: string;
}

/**
 * Long enough for the first PDF on a machine, when fontconfig indexes every
 * installed font before cairo can draw one glyph. Every later run is instant.
 */
const DOT_TIMEOUT_MS = 300_000;

/**
 * Renders a DOT graph with the bundled `dot`: SVG for the screen, PDF for the
 * paper.
 *
 * Both are a function of the source alone. `dot` lays out deterministically,
 * its SVG carries no timestamp, and cairo stamps the PDF with the fixed
 * `SOURCE_DATE_EPOCH` the tool environment sets rather than with the clock.
 */
export async function renderGraphviz(
  tools: RenderTools,
  source: string,
  signal?: AbortSignal,
): Promise<Rendering> {
  const render = async (format: 'svg' | 'pdf'): Promise<RenderedFile> => {
    try {
      const data = await runTool(tools.dot, {
        args: [`-T${format}`],
        input: source,
        // fontconfig keeps its index of the machine's fonts here; without the
        // real location it would be rebuilt, slowly, on every run.
        env: toolEnv({ LOCALAPPDATA: process.env['LOCALAPPDATA'] ?? '' }),
        timeoutMs: DOT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      return { path: `diagram.${format}`, data };
    } catch (error) {
      // dot names its input "<stdin>"; say what it actually was.
      if (error instanceof RenderError) {
        throw new RenderError(error.message.replaceAll('<stdin>', 'the graph'));
      }
      throw error;
    }
  };

  // One after the other: the first failure is the source's, and says so once.
  const svg = await render('svg');
  const pdf = await render('pdf');
  return { outputs: [svg, pdf], toolchain: `graphviz ${tools.versions.graphviz}` };
}
