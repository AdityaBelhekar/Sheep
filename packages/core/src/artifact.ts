import { z } from 'zod';
import { executionArtifactSchema } from './execution';
import { idSchema, sha256Schema, timestampSchema, titleSchema } from './primitives';

/**
 * A figure, a diagram or a typeset formula — and what it was made from.
 *
 * An artifact is never just an image. It is a source, by content address, and
 * the files a named toolchain produced from that source. The source is the
 * artifact; the files are a rendering of it that can be thrown away and made
 * again, byte for byte (P5). A picture with no source could only be trusted,
 * and nothing in a research record should have to be.
 *
 * - `formula` — LaTeX mathematics, typeset by a real TeX engine.
 * - `mermaid` — a Mermaid diagram.
 * - `graphviz` — a graph in DOT.
 * - `tikz` — a TikZ picture, typeset by a real TeX engine.
 * - `matplotlib` — a figure a Python script drew in the sandbox. Its source is
 *   that script, and `executionId` names the run that drew it.
 */
export const ARTIFACT_KINDS = ['formula', 'mermaid', 'graphviz', 'tikz', 'matplotlib'] as const;
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** The most source one artifact may have. The same bound as a sandbox script. */
export const MAX_ARTIFACT_SOURCE_LENGTH = 200_000;
export const artifactSourceSchema = z.string().min(1).max(MAX_ARTIFACT_SOURCE_LENGTH);

/** What an artifact is and what was rendered. Shared by the event and the projected row. */
export const artifactFields = {
  artifactId: idSchema,
  kind: artifactKindSchema,
  title: titleSchema,
  /** The generating source: LaTeX, DOT, Mermaid or Python. */
  sourceHash: sha256Schema,
  /** Every rendering of it, named by file: `diagram.svg`, `diagram.pdf`. */
  outputs: z.array(executionArtifactSchema).min(1),
  /**
   * What rendered it, with versions: `graphviz 16.1.0`. The same source on the
   * same toolchain is the same bytes; on another, a difference is expected
   * and this is how it is told apart from a fault.
   */
  toolchain: z.string().min(1).max(200),
} as const;

export const artifactRecordSchema = z.strictObject({
  sessionId: idSchema,
  ...artifactFields,
  /** The sandbox run that drew a `matplotlib` figure; null for every other kind. */
  executionId: idSchema.nullable(),
  recordedAt: timestampSchema,
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
