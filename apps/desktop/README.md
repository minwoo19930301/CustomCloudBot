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

The default build uses a local ad-hoc signature. It requires no paid Apple developer account, but is not a notarized public release. Public distribution can supply a Developer ID through `CCB_MAC_SIGN_IDENTITY` and add Apple notarization in the release pipeline. Do not disable Gatekeeper to distribute the application. Consistent Developer ID signing is also needed for smooth Keychain identity across future releases.

## Connect a computer

1. Open **CustomCloudBot Desktop.app**. Enter the HTTPS origin of your CustomCloudBot installation and choose **서비스 열기**.
2. Log in using your existing account. Return to **연결 설정**.
3. Select file access, terminal execution, and/or browser link opening. File access requires choosing folders through the native folder dialog.
4. Choose **연결 허용**, check the account and permissions in the native dialog, and confirm.
5. Ask in one of your own private conversations, for example “연결한 내 컴퓨터의 선택 폴더 목록을 보여줘”.

No cloud address, personal account, API key, or computer permission is preconfigured in the repository. The companion needs a server version that includes `/api/local-computers` and the local-computer model tools. Shared rooms, monitor rooms, and other users' rooms cannot run local-computer tools.

The app starts paused every time. The top bar provides pause and connection settings. Logout or switching the web login pauses the local connection when checked before the next polling cycle. Connection revocation removes the device credential; closing the app stops active local commands before the process exits. Already completed file changes are not rolled back.

## Permission scope

- **Files:** list, read, and write within the explicitly selected folders. Symlink escapes and common credential locations are blocked by the file tools.
- **Terminal:** execute as the currently logged-in OS user. This is **not constrained to the selected folders**: commands can access that user's other files and programs. No root access or passwordless `sudo` is added.
- **Browser:** open a link in the Mac's default browser. This release does not drive the local browser, capture the screen, or click/type in native apps.
- macOS may separately require filesystem permission for protected folders. The native app offers the system settings link; it does not grant this permission itself.

The remote service view has no privileged preload or Node.js access. Only the bundled local settings page can invoke native configuration actions. Device credentials and pending results use Electron's OS-backed `safeStorage`, fail closed if encryption is unavailable, and are never exposed to the web renderer. Device tokens authenticate only the native transport routes. A completed or canceled command is not automatically rerun if result delivery fails.

Native settings live in the app's user-data folder (`~/Library/Application Support/CustomCloudBot Desktop` on macOS). Service URL, capability choices, and selected folder paths are stored in `desktop-settings.json`; the credential and any pending result are encrypted in `desktop-connection.enc`. Local file contents and command output requested by the bot are sent to the configured service.
