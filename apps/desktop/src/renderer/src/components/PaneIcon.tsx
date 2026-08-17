import type { ReactElement } from 'react';
import type { PaneId } from '@shared/panes';

/**
 * Inline stroke icons, one per pane.
 *
 * Drawn here rather than pulled from a font or an icon package: the renderer
 * runs under a content-security policy that permits no external resource, and a
 * dependency for seven small paths would not pay for itself.
 */
const PATHS: Record<PaneId, ReactElement> = {
  sessions: (
    <>
      <rect x="3" y="4" width="14" height="4" rx="1" />
      <rect x="3" y="12" width="14" height="4" rx="1" />
    </>
  ),
  conversation: (
    <>
      <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v6A1.5 1.5 0 0 1 15.5 13H8l-4 3v-3H4.5A1.5 1.5 0 0 1 3 11.5z" />
      <path d="M7 7.5h6M7 10h4" />
    </>
  ),
  ledger: (
    <>
      <circle cx="5" cy="5.5" r="2" />
      <circle cx="15" cy="5.5" r="2" />
      <circle cx="10" cy="14.5" r="2" />
      <path d="M6.6 7 8.9 12.7M13.4 7l-2.3 5.7M7 5.5h6" />
    </>
  ),
  lab: (
    <>
      <path d="M8 3h4v4.2l3.4 6.3A2 2 0 0 1 13.6 17H6.4a2 2 0 0 1-1.8-3.5L8 7.2z" />
      <path d="M6.2 12.5h7.6" />
    </>
  ),
  verification: (
    <>
      <path d="M10 2.8 16 5v5.2c0 3.1-2.4 5.6-6 7-3.6-1.4-6-3.9-6-7V5z" />
      <path d="m7.4 9.9 1.9 1.9 3.4-3.6" />
    </>
  ),
  artifacts: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="m3 12.5 3.8-3.2 3 2.5L13 8l4 3.8" />
      <circle cx="7.4" cy="7.4" r="1.1" />
    </>
  ),
  paper: (
    <>
      <path d="M5 2.8h6.5L15.5 7v10.2H5z" />
      <path d="M11.3 2.8V7h4.2M7.6 10.4h5.2M7.6 13.2h5.2" />
    </>
  ),
};

export function PaneIcon({ pane }: { pane: PaneId }): ReactElement {
  return (
    <svg
      className="icon"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[pane]}
    </svg>
  );
}
