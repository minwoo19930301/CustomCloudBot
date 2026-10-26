# CustomCloudBot Desktop — macOS

A native companion for using a computer from your own private CustomCloudBot conversations. The app opens your existing HTTPS service and runs the explicitly enabled local tools while its connection is active.

## Build and run

From the repository root, with Node.js 22.18 or later:

```sh
npm install
npm start --workspace @custom-cloud-bot/desktop
npm test --workspace @custom-cloud-bot/desktop
npm run package:mac --workspace @custom-cloud-bot/desktop
```

The Mac packager builds the host architecture by default. For an Intel Mac build, run `node apps/desktop/scripts/package.mjs darwin x64`. Output is under `apps/desktop/dist/`; the `.app` and ZIP contain only the native app files and Electron, never the repository's private configuration or credentials.

For a deployment-specific download, optionally set `CCB_DESKTOP_APP_ORIGIN=https://your-bot.example.com` when packaging. The validated HTTPS origin is included in `release.json` and opens the existing web app on a fresh installation. It does not replace an existing configuration or enable any computer permission. Generic builds leave this unset and ask for the service address in the compact settings screen.

The app includes its GPL license and the Electron/Chromium notices under `Contents/Resources/licenses` before code signing. Publish each binary alongside the corresponding source tag/archive so recipients can obtain the matching source.

The default build uses a local ad-hoc signature. It requires no paid Apple developer account, but is not a notarized public release. Public distribution can supply a Developer ID through `CCB_MAC_SIGN_IDENTITY` and add Apple notarization in the release pipeline. Do not disable Gatekeeper to distribute the application. Consistent Developer ID signing is also needed for smooth Keychain identity across future releases.

## Connect a computer

1. Open **CustomCloudBot Desktop.app**. A deployment-specific build opens its web app immediately. For a generic build, enter the HTTPS origin of your CustomCloudBot installation and choose **서비스 열기**.
2. Log in using your existing account. Open **내 컴퓨터 연결 · 데스크톱 설정** from the web app's account menu, or press **⌘,**.
3. Select file access, terminal execution, and/or browser link opening. File access requires choosing folders through the native folder dialog.
4. Choose **연결 허용**, check the account and permissions in the native dialog, and confirm.
5. Ask in one of your own private conversations, for example “연결한 내 컴퓨터의 선택 폴더 목록을 보여줘”.

If secure storage times out, check for a macOS Keychain approval dialog and handle it yourself. Then use **암호 저장소 다시 확인** in desktop settings. This bounded check updates storage availability only; it does not enable permissions, pair a computer, or write settings or credentials.

No cloud address, personal account, API key, or computer permission is preconfigured in the repository. The companion needs a server version that includes `/api/local-computers` and the local-computer model tools. Shared rooms, monitor rooms, and other users' rooms cannot run local-computer tools.

The app starts paused every time. Use the native application menu for pause or connection settings; settings are also available from the web account menu or **⌘,**. Logout or switching the web login pauses the local connection when checked before the next polling cycle. Connection revocation removes the device credential; closing the app stops active local commands before the process exits. Already completed file changes are not rolled back.

## Permission scope

- **Files:** list, read, and write within the explicitly selected folders. Symlink escapes and common credential locations are blocked by the file tools.
- **Terminal:** execute as the currently logged-in OS user. This is **not constrained to the selected folders**: commands can access that user's other files and programs. No root access or passwordless `sudo` is added.
- **Browser:** open a link in the Mac's default browser. This release does not drive the local browser, capture the screen, or click/type in native apps.
- macOS may separately require filesystem permission for protected folders. The native app offers the system settings link; it does not grant this permission itself.

The remote service view has no Node.js access; its only native bridge opens the connection settings, without granting permissions or returning private data. Only the bundled local settings page can invoke native configuration actions. Device credentials and pending results use Electron's OS-backed `safeStorage`, fail closed if encryption is unavailable, and are never exposed to the web renderer. Version 0.1.1 uses only the async API on every platform, with bounded waits and no synchronous fallback. Chromium can initialize macOS Keychain independently; synchronous legacy storage calls can then deadlock the Electron main thread. If async storage is unavailable or times out, the web app stays usable and the computer connection remains disabled until a later retry succeeds. Existing async records remain readable. Earlier legacy records require reconnecting through the native consent dialog instead of an automatic migration; the original encrypted file is preserved until the user reconnects. Insecure Linux backends are rejected. The encrypted record identifies its provider and format version, and a nonsecret `storage-diagnostic.json` records availability/self-test status. The deprecated legacy API is never called, including before a future Electron 46 upgrade. Device tokens authenticate only the native transport routes. A completed or canceled command is not automatically rerun if result delivery fails.

Native settings live in the app's user-data folder (`~/Library/Application Support/CustomCloudBot Desktop` on macOS). Service URL, capability choices, and selected folder paths are stored in `desktop-settings.json`; the credential and any pending result are encrypted in `desktop-connection.enc`. Local file contents and command output requested by the bot are sent to the configured service.
