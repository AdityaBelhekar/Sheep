import { useEffect, useRef, useState, type ReactElement } from 'react';

/** Drawn at twice its size and shown at one, so a small figure is not a blurred one. */
const SCALE = 2;

/**
 * A PDF, drawn on canvases: its first page, or every page.
 *
 * A figure typeset by TeX exists only as a PDF, and so does a paper; this is
 * how either is seen without leaving the app. pdf.js draws it; the embedded
 * viewer would need plugins and frames the content-security policy is right to
 * refuse.
 */
export function PdfPreview({
  data,
  label,
  allPages = false,
}: {
  data: Uint8Array;
  label: string;
  /** Every page, one under the other. A figure has one; a paper does not. */
  allPages?: boolean;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const signal = { cancelled: false };
    setProblem(null);
    void (async () => {
      try {
        const { getDocument } = await import('./pdf');
        // A copy: pdf.js hands the buffer it is given to its worker.
        const document = await getDocument({ data: data.slice() }).promise;
        const target = host.current;
        if (signal.cancelled || !target) return;
        target.replaceChildren();
        delete target.dataset['sheepPdf'];

        const pages = allPages ? document.numPages : 1;
        for (let number = 1; number <= pages; number += 1) {
          const page = await document.getPage(number);
          const viewport = page.getViewport({ scale: SCALE });
          const canvas = window.document.createElement('canvas');
          canvas.className = 'lab__plot';
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${String(Math.ceil(viewport.width / SCALE))}px`;
          await page.render({ canvas, viewport }).promise;
          if (signal.cancelled) return;
          target.append(canvas);
        }
        target.dataset['sheepPdf'] = String(pages);
      } catch (error) {
        if (!signal.cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [data, allPages]);

  if (problem !== null) {
    return <p className="notice notice--error">This PDF could not be drawn: {problem}</p>;
  }
  return <div ref={host} className="pdf" role="img" aria-label={label} />;
}
