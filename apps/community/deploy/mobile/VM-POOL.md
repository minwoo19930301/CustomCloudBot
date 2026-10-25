# One Android VM per conversation

`vm-service.mjs` runs the host controller. It reuses the existing authenticated
broker routes from `service.mjs` on a Unix socket; it never opens a public TCP
listener. The original `service.mjs`/`DevicePool` remains the single-device guest
broker. Do not replace the guest entrypoint with the host controller.

The host defaults to ten saved room slots and one running VM. Each UUID receives
a stable slot, a private HMAC-derived guest token, its own 12 GiB qcow2 overlay
and cloud-init seed, and a fixed systemd unit. The runtime adapter supplies the
overlay and seed; the pool never accepts arbitrary commands or caller URLs.
Guest Android and ADB stay inside that VM. Host forwarding is loopback-only
`18091 + slot` to guest `10.0.2.15:8091`.

## Startup and readiness

`POST /devices/:uuid/wake` returns `starting` promptly. The caller polls the
existing status route until `running` or `error`. Repeated requests for the same
room reuse its outstanding startup. Starting QEMU, or receiving guest health,
does not mean Android is ready: only a successful guest wake response for that
exact UUID completes startup. After a host-controller restart, already running
VMs repeat this Android readiness check in the background. Sleeping saved VMs
are never started by status, health or controller initialization.

Guest network startup is bounded by `MOBILE_VM_BOOT_SECONDS` (180 seconds by
default); Android startup by `MOBILE_VM_ANDROID_BOOT_SECONDS` (300 seconds).
The app's AI tools wait up to ten minutes and poll status, sending no input while
preparing. The workspace remains usable for chat and displays `Android 연결됨`
only after its first screenshot has decoded. Closing a workspace cancels that
view's requests, not the server's VM startup. Reopening reuses the same room VM.

A running VM may be replaced only when it has no live task lease and no queued
or running operation. Idle VMs are preferred. Sleep first requests guest sleep,
then stops and verifies the host unit. A unit that fails to stop still occupies
capacity. Its disk is retained. Leases and screen/input activity prevent idle
shutdown; status polling does not refresh activity.

## Host service requirements

Use Node.js 24 with an explicit absolute executable path in the host unit.
The existing `customcloudbot-mobile.service` is the Docker/guest example, not a
host VM controller unit: its user, writable paths and entrypoint differ.
The host manager needs root to provision fixed files, set their owners, and
control only the validated `customcloudbot-mobile-vm@<uuid>.service` units.
QEMU itself runs unprivileged with no capabilities and with the separate VM
mount/network restrictions provided by its unit and firewall.

`MOBILE_VM_DATA_DIR` defaults to `/var/lib/customcloudbot-mobile-vm`; the installer
must assign its private VM group. The directory is root-owned `0750` so QEMU can
traverse to its own files. `vm-pool.json` is `0600` and contains no tokens.
The runtime adapter owns permissions below `rooms/<uuid>`. The app-facing socket
is `0660` in a `0750` directory; its group must match the container's actual
host-mapped supplementary group. Do not make the socket world-writable.

`/health` is controller liveness/capacity, not a claim that a phone is ready.
Operational verification must wake a disposable room, wait for `running`, and
retrieve a real screenshot/observation; then test sleep and persisted restart.

## Credential rotation

The master broker token also derives all per-room guest tokens. The existing
runtime keeps a room's seed when reusing its disk. Rotating the master without
updating those guest credentials will break authentication to saved VMs.
Rotate in a maintenance window: stop the affected VMs, update their generated
seeds and guest broker credentials using the same new derived token, then
restart and verify them. Merely replacing a seed on a reused cloud-init instance
may not rerun its configuration; verify the effective guest credential. Never
print tokens, put them in process arguments, or erase saved overlays to rotate.

## Local verification

```sh
node --test apps/community/deploy/mobile/vm-pool.test.mjs apps/community/deploy/mobile/vm-service.test.mjs apps/community/deploy/mobile/vm-runtime.test.mjs
node --test apps/community/test/mobile.test.mjs apps/community/test/mobile-workspace-ui.test.mjs
```

These tests use fake runtime adapters and private loopback/Unix HTTP servers.
They cover room isolation, startup deduplication, task leases, eviction races,
capacity, timeout/abort, persisted restart and UI readiness. They do not prove
that a particular OCI host can boot Android; that requires the live check above.

## Read-only host network and process checks

These commands inspect existing state; they do not install packages, alter
firewall rules, start VMs, or query OCI instance metadata:

```sh
getent passwd ccb-mobile-vm
sudo systemctl show customcloudbot-mobile-vm-firewall.service -p ActiveState -p SubState
sudo nft -a list table inet community_mobile_vm_guard
sudo ss -lntp
sudo sysctl kernel.yama.ptrace_scope
sudo systemctl cat customcloudbot-mobile-vm@.service
```

Check that the nft output matches the QEMU UID, permits only the required DNS
exception at the OCI resolver, and blocks private networks, link-local metadata,
host-local addresses and the host's public address. Check for loopback-only VM
broker ports; neither guest ADB nor port 8091 should have a public host listener.
Review the entire table order, including existing/related connection handling.

For an existing room, substitute its validated UUID below:

```sh
sudo systemctl show customcloudbot-mobile-vm@<uuid>.service -p MainPID -p User -p Group -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p InaccessiblePaths -p TemporaryFileSystem -p BindPaths -p BindReadOnlyPaths
```

If VM processes share a UID, inspect the effective process and mount isolation
as well as firewall rules. A per-room bind mount alone does not prove that
another process's `/proc/<pid>/root` or file descriptors are inaccessible. A
same-UID process-access test must be made from the VM process's actual mount
namespace. The commands above are configuration evidence, not a substitute for
that live isolation test or a controlled egress test.
