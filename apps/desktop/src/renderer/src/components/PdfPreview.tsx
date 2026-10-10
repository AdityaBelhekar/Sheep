import { useEffect, useRef, useState, type ReactElement } from 'react';

/** Drawn at twice its size and shown at one, so a small figure is not a blurred one. */
const SCALE = 2;

/**
 * The first page of a PDF, drawn on a canvas.
 *
 * A figure typeset by TeX exists only as a PDF, and this is how it is seen
 * without leaving the app. pdf.js draws it; the embedded viewer would need
 * plugins and frames the content-security policy is right to refuse.
 */
export function PdfPreview({ data, label }: { data: Uint8Array; label: string }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const signal = { cancelled: false };
    setProblem(null);
    void (async () => {
      try {
        const { getDocument } = await import('./pdf');
        // A copy: pdf.js hands the buffer it is given to its worker.
        const document = await getDocument({ data: data.slice() }).promise;
        const page = await document.getPage(1);
        const viewport = page.getViewport({ scale: SCALE });
        const target = canvas.current;
        if (signal.cancelled || !target) return;

        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        target.style.width = `${String(Math.ceil(viewport.width / SCALE))}px`;
        await page.render({ canvas: target, viewport }).promise;
        if (!signal.cancelled) target.dataset['sheepPdf'] = 'drawn';
      } catch (error) {
        if (!signal.cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [data]);

  if (problem !== null) {
    return <p className="notice notice--error">This PDF could not be drawn: {problem}</p>;
  }
  return <canvas ref={canvas} className="lab__plot" role="img" aria-label={label} />;
}
