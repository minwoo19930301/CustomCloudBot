import { promises as fs } from 'node:fs';
import { normalizeAppUrl } from './security.mjs';

// A distributor may choose a public service origin, never a login or permission.
export function releaseMetadata(origin) {
  return { version: 1, appOrigin: origin == null || String(origin).trim() === '' ? '' : normalizeAppUrl(origin) };
}

export async function initialDesktopSettings(settingsPath, releasePath, readFile = fs.readFile) {
  try { return JSON.parse(await readFile(settingsPath, 'utf8')); }
  catch (error) {
    // Existing settings, including corrupt ones, must never silently switch services.
    if (error.code !== 'ENOENT') throw error;
  }
  let release;
  try { release = JSON.parse(await readFile(releasePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (release?.version !== 1) throw new Error('unsupported_release_metadata');
  const { appOrigin } = releaseMetadata(release.appOrigin);
  return appOrigin ? { origin: appOrigin, roots: [], capabilities: { files: false, terminal: false, browser: false } } : null;
}
