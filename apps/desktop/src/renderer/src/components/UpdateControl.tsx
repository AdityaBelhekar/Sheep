import { useState, type ReactElement } from 'react';
import type { IpcClient, IpcResponse } from '@sheep/ipc';

type Check = IpcResponse<'sheep:update-check'>;

/**
 * Updates, in the status bar: looked for when pressed, and not before.
 *
 * Sheep never checks on its own. Pressing this is the only thing that
 * contacts the release feed, and what comes back is shown as it is — a newer
 * version with a button to install it, or the reason there is nothing to do.
 */
export function UpdateControl({ client }: { client: IpcClient | undefined }): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!client) return null;

  const look = (): void => {
    setBusy(true);
    setNote(null);
    client
      .invoke('sheep:update-check', {})
      .then(setCheck)
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const install = (): void => {
    setBusy(true);
    client
      .invoke('sheep:update-install', {})
      .then((reply) => {
        setNote(reply.detail);
      })
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <span className="statusbar__item" data-sheep-update={check?.status ?? 'unchecked'}>
      {check?.status === 'available' ? (
        <button type="button" className="statusbar__action" disabled={busy} onClick={install}>
          {busy ? 'Installing…' : `Install ${check.version ?? 'update'} and restart`}
        </button>
      ) : (
        <button type="button" className="statusbar__action" disabled={busy} onClick={look}>
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      )}
      {(note ?? check?.detail) !== undefined && <> · {note ?? check?.detail}</>}
    </span>
  );
}
