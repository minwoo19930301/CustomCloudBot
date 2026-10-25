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
provides TCG. `/usr/bin/qemu-img`, Python 3, Node, nftables, and systemd are also
required. The installer must first inspect the DNF transaction; no kernel,
libvirt, or existing package replacement is required for this deployment.

Create an isolated root-owned Python environment for the small CIDATA builder:

```sh
python3 -m venv /opt/customcloudbot-mobile/seed-venv
/opt/customcloudbot-mobile/seed-venv/bin/python -m pip install 'pycdlib==1.22.0'
```

`vm-seed.py` reads a bounded JSON object on stdin, creates an ISO without a
temporary plaintext credentials file, and never logs parser details. Its inputs
come only from the host pool's HMAC-derived room token, not client-supplied
commands or paths. `MOBILE_VM_SEED_PYTHON` and `MOBILE_VM_SEED_SCRIPT` may point to
administrator-installed root-owned equivalents. Do not allow untrusted accounts
to change those settings or code files.

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

Before sealing, stop the guest broker, disable it until first boot's cloud-init
restart, remove build credentials and authorized SSH keys, and clear build-only
Android room data. Run `cloud-init clean --logs --machine-id` as the final guest
preparation, then shut down without another boot of the golden image. Do not
capture active Docker databases or a token already used for production rooms.
The seed uses a unique instance ID for each room and creates no login account.
The golden guest must not contain a common active SSH key/password. Each room's
broker is enabled after its private environment is installed.

The token appears only in CIDATA user-data, cloud-init's private retained
user-data, and `/etc/customcloudbot-mobile.instance.env` (0600). It is not put in
`runcmd`, metadata, command arguments, or a shell command. QEMU's serial output is
disabled and systemd stdout is discarded. Cloud-init debug tooling and support
archives can include user-data: treat each guest's `/var/lib/cloud` and seed ISO
as credentials and do not collect them into ordinary diagnostic logs.

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
