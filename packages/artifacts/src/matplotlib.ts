/**
 * Figures drawn by Python in the sandbox.
 *
 * Nothing is rendered here: the sandbox runs the script, and its determinism
 * (a fixed seed, the Agg backend, a pinned build date) is what makes a figure
 * reproducible. This only decides what the script is.
 */

/** Saves every figure still open when the script ends, as `figure-N`, for screen and print. */
const KEEP_FIGURES = `

# --- added by Sheep: keep every figure the script left open ---
import matplotlib.pyplot as _sheep_plt
for _sheep_index, _sheep_number in enumerate(_sheep_plt.get_fignums(), start=1):
    for _sheep_format in ("svg", "pdf"):
        _sheep_plt.figure(_sheep_number).savefig(f"figure-{_sheep_index}.{_sheep_format}")
`;

/**
 * A plotting script, made to keep what it drew.
 *
 * Someone writing a figure writes the plot and stops; nobody should have to
 * remember `savefig`, twice, in the right formats. What is returned is the
 * whole script that runs, and that is what is recorded as the figure's source
 * — so regenerating the figure means running exactly this again, with nothing
 * to re-apply.
 */
export function matplotlibScript(source: string): string {
  return source.trimEnd() + KEEP_FIGURES;
}
