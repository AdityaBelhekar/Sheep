/** What the diagram page answers main with. */
export type MermaidPageReply =
  | { readonly ok: true; readonly svg: string; readonly version: string }
  | { readonly ok: false; readonly error: string };
