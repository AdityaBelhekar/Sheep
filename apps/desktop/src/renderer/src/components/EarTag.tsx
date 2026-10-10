import type { ReactElement } from 'react';
import type { ModelRef, RosterEntry } from '@sheep/core';

/** How many tag colours the stylesheet declares (`--tag-0` … `--tag-5`). */
const TAG_COUNT = 6;

/**
 * Which tag a participant wears.
 *
 * Its position in the roster, detached entries included, so a tag is stable for
 * the life of the session: detaching one model does not recolour the others.
 * A participant the roster does not know falls back to a hash of its id.
 */
// ponytail: six colours, so a seventh model shares one; the letter still differs. Add tokens if rosters grow.
export function tagIndex(roster: readonly RosterEntry[], participantId: string): number {
  const position = roster.findIndex((entry) => entry.participantId === participantId);
  if (position >= 0) return position % TAG_COUNT;
  let hash = 0;
  for (const char of participantId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % TAG_COUNT;
}

/** `org/model-name:tag` → `model-name:tag`; the vendor is said elsewhere. */
function shortName(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf('/') + 1);
}

/**
 * A model's ear tag: one colour and one letter, the same wherever it appears.
 *
 * The letter is there so the tag never depends on colour alone.
 */
export function EarTag({
  model,
  index,
  bare = false,
}: {
  model: ModelRef;
  index: number;
  /** Letter only, where there is no room for the name. */
  bare?: boolean;
}): ReactElement {
  const name = shortName(model.modelId);
  const letter = (/[a-z0-9]/i.exec(name)?.[0] ?? '?').toUpperCase();

  return (
    <span
      className={bare ? 'tag tag--bare' : 'tag'}
      data-tag={index}
      title={`${model.vendorId} · ${model.modelId}`}
    >
      <span className="tag__letter">{letter}</span>
      {!bare && <span className="tag__name">{name}</span>}
    </span>
  );
}
