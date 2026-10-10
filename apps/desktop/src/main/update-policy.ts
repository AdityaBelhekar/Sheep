/**
 * Whether this copy of Sheep may update itself. A decision, kept apart from
 * the machinery so that it can be tested without an installer.
 *
 * Two things have to be true. The app has to be an installed copy, because an
 * update replaces an installation and a checkout has none. And the build has
 * to be signed, because an update is trusted only for carrying the same
 * publisher's signature as the copy that fetched it; an unsigned build has no
 * publisher, so there is nothing an update could be verified against, and an
 * update that cannot be verified is a download-and-run.
 *
 * Nothing here contacts anything. Sheep makes no network call a person did
 * not ask for (P7), so there is no check on launch and no timer: an update is
 * looked for when someone presses the button, and installed when they press
 * the next one.
 */
export interface UpdateEnvironment {
  /** True for an installed copy; false for a checkout or an unpacked build. */
  readonly packaged: boolean;
  /** True when the build was signed with a publisher's certificate. */
  readonly signed: boolean;
}

export type UpdatePolicy =
  { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

export const RELEASES_URL = 'https://github.com/AdityaBelhekar/Sheep/releases';

export function updatePolicy(environment: UpdateEnvironment): UpdatePolicy {
  if (!environment.packaged) {
    return {
      enabled: false,
      reason: 'Updates apply to an installed copy of Sheep. This one is running from source.',
    };
  }
  if (!environment.signed) {
    return {
      enabled: false,
      reason: `This build is not signed, so there is no publisher to verify an update against. New versions are at ${RELEASES_URL}.`,
    };
  }
  return { enabled: true };
}

/**
 * Whether one version is newer than another, by its three numbers.
 *
 * A release that is not plainly newer is never offered: not the same version
 * again, not an older one, and not anything whose version cannot be read.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const [a, b] = [parts(candidate), parts(current)];
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}
