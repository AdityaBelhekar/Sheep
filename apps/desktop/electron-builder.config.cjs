/**
 * Packaging.
 *
 *   npm run dist            the installer for this platform
 *   npm run dist -- --dir   the unpacked app only, which is what gets tested
 *
 * The app is not just its JavaScript. An install carries the pinned Python
 * runtime the sandbox executes in and the pinned rendering tools, copied from
 * where `npm run fetch-runtime` and `npm run fetch-tools` put them, with the
 * stamps that say which lock they were installed from. A packaged build refuses
 * a runtime whose stamp does not match the lock it was compiled with, exactly
 * as a checkout does.
 *
 * Signing happens when a certificate is supplied in the environment
 * (CSC_LINK / CSC_KEY_PASSWORD, as electron-builder reads them) and not
 * otherwise. Whether the build was signed is written into the packaged
 * package.json, and the app will only ever update itself if it was: an
 * unsigned build has no publisher to verify an update against.
 */
const signed = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.sheep.app',
  // The Electron this checkout has installed and tested against, not a range.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  electronVersion: require('electron/package.json').version,
  productName: 'Sheep',
  copyright: 'Copyright © 2026 Aditya Belhekar',
  directories: { output: 'dist', buildResources: 'build' },

  // The bundles electron-vite wrote. Workspace packages are compiled into them
  // and are not shipped a second time as source.
  files: ['out/**', 'package.json', '!node_modules/@sheep/**'],
  // Native modules are prebuilt against N-API and load in Electron as they are.
  npmRebuild: false,
  asarUnpack: ['**/*.node'],

  extraResources: [
    { from: 'resources', to: '.' },
    { from: '../../packages/sandbox/runtime', to: 'python' },
    {
      from: '../../packages/artifacts/tools',
      to: 'tools',
      filter: ['graphviz/**', 'tectonic/**', 'tex-cache/**', 'styles/**', 'sheep-tools.json'],
    },
  ],
  extraMetadata: { sheep: { signed } },

  fileAssociations: [
    {
      ext: 'sheep',
      name: 'Sheep Session',
      description: 'Sheep research session',
      role: 'Editor',
    },
  ],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
  },
  nsis: {
    // An installer that asks where, and installs for the person running it:
    // the TeX cache beside the app has to stay writable by them.
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'Sheep-Setup-${version}.${ext}',
    shortcutName: 'Sheep',
  },

  // Releases live on GitHub. Nothing is uploaded by a build: `--publish never`
  // is the script's default, and publishing is a person's decision.
  publish: [{ provider: 'github', owner: 'AdityaBelhekar', repo: 'Sheep' }],
};
