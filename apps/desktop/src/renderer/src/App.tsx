import type { ReactElement } from 'react';
import logoUrl from '@resources/sheep.png';
import { APP_NAME, APP_TAGLINE } from '@shared/product';

export function App(): ReactElement {
  const versions = window.sheep?.versions;

  return (
    <main className="shell" data-sheep-ready="true">
      <img
        className="shell__logo"
        src={logoUrl}
        alt={`${APP_NAME} logo`}
        width={160}
        height={160}
      />
      <h1 className="shell__title">{APP_NAME}</h1>
      <p className="shell__tagline">{APP_TAGLINE}</p>
      <footer className="shell__footer">
        {versions
          ? `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
          : 'preload bridge unavailable'}
      </footer>
    </main>
  );
}
