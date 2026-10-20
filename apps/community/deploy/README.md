# CustomCloudBot self-hosted Docker deployment

Optional [owner-only host administration](host-admin/README.md) gives an explicitly
selected administrator account root command tools across its ordinary chats,
Forks and routines. Authorization follows the authenticated message sender, so
sharing a room or forking its history does not grant this authority to invitees.
It is disabled in fork defaults and requires a separately installed host service.
The shared desktop/browser stays non-root. Replies in shared rooms remain visible
to room members; the agent is instructed not to publish raw credentials.

These files are templates for your own Linux host. They contain no configured server, cloud account, domain, workspace UUID or model provider. Docker Compose does not create a cloud VM, disk, DNS record or paid subscription. Choose the host and its billing limits separately.

The application, shared desktop, Caddy and optional OpenClaw gateway use separate containers. This is an invite-only workspace: invited users share the configured desktop's browser logins and files, while chat membership and session authorization remain enforced. Do not expose the desktop to users who should not share that computer.

## Local app-only start

For an initial local installation, use `compose.portable.yml`. Copy `.env.portable.example` to `.env.portable`, set mode `0600`, and supply a new `COMMUNITY_BOOTSTRAP_TOKEN`. The example origin is `http://127.0.0.1:8787`.

```sh
docker compose --env-file .env.portable -f compose.portable.yml config --quiet
docker compose --env-file .env.portable -f compose.portable.yml up -d --build
```

This publishes only `127.0.0.1:8787`, persists application data in a named volume, and has no desktop, cloud account, Docker socket or `community.slice` dependency. HTTP mode is for local use; do not change its loopback port to a public bind. For a differently named environment file, set `COMMUNITY_ENV_FILE` to that path and use the same path with `--env-file` (relative paths are resolved from this directory). Configure the bot after administrator signup, then use the HTTPS deployment below when ready to publish. The local data volume and production data volume are separate; preserve and explicitly migrate the data if moving an existing installation.

## Required configuration

Use a Linux host with Docker Compose v2.24+ and systemd/cgroup v2. Copy `.env.production.example` to `.env.production` in this directory, set mode `0600`, and fill:

| Variable | Value you choose |
| --- | --- |
| `COMMUNITY_ORIGIN` | Public HTTPS origin, with no path |
| `COMMUNITY_PUBLIC_HOST` | The same domain or public IPv4, without scheme or path |
| `COMMUNITY_CADDY_FILE` | `./Caddyfile.domain` for a domain; `./Caddyfile.ip` for public IPv4 HTTPS |
| `COMMUNITY_BOOTSTRAP_TOKEN` | Random private invitation for the first administrator |
| `COMMUNITY_SHARED_DESKTOP_ROOM` | A fresh lowercase UUID identifying your shared workspace |
| `COMMUNITY_DESKTOP_HOME` | Absolute path to a dedicated persistent directory owned by UID/GID `10001:10001` |

For example, generate the UUID with `python3 -c 'import uuid; print(uuid.uuid4())'` and the invitation with `openssl rand -hex 32`; store the invitation privately. Do not use a personal home directory for desktop storage. Decide its capacity and backup policy before admitting users. No disk is bought or expanded automatically.

The `desktop` service has a `desktop-<UUID>` network alias. Compose builds the matching server-side desktop map from the same UUID, so all authorized conversations use this shared computer. Browser, native file and terminal views are separate views of that computer. The desktop runs as UID 10001 with no host administration, Docker socket or application/provider credentials.

Only ports 80 and 443 are public. App diagnostics (8787), compatibility VNC (6080), and CDP (9222) bind to host loopback. Native file/terminal transport (6083) is internal only. Keep the static `172.30.50.2` app address and dedicated bridge ranges aligned with the desktop bridge ACL and host firewall; changing only Compose networking breaks this boundary.

Before starting containers, install the `monitor/community.slice` systemd slice and the scoped desktop firewall described in [desktop/README.md](desktop/README.md). The firewall requires your host's public IPv4 in root-owned `/etc/openclaw/desktop-network.env`, even when the site uses a domain. DNS and inbound host/cloud firewall rules are operator responsibilities.

Run from this directory:

```sh
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d --no-build
```

Always pass `--env-file`: the file provides Compose interpolation as well as container environment values. Avoid printing expanded production configuration because it includes credentials. Missing required deployment values fail before container creation. A domain must resolve to the host before HTTPS issuance; the IP configuration requests a short-lived ACME certificate for the explicitly configured IP.

The first signup with the bootstrap invitation creates the administrator. Later accounts use site invitations. Keep the database, media, Caddy state, `.env.production` and any optional vault/gateway environment backed up. Settings entered through **내 봇 설정** use `COMMUNITY_DATA_DIR/setup-vault.json` and `setup-vault.key`; preserve both together. The setup screen records cloud/domain/mail metadata but does not provision cloud resources or modify DNS. Never use `down -v` as a routine upgrade command.

## Optional models and integrations

AI calls are disabled when no model credentials are configured. Neither a paid provider nor a fallback is selected by these templates. You can use the direct adapter by configuring `COMMUNITY_LLM_BASE_URL`, `COMMUNITY_LLM_API_KEY` and `COMMUNITY_LLM_MODEL`, or configure the named provider variables documented in [../.env.example](../.env.example). Leave unused variables blank. Provider quotas and costs belong to the selected account; host resource limits do not enforce a billing cap.

To enable the isolated OpenClaw gateway:

1. Copy `openclaw/.env.example` to `.env.openclaw`, mode `0600`. Choose your endpoint, API adapter, model ID/name and key. `openclaw/community.json` uses these environment references under the neutral provider name `configured`. It declares text input only; adjust model capabilities and context/output limits to your chosen provider's documented model if needed.
2. Set the same random `COMMUNITY_OPENCLAW_TOKEN` in both environment files. In `.env.production`, set `COMMUNITY_OPENCLAW_BASE_URL=http://openclaw:18890`, `COMMUNITY_OPENCLAW_AGENT_ID=community` and `COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP=1`.
3. Start with `docker compose --env-file .env.production --profile openclaw up -d --no-build`.

For official Codex subscription OAuth instead of a provider key, merge `compose.subscription.yml` after the base manifest and follow [the subscription helper guide](../scripts/README.md). Its writable configuration lives inside the dedicated Gateway state volume and is seeded once without overwriting existing configuration. Official login chooses the default entitled model. CLI authentication for Claude or Gemini does not automatically connect those accounts to this Gateway.

OpenClaw has a dedicated state volume and private network, no public gateway port, and built-in tools/browser/cron/hooks disabled. The API template disables plugins; the subscription template permits only the OpenAI provider plugin and pins its agent runtime to `openclaw`, keeping native Codex execution disabled. The application owns validated browser and service tool execution. Do not point this adapter at an unrelated personal gateway. Gateway configuration does not load when the `openclaw` profile is off, so optional AI fields are not required for an initial installation.

For external services, start from [../integrations.example.json](../integrations.example.json), save the populated vault outside the checkout, and mount it only into the application at your chosen path. Set `COMMUNITY_INTEGRATIONS_FILE` to that in-container path. A separately mounted operator context file can be selected with `COMMUNITY_AGENT_CONTEXT_FILE`; it is disabled by default. Never mount either into the desktop. Configure any cloud account, mail, calendar, Meta or other API explicitly; templates contain no account credentials.

Optional Web Push uses `COMMUNITY_PUSH_SUBJECT`, `COMMUNITY_PUSH_PUBLIC_KEY` and `COMMUNITY_PUSH_PRIVATE_KEY`. Leave all three empty to disable it. HTTPS, browser permission and an actual device delivery check are required for notifications.

## Optional installed-app origin

Leave `COMMUNITY_APP_ORIGIN` empty to install the PWA from the regular `COMMUNITY_ORIGIN`. If an existing installed app needs a separate address, set this optional value privately to an exact HTTPS origin, such as `https://app.example.com`, with no trailing slash, path, query or credentials. A public IP is also supported when it has a valid HTTPS certificate. `COMMUNITY_ORIGIN` remains required and remains the canonical web/release address.

Configure Caddy to proxy both exact hosts to the same application, with valid certificates for each; do not redirect the installed-app host to the other origin. The templates do not provision this second host automatically. Requests and authenticated desktop/terminal connections must match the origin for their actual host; configuring two hosts does not permit cross-origin API access.

The install button opens the configured app origin only when clicked. Already installed apps never automatically change origin, because that would leave their installed scope and show a browser address bar. Install again from the desired origin if changing an existing app's address. Login cookies and notification permissions are separate for each origin; users sign in and enable notifications again at the new address. Application accounts, conversations and stored credentials remain in the same server data volume.

## Host dashboard and optional provisioning

`monitor/community.slice` allows this deployment to use the host's CPU and RAM, with swap disabled and a task cap. The OS and other services still share those physical resources. This is a resource policy, not an OCI Free Tier guarantee. The collector reads host memory, CPU, physical disks and mounted filesystems, avoiding duplicate mounts; it does not query cloud billing or other instances.

Install `monitor/collect.py` as `/usr/local/lib/community-monitor/collect.py`, create `/var/lib/community-monitor`, and install/enable the provided service/timer after installing the slice. The application gets only the snapshot directory read-only. The dashboard is administrator-only. Collector scope retains the existing `a1-host` protocol identifier for compatibility; measurements come from the actual host, not fixed A1 specifications.

The shared desktop needs no dynamic provisioner. Leave `COMMUNITY_PROVISIONER_SOCKET` blank. The optional broker in `provisioner/` is host software requiring an explicit separate installation. It accepts validated room UUIDs through a restricted Unix socket, never arbitrary images or commands. Install its seccomp profile at `/etc/openclaw/seccomp-chromium.json` and build `community-desktop:managed` from `desktop/Dockerfile.managed` before enabling it. Its policy is two running dynamic desktops, four stored profiles, 512 MiB per profile, and refusal to allocate when disk space is low. These are local limits, not cloud purchases. The broker checks the whole-host slice and subnet guard before allocation. Do not enable it merely to use the shared workspace.

## Releases and existing installations

Use [the deployment automation guide](../../../scripts/deploy/README.md) for main-branch releases. Automated releases require `COMMUNITY_DESKTOP_HOME=<shared_storage_root>/home` to be a mounted, bounded filesystem; a directory-only manual installation must prepare that storage before enabling automation, preserving existing files. Server-owned metadata in `/etc/openclaw/deployment.json` supplies the private Compose path, project name and desktop service. Keep the installed manifest root-owned outside the Git checkout. For a new installation, install your reviewed manifest at `/etc/openclaw/compose.yml`; choose its service name `desktop` in the private deployment metadata.

Before upgrading an existing installation that used a site-specific tracked manifest, preserve its working Compose file, selected Caddyfile and gateway JSON outside the repository. The private manifest should mount `/etc/openclaw/Caddyfile` and `/etc/openclaw/openclaw.json`. Keep its existing desktop service name, environment files, home mount, network and volumes. Merely replacing tracked examples is not a reason to recreate or migrate production data, rotate keys, or change the public origin. Existing installed host firewall units and collector settings must be updated deliberately, not overwritten from an example during an app release.

Validate new configurations with `config --quiet`, check `/api/health` against the expected release, and verify authenticated browser, file and terminal views. Back up SQLite using its backup API before releases; retain prior images for rollback. Credentials, populated vaults and private manifests must never enter Git or a container build context.

References: [Compose variable interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/), [Caddy environment variables](https://caddyserver.com/docs/caddyfile/concepts#environment-variables), [OpenClaw custom providers](https://docs.openclaw.ai/concepts/model-providers/custom-providers).

### Mobile workspace on the existing application host

The workspace has Browser, Terminal, Files and Mobile views. Mobile shows the
actual Android screen and the same room's AI conversation; it does not imitate
an iPhone home screen. Each room maps to a separate persistent Android device.
Forks receive a new device when opened; they do not copy another room's app logins.

The optional [private Android pool](mobile/README.md) belongs on the same machine
as the application. Verify the host kernel, image, input method and capacity before
enabling it. An ARM CPU and spare RAM alone do not make a host Android-compatible:
Redroid requires Android Binder support in the host kernel. A disabled
`CONFIG_ANDROID_BINDER_IPC` is a deployment blocker; do not claim a working phone
or automatically replace the host kernel/reboot a production service.

Use `MOBILE_BROKER_SOCKET=/run/community-mobile/mobile.sock` and a private
`MOBILE_BROKER_TOKEN` in the app's private environment. Bind-mount only
`/run/community-mobile:/run/community-mobile:ro` into the application backend;
match the broker socket's group to the backend's host-visible UID. Do not mount
Docker or ADB sockets into the public app or desktop. No external phone port,
Cloudflare route, new VM or separate region is needed. The checked-in configuration
is intentionally unconnected. HTTPS is also available for an operator-selected
separate deployment, but no remote host is chosen by default.

Default pool limits are ten saved devices and two running devices, subject to
verified host capacity. Closing the workspace stops screen polling; idle devices
sleep without deleting their data. AI task leases keep their active device awake.
Opening a writable room's Mobile tab or invoking its AI mobile tools wakes only
that room's device. Read-only fork sources remain viewable but cannot wake, type
or launch applications. Existing room membership and CSRF protection apply.
