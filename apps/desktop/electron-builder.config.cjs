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
/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const signed = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);

/**
 * The runtime and the tools are pinned for Windows x64 only. On a platform
 * that has neither, the app is packaged without them and says so itself: the
 * Lab, Verification and the renderers report that they are not installed.
 */
const runtime = join(__dirname, '../../packages/sandbox/runtime');
const tools = join(__dirname, '../../packages/artifacts/tools');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.sheep.app',
  // The Electron this checkout has installed and tested against, not a range.
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
    ...(existsSync(runtime) ? [{ from: runtime, to: 'python' }] : []),
    ...(existsSync(tools)
      ? [
          {
            from: tools,
            to: 'tools',
            filter: ['graphviz/**', 'tectonic/**', 'tex-cache/**', 'styles/**', 'sheep-tools.json'],
          },
        ]
      : []),
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

  // UNTESTED. These two targets have never been built or run: they are here so
  // that CI produces a package on each platform to start from. Neither carries
  // a sandbox, so neither can run code, check a derivation or draw a figure yet.
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.education',
    icon: 'build/icon.png',
  },
  linux: {
    target: ['AppImage'],
    category: 'Science',
    icon: 'build/icon.png',
  },

  // Releases live on GitHub. Nothing is uploaded by a build: `--publish never`
  // is the script's default, and publishing is a person's decision.
  publish: [{ provider: 'github', owner: 'AdityaBelhekar', repo: 'Sheep' }],
};
