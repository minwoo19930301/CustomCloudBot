# Android image with a preinstalled Unicode input method

`Android.Dockerfile` extends the pinned official Redroid 12 ARM64 image with
[ADBKeyBoard v2.4-dev](https://github.com/senzhk/ADBKeyBoard/releases/tag/v2.4-dev).
A fresh Android `/data` registers the APK from `/system/app/ADBKeyboard` during
first boot. The existing broker then enables/selects the input method in
`DevicePool.ready()`; no `adb install` hook is needed for every room.

## Build and configure

Build on the ARM64 Linux guest or another approved ARM64 build host. The Dockerfile
uses only remote, pinned inputs, so an empty build context avoids sending local
configuration or credentials to Docker:

```sh
docker build -t customcloudbot-android:12-ime - < Android.Dockerfile
docker image inspect --format '{{.Id}}' customcloudbot-android:12-ime
```

Set the guest broker configuration to the built image and input method:

```dotenv
MOBILE_ANDROID_IMAGE=customcloudbot-android:12-ime
MOBILE_INPUT_IME=com.android.adbkeyboard/.AdbIME
```

Save the resulting immutable image ID in the deployment record. A tag must not silently
replace an image already assigned to a room. New and existing rooms keep independent
Android `/data` directories. Image packaging does not change the VM network or ADB
exposure policy.

The image is ARM64-only. Run it inside the per-room Ubuntu VM with Binder support,
memfd and software rendering as described in the VM deployment documentation;
this image does not supply host Binder/KVM support. The BusyBox verification stage
is not included in the final image.

## Pinned inputs

| Input | Pin |
| --- | --- |
| Redroid 12 ARM64 manifest | `sha256:3c7f9450188226bf8042c0159b9b38abe2106f1ceb0dfa45fae1cbc6409cd9bb` |
| BusyBox 1.37.0-musl ARM64 verification stage | `sha256:c542a2b3cb3c982440890284aac884e89dbf468d5ff1c206fd2ba8ea23257420` |
| ADBKeyBoard upstream source commit | `98dc653e8c5e98b3bf9a69561b723545bc5fd5da` |
| APK SHA256 | `e0d0cf276b710cb34c46121f58720f5285a83ed410b0d45f57a0677b67dc2852` |
| Source archive SHA256 | `5e4987fe01697bb927a58c3b183c9b6664732731733b363bc5e77a23e022fe56` |
| License SHA256 | `7ea4b1fa1256b0ab2bbbff489e5e8d8f1f9b864504d60091ff871d80e04f21fa` |

The APK hash matches the upstream GitHub release asset digest. The inspected
upstream debug-signing certificate SHA256 is
`CA3167F1BBB56AC9FE263341BD3C637ACBAEADA93E432DB71BCFBA957BB5423C`.
This uses the published upstream APK; it is not a claim of a reproducible source
build. The downloaded APK, source archive and license are verified before copying
into the final image. A checksum mismatch fails the build.

ADBKeyBoard is published under GPL-2.0. Its upstream license and matching tagged
source archive are included at `/system/etc/adbkeyboard/LICENSE` and
`/system/etc/adbkeyboard/source.tar.gz`. Preserve them when redistributing this image.
The official Redroid image and its existing notices remain intact.

## Runtime verification

On a disposable VM with a newly created, empty Android data directory, start the
image and wait for `sys.boot_completed=1`. Do not reuse a data directory that already
contains an `adb install` of this package when testing preinstallation.

```sh
adb -s 127.0.0.1:5555 shell pm path com.android.adbkeyboard
# package:/system/app/ADBKeyboard/ADBKeyboard.apk
adb -s 127.0.0.1:5555 shell ime list -s
adb -s 127.0.0.1:5555 shell ime enable com.android.adbkeyboard/.AdbIME
adb -s 127.0.0.1:5555 shell ime set com.android.adbkeyboard/.AdbIME
adb -s 127.0.0.1:5555 shell settings get secure default_input_method
# com.android.adbkeyboard/.AdbIME
```

After focusing an actual editable field, send the synthetic string `한글 입력 확인`:

```sh
adb -s 127.0.0.1:5555 shell am broadcast --user 0 -a ADB_INPUT_B64 \
  -p com.android.adbkeyboard --es msg 7ZWc6riAIOyeheugpSDtmZXsnbg=
```

Confirm the exact text in both a screenshot and UIAutomator's editable node.
A successful broadcast exit alone does not prove the text was entered. During
first boot, `sys.boot_completed` may precede the first fully drawn app frame; wait
for the input field to actually be focused before injecting text.

## Local proof (2026-10-25)

Verified on macOS ARM64 with QEMU 11.1.2, explicit TCG, 2 vCPU / 4 GiB Ubuntu Noble
6.8.0-147-generic guest, and a 2.5 GiB / 1.5 CPU Android container at 480×800 / 5 fps.
Ubuntu cloud-init/SSH took 59.5 seconds; first Android boot about 63 seconds. Stable
screenshots took 1.6 seconds. Guest memory after Settings/search was 1129 MiB used and
2776 MiB available, with Android 705 MiB. These are local proof measurements, not OCI
latency or ten-device concurrency guarantees. Initial app rendering took tens of
seconds, so boot and visible-frame readiness must remain distinct.

The exact Dockerfile was also built and booted with a new, empty `/data` on the
same VM. Boot completed after about 83 seconds, `pm path` returned the system APK
path above, its installed SHA256 matched, and `ime enable`/`ime set` succeeded
without running `adb install`. The broker uses that same enable/select sequence.

The baked APK also accepted the broker's package-targeted `ADB_INPUT_B64` broadcast
on that fresh installation; the search field screenshot contained exactly
`한글 입력 확인`. UIAutomator occasionally returned a null root while the first
search screen was still drawing, so a transient observe error must not be treated
as a failed Android boot.
