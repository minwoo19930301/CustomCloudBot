// Public release metadata only. Operators choose their own distribution URLs;
// forks do not inherit another deployment's app downloads or credentials.
export function desktopDownloads(env = {}) {
  let entries;
  try { entries = JSON.parse(env.COMMUNITY_DESKTOP_DOWNLOADS || "[]"); }
  catch { return []; }
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 4).flatMap(entry => {
    if (!entry || entry.platform !== "macos" || !["arm64", "x64"].includes(entry.arch)) return [];
    if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(entry.version)) return [];
    try {
      const url = new URL(entry.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return [];
      return [{ platform: "macos", arch: entry.arch,
        label: entry.arch === "arm64" ? "Mac · Apple Silicon" : "Mac · Intel",
        version: entry.version, url: url.href, notarized: entry.notarized === true }];
    } catch { return []; }
  });
}

export function validateDesktopDownloads(entries) {
  const downloads = desktopDownloads({ COMMUNITY_DESKTOP_DOWNLOADS: JSON.stringify(entries) });
  if (!Array.isArray(entries) || entries.length > 4 || downloads.length !== entries.length ||
      new Set(downloads.map(item => item.platform + ':' + item.arch)).size !== downloads.length)
    throw Object.assign(new Error('Mac 종류·버전·공개 HTTPS 다운로드 주소를 확인해 주세요.'), { status: 400 });
  return downloads;
}
