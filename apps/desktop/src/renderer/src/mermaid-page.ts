import mermaid from 'mermaid';
import { version } from 'mermaid/package.json';
import type { MermaidPageReply } from '@shared/mermaid';

/**
 * The page main loads, unseen, to render one Mermaid diagram.
 *
 * Mermaid measures text to lay a diagram out, and only a browser can do that,
 * so the diagram is rendered here and handed back as a string. Everything
 * that could differ between two renders of the same source is pinned: element
 * ids are derived from a fixed seed rather than the clock, and labels are SVG
 * text rather than embedded HTML, so the result is one self-contained file
 * that draws the same wherever an SVG is drawn.
 *
 * The source is something a model wrote. `strict` has Mermaid escape it and
 * drop click handlers, and the result is only ever shown as an image.
 */
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  deterministicIds: true,
  deterministicIDSeed: 'sheep',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  theme: 'neutral',
  fontFamily: 'Arial, Helvetica, sans-serif',
});

declare global {
  interface Window {
    renderMermaid?: (source: string) => Promise<MermaidPageReply>;
  }
}

window.renderMermaid = async (source) => {
  try {
    const { svg } = await mermaid.render('sheep-diagram', source);
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

    // Mermaid sizes a diagram to its container. A file has no container, so
    // it is given the size its own viewBox states.
    const [, , width, height] = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    if (!width || !height) return { ok: false, error: 'the diagram has no size' };
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    root.setAttribute('style', 'background-color: white');

    // Left as the whole page, on a sheet exactly its size, for main to print.
    const sheet = document.createElement('style');
    sheet.textContent = `@page { size: ${String(width)}px ${String(height)}px; margin: 0 } html, body { margin: 0 } svg { display: block }`;
    document.head.append(sheet);
    document.body.replaceChildren(document.importNode(root, true));

    return { ok: true, svg: new XMLSerializer().serializeToString(root), version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
