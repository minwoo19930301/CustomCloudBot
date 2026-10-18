# Private browser desktop container

This directory is a multi-architecture (`linux/amd64` and `linux/arm64`) Debian desktop image for a separately authenticated application proxy. It downloads the official Google Chrome package for the target architecture and starts Google Chrome under Xvfb and Openbox, includes an `xterm` terminal for the remote Linux desktop, serves the VNC display through websockify/noVNC, and exposes Chrome DevTools Protocol (CDP) on the private container network and host loopback only. Verify sandboxed startup, CDP navigation/screenshot and the VNC handshake on your target architecture before release. The official `current` download tracks stable Chrome on a fresh build; retain the image digest and previous image for release rollback.

The internal endpoints are:

| purpose | container endpoint | application proxy contract |
| --- | --- | --- |
| VNC websocket | `desktop-<room UUID>:6080/websockify` | authenticated `/api/rooms/<room UUID>/desktop/ws` websocket proxy |
| CDP | `http://desktop-<room UUID>:9222` | backend-only, allowlisted CDP client for this Google Chrome process |
| raw VNC | `127.0.0.1:5900` inside the container | never proxied or published |

The community application must perform authentication and authorization before proxying the websocket. The desktop service itself has no user-account or token endpoint. The example publishes ports on host loopback for host diagnostics; in the production Compose deployment the app reaches the desktop over the dedicated `community-desktop` network, using the desktop service hostname and internal ports (`6080` for VNC and `9222` for CDP), while WAN clients cannot reach that network. Google Chrome itself listens on container loopback port `9223`; a `socat` bridge provides the container `9222` endpoint. Restrict the proxy to the intended Chrome target and commands.

Required runtime inputs are `DESKTOP_START_URL` (default `about:blank`) and, optionally, `DESKTOP_SCREEN` (default `1280x800x24`). The example also makes the internal ports explicit through `DESKTOP_VNC_PORT`, `DESKTOP_WEBSOCKET_PORT`, and `DESKTOP_CDP_PORT` defaults in the image. Application and provider keys are not passed into this container; browser login state may be stored in its shared home. The app uses `COMMUNITY_DESKTOP_MAP` with a room UUID and the corresponding desktop service hostname; see the parent deployment README. For the containerized app, set `COMMUNITY_HOST=0.0.0.0`; the local-development `.env.example` loopback bind is not suitable inside this container.

Run from this directory with an already installed Docker/Compose:

```sh
docker compose -f compose.example.yml build
docker compose -f compose.example.yml up -d
```

Build both supported architectures from a builder that supports them:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example/community-desktop:0.1 --push .
```

The Compose example applies a 2 GiB memory limit, one CPU, and a 256 PID limit, drops all Linux capabilities, enables `no-new-privileges`, uses a dedicated bridge subnet, and runs the image as UID 10001. Treat 2 GiB as a practical minimum starting point; this is not evidence that the workload fits an OCI 1 GB E2 Micro. Google Chrome plus Xvfb must be measured on the target host before deployment.

The bridge needs internet for ordinary browser navigation. Before admitting users, install the reboot-persistent bridge sysctl, Docker forwarding drop-in, and `community-desktop-firewall.service`/`community-desktop-guard.sh` described below. Apply host firewall policy for the dedicated `172.30.50.0/28` subnet to block private, loopback, link-local, and OCI metadata destinations while allowing normal public egress. The deployed service uses the scoped nftables table described below; the legacy iptables helper is reference material only. It blocks the OCI metadata address, private networks and the host public IP for the desktop source while allowing established replies and public web traffic.

First copy `desktop-network.env.example` to `/etc/openclaw/desktop-network.env`, owned by root with mode `0600`, and set `HOST_PUBLIC_IP` to your host’s public IPv4. Both the firewall service and Docker drop-in require this file; an empty or invalid address fails before applying rules. Do not install the Docker drop-in until this file and the guard script are ready. For a manual invocation, explicitly export `HOST_PUBLIC_IP`.

For a reboot-persistent host installation, copy `99-community-desktop-bridge.conf` to `/etc/sysctl.d/99-community-desktop-bridge.conf` and persist `br_netfilter` in `/etc/modules-load.d/community-desktop.conf`, then run `modprobe br_netfilter` followed by `sysctl --system`. This makes same-bridge desktop egress visible to the scoped filter; IPv6 bridge filtering stays disabled because the Docker bridge is IPv4-only. Then copy `community-desktop-guard.sh` to `/usr/local/sbin/community-desktop-guard`, install `community-desktop-firewall.service`, and install the Docker drop-in from `docker-community-desktop-firewall.conf` as `/etc/systemd/system/docker.service.d/20-community-desktop-firewall.conf`. The service uses an independent `inet community_desktop_guard` nftables table with input/forward/output priority `-100`; `nft -f` replaces only this table in one transaction. Run `systemctl daemon-reload` and `systemctl enable --now community-desktop-firewall.service` after installation. It survives firewalld reload because firewalld owns separate tables. Established/related traffic is accepted before the desktop source filter, so app-to-desktop replies remain allowed. The legacy iptables helper remains for reference but is not required by this service.

Google Chrome is deliberately started without `--no-sandbox`. Its Linux sandbox is a required security boundary. The image does not add `SYS_ADMIN` or a permissive security profile. If the target kernel or default seccomp/user-namespace policy prevents Chrome’s sandbox from starting, fail closed and fix host/runtime compatibility rather than disabling the sandbox.

The profile derived from Docker/Moby’s default profile allows these additional syscall names for Chrome namespace setup: `clone`, `clone3`, `unshare`, `setns`, `mount`, `umount2`, `pivot_root`, and `chroot`. Test Chrome with this profile and its sandbox enabled on your host. Keep the default profile’s deny behavior and review the derived profile as a deployment artifact; do not replace it with `seccomp=unconfined` in production.

The desktop has only its dedicated home storage mount, no Docker socket, no host networking, and no public ports. Browser credentials can persist inside the shared home when a user signs in. Loopback host bindings are reachable only by host-local processes; the community app container uses the private desktop network. Network controls are not a substitute for application authentication: the app must authenticate every desktop session and avoid forwarding arbitrary CDP traffic.

References:

- [Docker Compose service resource and capability controls](https://docs.docker.com/reference/compose-file/services/)
- [Docker Compose resource limits](https://docs.docker.com/reference/compose-file/deploy/)
- [Google Chrome download and supported platforms](https://support.google.com/chrome/answer/95346?co=GENIE.Platform%3DDesktop&hl=en)
- [Chromium Linux sandboxing](https://chromium.googlesource.com/chromium/src/+/main/docs/linux_sandboxing.md)
- [OCI Container Instances overview](https://docs.oracle.com/en-us/iaas/Content/container-instances/overview-of-container-instances.htm)

## Common workspace with separate views
When explicitly configured with COMMUNITY_SHARED_DESKTOP_ROOM=<existing mapped room UUID>, authenticated members of any room use that existing desktop. This is intentional shared workspace access: browser login state and files are common to its users. Room membership, session-bound one-use tickets and origin checks still apply. Service API secrets are not copied into the desktop.

Enable COMMUNITY_DESKTOP_VIEWS=1 only after deploying the updated desktop entrypoint. Browser, Files and Terminal use three independent X displays in the same container and `/home/desktop`; switching the file view does not replace the browser screen. Websocket ports 6080–6082 are internal only. No additional public ports, privileged mode, sandbox bypass or VM is needed. Existing containers must be recreated with their current mounts and network configuration preserved; rebuilding the app alone does not enable these views.

The Browser display starts no Linux dock. Its dedicated `browser-openbox.xml`
maximizes each normal Google Chrome window, including new incognito windows, and
removes the outer window-manager border. Chrome's own tabs, address bar, profile
menu and extensions remain available; this is not kiosk mode. Native dialogs and
the separate Files/Terminal displays keep their own window sizes. Openbox is
ready before Chrome starts so the initial window receives the same rules.

The standard release command hashes this directory and rebuilds/recreates the
managed desktop when these files change. This briefly reconnects browser views;
the existing shared home and Chrome profile are preserved. After rollout, check
the normal window and a newly opened incognito window fill the browser display,
then close only the incognito window used for verification. Also check a native
file chooser and the Files/Terminal views. A healthy VNC handshake alone does not
verify window geometry. The rules follow [Openbox's per-application settings](https://openbox.org/help/Applications).

## Native files and terminal transport

`workspace-bridge.py` runs as the existing `desktop` user (UID 10001), beside Chrome and the compatibility VNC views. Internal port **6083** is never published on the host. Only the application's socket peer `172.30.50.2` and container loopback are accepted. Requests with an `Origin` header are rejected so a page in the remote browser cannot open the internal WebSocket; the authenticated application proxy must omit that header. Forwarded-IP headers do not grant access.

- `GET /health` returns `{ok:true,terminal:true,files:true}`.
- `GET /files?path=<relative>` returns `{path,entries,truncated}`. Each entry contains `name`, relative `path`, `type`, byte `size`, and Unix-millisecond `modified`. Listings stop at 1,000 entries, skip symlinks and special files, and return directories first.
- `GET /file?path=<relative>` downloads a regular file, at most 8 MiB, as an attachment. Directory-FD walks use `O_NOFOLLOW` at every component; absolute paths, traversal and symlink escapes are rejected even if another terminal changes a path during the read.
- `WS /terminal?session=<64 lowercase hex characters>` starts or reattaches a Bash PTY. The application derives the session identifier from the authorized user/session/room; the browser never chooses a raw bridge identifier. Client messages are `{type:"input",data}` (at most 16 KiB of UTF-8) or `{type:"resize",cols,rows}` (2–400 columns, 2–200 rows). Server messages are `ready`, UTF-8 `output`, and `exit` with an exit code.

There are at most 12 live PTYs and four viewers per PTY. Disconnecting a view leaves its shell available for reattachment. The last 64 KiB of output is replayed, output queues are bounded, and slow viewers detach without terminating another viewer or shell. PTYs with no activity for ten minutes are stopped. A minimal environment is passed to Bash; application/provider credentials, host SSH access, Docker control, and host mounts are not added. Commands retain the existing desktop user's container permissions and shared home.

The image installs Debian's `python3-aiohttp`. For local tests, install `aiohttp` in an isolated Python environment and run:

```sh
python -m unittest discover -s apps/community/deploy/desktop -p 'test_workspace_bridge.py' -v
```

References: [aiohttp server/WebSocket API](https://docs.aiohttp.org/en/stable/web_reference.html), [Python PTY API](https://docs.python.org/3/library/pty.html), [Python directory-FD file operations](https://docs.python.org/3/library/os.html#os.open).
