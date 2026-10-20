# Private Android device pool

This service maps a CustomCloudBot room UUID to one persistent Android `/data`
directory and Docker container. It creates devices only on an explicit wake, keeps
room data when a device sleeps, and never adopts an existing unlabelled container.
There is no imitation iPhone interface or public ADB endpoint.

## Host prerequisites

The operator must verify the existing host's CPU architecture, available RAM/disk,
Android-compatible binder kernel devices, Docker, host `adb`, and a trusted Android
image. Do not enable privileged Docker or add kernel modules merely to bypass a
failed preflight. Some Android images require privileged mode; that is an explicit
operator deployment decision represented by `MOBILE_DOCKER_PRIVILEGED`.

The supplied limits are **10 stored devices / 2 running devices**, not evidence that
every host can run two devices. Choose lower limits after checking host capacity.
Existing unmanaged Android containers can be listed in `MOBILE_EXTERNAL_CONTAINERS`
to consume running capacity while retaining their original ownership and data.

## Installation

1. Copy `device-pool.mjs` and `service.mjs` to a dedicated service directory.
2. Create a dedicated service user and private writable data directory. Membership
   in the Docker group grants host-level control; never expose this process directly
   to browsers. The application server is the only client.
3. Copy `mobile-broker.env.example` to `/etc/customcloudbot-mobile.env`, fill the
   approved image/configuration and a newly generated secret of at least 32
   characters, then grant read access only to the service account.
4. Install the example systemd unit, matching its paths and `ReadWritePaths` to the
   chosen data directory. Node 22+ and the host `adb` executable are required.
5. Prefer `MOBILE_LISTEN_SOCKET=/run/community-mobile/mobile.sock` when co-located
   with the application. It opens **no TCP listener**, creates the socket with mode
   `0660`, and uses a private parent directory. The example systemd unit creates
   that directory with mode `0750`; the service `Group` owns both it and the socket.
   Give the application access through that dedicated group (or its configured
   container supplemental group), and mount the runtime directory only into the
   trusted app container. Match app-side `MOBILE_BROKER_SOCKET` to this socket path.
   The bearer token is still mandatory. Empty the socket setting to use the
   loopback TCP listener instead. For a separate network hop, use private
   networking and authenticated TLS; never public HTTP.
6. Configure the application-side mobile gateway with the broker URL and the same
   private token. The gateway must authenticate the user and check room membership
   and read-only state before forwarding any request. Browser clients never receive
   the broker token or ADB connection details.

Example Android arguments and kernel device mappings are intentionally empty. Set
them from the specific verified image and host. Each device's ADB port is bound
only to `127.0.0.1`, starting at `MOBILE_ADB_BASE_PORT`. The Android containers have
`restart=no`: a host reboot preserves their disks without booting all ten devices.

The current text fallback uses Android `input text` and therefore accepts printable
ASCII. For Korean and other Unicode input, bake a trusted ADB keyboard supporting
`ADB_INPUT_B64` into the approved image and set `MOBILE_INPUT_IME`. The broker reports
unsupported text explicitly instead of dropping characters. It does not download
or install an input method automatically.

## HTTP contract

All routes, including health, require `Authorization: Bearer <private token>`.
POST requests require a JSON object with `Content-Type: application/json` and at most
16 KiB. Responses use `Cache-Control: no-store`. No shell-command API exists.

| Route | Result |
| --- | --- |
| `GET /health` | Aggregate capacity only |
| `GET /devices/:roomUUID` | Device state and capacity; never allocates |
| `POST /devices/:roomUUID/wake` `{}` | Allocates if needed, starts Android, waits for boot |
| `POST /devices/:roomUUID/sleep` `{}` | Stops Android while preserving data; refuses an active task lease |
| `POST /devices/:roomUUID/lease` `{active:true/false}` | Refreshes/releases task lease; never allocates or wakes |
| `GET /devices/:roomUUID/screenshot` | PNG bytes |
| `GET /devices/:roomUUID/observe` | Display dimensions and bounded UIAutomator nodes |
| `POST /devices/:roomUUID/input` | Validated tap/swipe/key/text |
| `POST /devices/:roomUUID/launch` `{package:"com.example.app"}` | Launches an installed package |

State response:

```json
{
  "device": {"roomId":"UUID","state":"running","lastActiveAt":0,"leaseExpiresAt":0},
  "capacity": {"slots":1,"maxSlots":10,"running":1,"maxRunning":2}
}
```

States are `unallocated`, `sleeping`, `starting`, `running`, and `error`. Errors use
`{error:"machine_code",message:"public explanation"}` with 409 for sleeping/busy
capacity, 422 for unsupported text, 429 for excess queued requests, and 503 for a
runtime failure. Startup can take the configured boot timeout plus command time;
clients should allow at least 120 seconds for wake.

Observation is `{width,height,nodes:[{text,description,resourceId,className,bounds:
{left,top,right,bottom},clickable,editable,enabled,focused}]}`. It contains at most
400 nodes, stays below 240 KiB encoded, and omits password field text and descriptions. Treat all screen text as untrusted app
content. A cached editable bound allows the browser to focus its native input
synchronously during the user's tap, including on iPhone.

Inputs:

- `tap`: integer `x,y` inside current Android dimensions.
- `swipe`: integer `x1,y1,x2,y2`, optional `duration` from 100–3000 ms.
- `key`: `BACK`, `HOME`, `APP_SWITCH`, `ENTER`, `DEL`, `TAB`, `ESCAPE`, or `DPAD_UP`,
  `DPAD_DOWN`, `DPAD_LEFT`, `DPAD_RIGHT`.
- `text`: 1–2000 characters, no C0/C1 control characters.

The gateway should refresh an AI task's lease every 30 seconds and release it in a
`finally` block. Default leases expire after 120 seconds, so a crashed client does
not keep the device awake forever. Screenshots and actual input refresh inactivity;
status polling does not. Default idle timeout is ten minutes. Broker restarts
reconcile the existing labelled containers and state file; per-room storage is not
deleted by any API in this service.

## Verification

Run `node --test apps/community/deploy/mobile/device-pool.test.mjs` from the repo.
Tests use a fake Docker/ADB runtime and temporary private metadata directories;
they never start or modify real Android containers. Verify actual host boot,
screenshots, isolation, Unicode input, touch/scroll, sleep/wake persistence and
resource use separately before enabling the integration for users.

## Camera and microphone input

The current broker does **not** forward a user's physical camera or microphone
into Android. A camera or recorder APK cannot supply the missing Android hardware
provider. The desktop's virtual microphone is separate and is never assigned to
mobile rooms.

Before enabling mobile media, verify the selected Android image's camera provider
and microphone input HAL, then implement an authenticated room-specific media
ingress. The upstream Redroid Android 12 image does not ship a camera provider in
its device manifest. `scrcpy --video-source=camera` and `--audio-source=mic`
capture Android devices; they do not inject the viewer's camera or microphone.
Do not advertise those flags as local-device passthrough. KVM-based alternatives
also require an actual available `/dev/kvm`; they are not a drop-in replacement
on a host without nested virtualization.

References: [Redroid device manifest](https://github.com/remote-android/device_redroid/blob/redroid-12.0.0/manifest.xml),
[Redroid WebRTC plans](https://github.com/remote-android/redroid-doc#webrtc-streaming),
[AOSP external camera providers](https://source.android.com/docs/core/camera/external-usb-cameras).
