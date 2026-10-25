# Per-room Android VM runtime

This adapter runs one Ubuntu/Android guest per room on the existing Oracle Linux
ARM64 server. QEMU uses TCG; it does not load host Binder modules, require KVM,
change the host kernel, or join a host Docker network. The Linux guest contains
the Android Docker runtime and broker. The host pool exposes its authenticated
Unix socket to the existing app; guest credentials never go to the browser.

## Installed paths and ownership

The supplied systemd template and launcher use these fixed deployment paths:

| Path | Owner / mode | Purpose |
| --- | --- | --- |
| `/opt/customcloudbot-mobile/` | root, not group/world writable | Audited broker and runtime code |
| `/var/lib/customcloudbot-mobile-vm/` | root:ccb-mobile-vm, 0750 | Pool state and images |
| `base/{golden.qcow2,Image,initrd}` | root:ccb-mobile-vm, 0640 | Sealed 12 GiB image and matching boot files |
| `rooms/<uuid>/` | root:ccb-mobile-vm, 0750 | One room's persistent VM |
| `rooms/<uuid>/disk.qcow2` | ccb-mobile-vm:ccb-mobile-vm, 0600 | 12 GiB sparse overlay |
| `rooms/<uuid>/{seed.iso,runtime.json}` | root:ccb-mobile-vm, 0640 | Private token seed and fixed slot metadata |
| `/run/customcloudbot-mobile-vm/<uuid>/` | ccb-mobile-vm, 0700 | Private QMP shutdown socket |

Create `ccb-mobile-vm` as a system user with `/sbin/nologin`, no supplementary
groups, no sudo, and no Docker access. The host pool runs as root so that it can
create immutable instance configuration and control only validated unit names.
QEMU starts as the unprivileged user from the beginning. A unit-specific mount
namespace hides every other room, including their QMP sockets. Do not replace
the unit with a root QEMU process or rely only on QEMU's late `-runas` option.
`InaccessiblePaths=/proc` also blocks same-UID access through another process's
`root` or `fd` links. TCG initialization with this setting was verified on the
existing Oracle Linux host; complete guest boot must still be checked after
installing the final template.

`MOBILE_VM_DATA_DIR` defaults to `/var/lib/customcloudbot-mobile-vm`. Moving it
requires updating the launcher's `BASE` and systemd mount paths together. The
base port is fixed to 18091. Slot N listens only at `127.0.0.1:18091+N`, forwarded
to guest `10.0.2.15:8091`. No SSH, VNC, ADB, or QMP TCP port is exposed. IPv6 is
disabled in QEMU user networking. Preserve the app's membership checks, private
broker token, and socket permissions.

## Dependencies and seed creation

Use the verified Oracle Linux AppStream QEMU package set. On the inspected OL9
host, `/usr/libexec/qemu-kvm` from `qemu-kvm-core-10.1.0-17.el9_8.5.aarch64`
provides TCG. `/usr/bin/qemu-img`, Python 3.12 for the seed builder, Node.js 24 for
the host broker, nftables, and systemd are also
required. The installer must first inspect the DNF transaction; no kernel,
libvirt, or existing package replacement is required for this deployment.

The host's default `/usr/bin/python3` is Python 3.9. It can run the standard-library
launcher/shutdown helpers, but it cannot install the pinned pycdlib release.
Install Oracle's `python3.12` and `python3.12-pip` alongside the system Python,
after reviewing the package transaction. Do not change `/usr/bin/python3` or
upgrade the system Python in place. Create an isolated root-owned environment
for the small CIDATA builder:

```sh
python3.12 -m venv /opt/customcloudbot-mobile/seed-venv
/opt/customcloudbot-mobile/seed-venv/bin/python -m pip install 'pycdlib==1.22.0'
```

`vm-seed.py` reads a bounded JSON object on stdin, creates an ISO without a
temporary plaintext credentials file, and never logs parser details. Its inputs
come only from the host pool's HMAC-derived room token, not client-supplied
commands or paths. `MOBILE_VM_SEED_PYTHON` and `MOBILE_VM_SEED_SCRIPT` may point to
administrator-installed root-owned equivalents. Do not allow untrusted accounts
to change those settings or code files.

The seed builder also reads the fixed sibling `device-pool.mjs` and `service.mjs`
from its root-owned installation directory. Both must be non-symlink regular
files, root-owned, not group/world writable, and at most 256 KiB each. No request
can supply a source path or source code. CIDATA installs these two audited files
as root:root 0644 under `/opt/customcloudbot-mobile` inside the guest, then restarts
its broker. Broker-only updates therefore do not require rebuilding the golden
Android image or replacing a room's disk.

When provisioning an existing **stopped** VM, the adapter builds `seed.iso.tmp`,
checks its private permissions, and atomically replaces `seed.iso`. It preserves
`disk.qcow2` and `runtime.json`; a failed build retains the old seed and removes
the partial replacement. It rejects an active VM before building a seed and
rechecks that it remains stopped before publication. The pool must serialize
provision/start for each room.

The NoCloud instance ID is `customcloudbot-mobile-<room>-runtime-v2-<revision>`,
where revision is the first 12 hexadecimal characters of
`SHA256(device-pool.mjs UTF-8 bytes + NUL + service.mjs UTF-8 bytes)` in that exact
order. Unchanged code keeps the instance ID stable; updated code causes
cloud-init to install the new broker on the next boot while keeping the room's
persistent data. Tokens and keys are excluded from the hash. Changing only the
token does **not** trigger cloud-init again, so credential rotation still needs
an explicit stopped-instance reinitialization plan.

## Initial setup evidence (2026-10-25)

Read-only inspection of the existing OCI host confirmed the following setup:

| Component | Observed value |
| --- | --- |
| Host | Oracle Linux 9 ARM64, existing UEK `6.12.0-204.92.4.3.1.el9uek.aarch64`, 4 KiB pages |
| Host JavaScript | `/usr/bin/node` v24.20.0 |
| System Python | `/usr/bin/python3` 3.9.25, retained unchanged |
| Seed environment | `/opt/customcloudbot-mobile/seed-venv/bin/python` 3.12.15 |
| Data root and base | root:ccb-mobile-vm (UID 0 / GID 986), 0750 |
| Host broker unit | `User=root`, `Group=opc`, loopback-only network allowance |
| Configured saved / running devices | 10 / 1 |
| Configured VM / Android boot deadlines | 600 seconds / 300 seconds after the first OCI cold-boot measurement |
| Configured broker request deadline | 30 seconds |

The Python 3.12 dependency transaction added six packages without upgrading
existing packages. The broker was still inactive and `/run/community-mobile`
had not been created at this inspection. These facts confirm initial setup,
not a successful Android session on OCI.

The Linux guest base is Ubuntu 24.04 Noble ARM64. The separate local TCG proof
booted kernel `6.8.0-147-generic` with its matching `linux-modules-extra`, Docker,
ADB, and the pinned Android image; see [ANDROID-IMAGE.md](ANDROID-IMAGE.md) for
the exact image and measured proof. The OCI golden preparation installed Ubuntu
Node.js 18.19 for the small dependency-free guest broker. That guest parser check
does not replace a complete Android boot test, and Node 18 is not the host app's
runtime. The host broker and app use Node 24.

`Group=opc` is only for the app-facing socket. Since the controller's effective
UID is root, it can traverse and provision the existing root:ccb-mobile-vm data
tree without changing that tree's group to `opc`. The systemd RuntimeDirectory
is root:opc 0750; `listenServer` makes its socket 0660. The app container must
receive the directory bind and its actual host-mapped group. Do not add the app
to the VM group or grant it access to room seeds/disks. The installer must create
the data root with the VM group before first startup; otherwise a newly created
root:opc parent would prevent QEMU from traversing it.

The host broker unit sets `RuntimeDirectoryPreserve=yes`. Docker bind-mounts
`/run/community-mobile` by directory inode, so removing and recreating that
directory on a broker restart would leave the app attached to the old directory.
Preserve the directory across service stops/restarts and replace only its socket.
Keep its existing root:opc 0750 permissions and the socket's 0660 mode. A host
reboot still recreates `/run`; the broker must create the directory before the
app container starts or is recreated with its bind mount.

The first OCI VM reached the guest HTTP broker about 4 minutes 16 seconds after
QEMU startup. The configuration was therefore extended to
`MOBILE_VM_BOOT_SECONDS=600`, overriding the code's 180-second default. The updated
instance seed also sets the guest's separate Android boot deadline to
`MOBILE_BOOT_SECONDS=600`; align the host pool's Android wait budget with it.
HTTP availability alone does not
prove Android is ready. Both guest boot and Android readiness happen in
the background; the private wake HTTP response is prompt and reports `starting`.
Status must become `running` only after the room-specific guest reports a real
Android boot. Keep the data root, launcher's fixed `BASE`, systemd bind paths,
and pool environment aligned when moving this installation.

## Golden guest requirements

The golden image must be shut down and flattened into standalone qcow2 with a
12 GiB virtual size. The adapter rejects a base with an external backing chain.
`Image` and `initrd` must match the guest kernel/modules. Its root filesystem is
labelled `cloudimg-rootfs`.

The guest must already contain a working ARM64 Android image, Docker, ADB, Node,
`/opt/customcloudbot-mobile/service.mjs`, and
`customcloudbot-mobile.service`. `/etc/customcloudbot-mobile.env` contains the
verified Android image/device/network configuration. The NoCloud seed adds a
second EnvironmentFile with a per-room token, guest network binding, and
`MOBILE_MAX_SLOTS=1` / `MOBILE_MAX_RUNNING=1`; it preserves the verified Android
settings in the base file. This is a VM boundary: privileged Android, if required
by the validated image, stays inside its own guest and is never host Docker.

The golden must load `binder_linux` through `/etc/modules-load.d/android.conf`
and order its binderfs mount after that load. The OCI guest's 2026-10-25 boot
journal confirmed `dev-binderfs.mount` failed with `unknown filesystem type
'binder'` even though a later manual `modprobe binder_linux` succeeded. A plain
`binder /dev/binderfs binder defaults 0 0` fstab entry does not establish ordering
against `systemd-modules-load.service`; a required local mount failure can send
the guest into emergency mode.

Install this fixed, root-owned 0644 file **in the golden before sealing** at
`/etc/systemd/system/dev-binderfs.mount.d/order.conf`:

```ini
[Unit]
Requires=systemd-modules-load.service
After=systemd-modules-load.service
```

Keep the guest broker's `Requires=dev-binderfs.mount` and
`After=dev-binderfs.mount` dependencies. A missing Binder module must still stop
Android startup; do not mask the mount or report readiness from broker HTTP
alone. The seed writes the same drop-in to preserve this rule during upgrades,
but cloud-init `write_files` runs after the initial fstab mounts. Seed-only
installation is therefore **not** a first-boot fix for an uncorrected golden.

Before sealing, reboot a disposable guest from the corrected base and inspect
the actual boot, without manually loading Binder first:

```sh
systemctl show dev-binderfs.mount -p Requires -p After -p ActiveState
systemctl is-active systemd-modules-load.service dev-binderfs.mount
test -c /dev/binderfs/binder-control
journalctl -b -u systemd-modules-load.service -u dev-binderfs.mount --no-pager
```

The mount must be active with the module-loader dependencies present and no
mount failure/emergency boot. After sealing, verify a fresh overlay's cold boot
and a second sleep/wake, including real Android boot and a screenshot. A manual
mount in the preparation guest does not satisfy this check. Never modify a
golden backing file already used by saved overlays; prepare a separate corrected
base and preserve each existing overlay's backing chain during migration.

Before sealing, stop the guest broker, disable it until first boot's cloud-init
restart, remove build credentials and authorized SSH keys, and clear build-only
Android room data. Run `cloud-init clean --logs --machine-id` as the final guest
preparation, then shut down without another boot of the golden image. Do not
capture active Docker databases or a token already used for production rooms.
The seed uses a unique instance ID for each room and creates no login account.
The golden guest must not contain a common active SSH key/password. Each room's
broker is enabled after its private environment is installed.

SSH stays disabled in the sealed guest. The instance seed sets
`ssh_genkeytypes: []` to skip unnecessary host-key generation during TCG boot.
An operator deliberately restoring SSH access must first run `ssh-keygen -A`
inside that guest and configure a new private recovery key; no shared bootstrap
key or SSH forwarding port is retained by this runtime.

The token appears only in CIDATA user-data, cloud-init's private retained
user-data, and `/etc/customcloudbot-mobile.instance.env` (0600). It is not put in
`runcmd`, metadata, command arguments, or a shell command. QEMU's serial output
stays in a bounded 128 KiB in-memory ring buffer; it is not written to a file,
network port, or journal, and systemd stdout is discarded. Cloud-init debug tooling and support
archives can include user-data: treat each guest's `/var/lib/cloud` and seed ISO
as credentials and do not collect them into ordinary diagnostic logs.

For a VM that does not reach its private HTTP broker, the root operator can run
`python3 /opt/customcloudbot-mobile/vm-bootlog.py <room-uuid>` to read the existing
private QMP ring buffer. This helper accepts only a room identifier, issues only
QMP capabilities and the fixed `ringbuf-read` command, has a five-second deadline,
and returns at most the last 16 KiB of console text. It does not open credentials
or environment files and redacts token-shaped values before clipping output.
Reading drains the currently retained buffer, so a second read contains only new
output. Do not expose this diagnostic helper or the QMP socket through app tools.

## Firewall and service ordering

Install `vm-firewall.py` root-owned and put the host's verified public IPv4 alone
in root-owned `/etc/sysconfig/customcloudbot-mobile-vm-public-ip` (0644 is enough;
this is not a credential). Install the dedicated firewall service and VM
template. Enable/start the firewall before starting any VM. The firewall helper
validates its own UID/address and replaces only `inet community_mobile_vm_guard`
in one nft transaction; it never flushes existing Oracle, Docker, desktop, or
firewalld rules. Existing audited equivalent guard deployments can remain in
place instead of installing this example a second time.

The dedicated QEMU UID may make new connections to ordinary public destinations.
Host/local/private/metadata HTTP access and IPv6 are rejected. Only DNS port 53
to the OCI resolver `169.254.169.254` is excepted. Established connections allow
responses to the host's loopback broker connections. Install the policy before
VM boot so no earlier forbidden connection is grandfathered in. The public IP
is included because OCI's public NAT address does not match `fib ... type local`.

The launcher uses Python `os.execv` to enter QEMU under the existing SELinux
service policy. Keep SELinux enforcing; do not add a broad policy or disable it.
TCG needs executable mappings, so `MemoryDenyWriteExecute` is intentionally not
set. Resource bounds are 4 GiB guest RAM, 2 virtual CPUs, host `MemoryMax=6G`,
`CPUQuota=200%`, and 12 GiB virtual disk per room. The pool's max-running limit
must fit host RAM and measured TCG boot latency; logical slots do not imply
simultaneous running devices. New allocation requires at least 20 GiB free.
The guest receives a virtio RNG backed by host `/dev/urandom`, limited to 1 KiB
per second, so initial key generation does not wait for virtual-device entropy.

## Stop, validation, and rollback

The pool first asks the Android broker to sleep. `systemctl stop` invokes the
fixed QMP helper, asks this guest to power down, and waits up to 30 seconds for
QEMU EOF after its disk flush. systemd enforces a termination fallback for an
unresponsive guest. A timed-out stop remains an error/running reservation until
the pool verifies that the process has stopped; it is not a successful sleep.

Validate the actual service under SELinux and its mount namespace: only its
own room is visible, another room's disk/seed/QMP is inaccessible, guest broker
port is loopback-only, metadata HTTP and private-address egress fail, DNS and a
public HTTPS request succeed. Then check guest `/health`, actual Android
`sys.boot_completed=1`, a real screenshot, input, sleep, and wake of the same
room. Creating a process or an ISO is not an Android success check.

For rollback, stop the host pool and VM instances first. Preserve each room's
overlay/seed if recovery is wanted. Remove only this deployment's services and,
after no VM remains, `nft delete table inet community_mobile_vm_guard`. Do not
alter the shared desktop, host Docker, or Oracle metadata policy. Master-token
rotation requires an explicit stopped-instance re-seed/reinitialization plan;
do not silently discard a user's persistent disk.

Local checks:

```sh
node --test apps/community/deploy/mobile/vm-runtime.test.mjs
python3 -m unittest discover -s apps/community/deploy/mobile -p 'test_vm_support.py' -v
```
