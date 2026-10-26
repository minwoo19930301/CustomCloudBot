import { packager } from '@electron/packager';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('This first release packages macOS arm64 or x64.');
if (process.platform !== 'darwin') throw new Error('Build this Mac application on macOS.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'customcloudbot-desktop-package-'));
const staging = path.join(temporary, 'source');
const destination = path.join(source, 'dist');
try {
  await fs.mkdir(staging);
  // Explicit inclusion keeps developer files, private config and workspace dependencies out of the application.
  for (const item of ['main.mjs', 'preload.cjs', 'cloud-preload.cjs', 'security.mjs', 'secure-store.mjs', 'executor.mjs', 'ui']) {
    await fs.cp(path.join(source, item), path.join(staging, item), { recursive: true });
  }
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, productName: 'CustomCloudBot Desktop', type: 'module', main: 'main.mjs', license: metadata.license }));
  const iconset = path.join(temporary, 'app.iconset');
  await fs.mkdir(iconset);
  const logo = path.resolve(source, '../community/public/icons/app-logo-v3-512.png');
  for (const size of [16, 32, 128, 256, 512]) {
    await run('/usr/bin/sips', ['-z', String(size), String(size), logo, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
    if (size < 512) await run('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), logo, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  const icon = path.join(temporary, 'app.icns');
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
  const identity = process.env.CCB_MAC_SIGN_IDENTITY;
  const bundles = await packager({
    dir: staging, out: destination, name: 'CustomCloudBot Desktop', executableName: 'CustomCloudBot Desktop',
    appBundleId: 'org.customcloudbot.desktop', appVersion: metadata.version, buildVersion: metadata.version,
    appCategoryType: 'public.app-category.productivity', platform, arch, icon,
    electronVersion: metadata.devDependencies.electron, asar: true, prune: false, overwrite: true,
    osxSign: { identity: identity || '-', identityValidation: Boolean(identity), type: 'development',
      preEmbedProvisioningProfile: false, optionsForFile: () => ({ hardenedRuntime: Boolean(identity) }) },
    extendInfo: { NSHumanReadableCopyright: 'CustomCloudBot contributors',
      NSDocumentsFolderUsageDescription: 'Read and write files in folders you choose for your bot.',
      NSDownloadsFolderUsageDescription: 'Read and write files in folders you choose for your bot.',
      NSDesktopFolderUsageDescription: 'Read and write files in folders you choose for your bot.' }
  });
  for (const directory of bundles) {
    const bundle = path.join(directory, 'CustomCloudBot Desktop.app');
    const zip = path.join(destination, `CustomCloudBot-Desktop-${metadata.version}-mac-${arch}.zip`);
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
    console.log(`App: ${bundle}\nArchive: ${zip}`);
  }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
