import type { ReactElement } from 'react';
import { paneById, type PaneId } from '@shared/panes';

/**
 * A pane that has not been built yet, and says so.
 *
 * It states what will live there and which phase delivers it. An empty surface
 * that explains itself is navigable and honest; one that renders nothing is
 * indistinguishable from a bug.
 */
export function StubPane({ paneId }: { paneId: PaneId }): ReactElement {
  const pane = paneById(paneId);

  return (
    <section className="pane" data-pane={paneId}>
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      <div className="stub">
        <p className="stub__detail">{pane.detail}</p>
        <p className="stub__arriving">{pane.arriving}</p>
      </div>
    </section>
  );
}
