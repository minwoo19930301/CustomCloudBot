#!/usr/bin/env python3
"""Create a private NoCloud ISO. Input is one bounded JSON object on stdin."""
import io
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SOURCE_NAMES = ('device-pool.mjs', 'service.mjs')
SOURCE_LIMIT = 256 * 1024


def approved_sources(directory, owner_uid=0):
    directory = Path(directory)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
        raise ValueError('unsafe broker source directory')
    sources = {}
    for name in SOURCE_NAMES:
        fd = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022 or info.st_nlink != 1 or not 0 < info.st_size <= SOURCE_LIMIT:
                raise ValueError('unsafe broker source')
            content = source.read(SOURCE_LIMIT + 1)
            if len(content) > SOURCE_LIMIT:
                raise ValueError('oversized broker source')
            sources[name] = content.decode('utf8')
    return sources


def seed_documents(request, sources):
    if set(request) != {"roomId", "token", "output"}:
        raise ValueError("invalid seed fields")
    room = request["roomId"]
    token = request["token"]
    if not isinstance(room, str) or not UUID.fullmatch(room) or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("invalid seed identity")
    if set(sources) != set(SOURCE_NAMES) or any(not isinstance(sources[name], str) or not 0 < len(sources[name].encode('utf8')) <= SOURCE_LIMIT for name in SOURCE_NAMES):
        raise ValueError('invalid broker sources')
    # Only the two approved source contents, in a fixed order, identify a runtime
    # version. Per-room credentials never influence or appear in this digest.
    revision = hashlib.sha256(b'\0'.join(sources[name].encode('utf8') for name in SOURCE_NAMES)).hexdigest()[:12]
    # JSON is valid YAML. No user value is interpolated into a command or YAML.
    instance_env = "\n".join([
        "MOBILE_BROKER_TOKEN=" + token, "MOBILE_LISTEN_SOCKET=",
        "MOBILE_LISTEN_HOST=10.0.2.15", "MOBILE_LISTEN_PORT=8091",
        "MOBILE_MAX_SLOTS=1", "MOBILE_MAX_RUNNING=1", "MOBILE_BOOT_SECONDS=600", "MOBILE_EXTERNAL_CONTAINERS=", "",
    ])
    data = {
        "hostname": "mobile-" + room[:8], "manage_etc_hosts": True,
        "ssh_pwauth": False, "disable_root": True, "users": [], "ssh_genkeytypes": [],
        "write_files": [
            {"path": "/etc/customcloudbot-mobile.instance.env", "owner": "root:root", "permissions": "0600", "content": instance_env},
            {"path": "/etc/systemd/system/customcloudbot-mobile.service.d/instance.conf", "owner": "root:root", "permissions": "0644",
             "content": "[Service]\nEnvironmentFile=/etc/customcloudbot-mobile.instance.env\n"},
            *[{"path": "/opt/customcloudbot-mobile/" + name, "owner": "root:root", "permissions": "0644", "content": sources[name]} for name in SOURCE_NAMES],
        ],
        "runcmd": [["systemctl", "daemon-reload"], ["systemctl", "enable", "customcloudbot-mobile.service"], ["systemctl", "restart", "customcloudbot-mobile.service"]],
    }
    return {"user-data": ("#cloud-config\n" + json.dumps(data)).encode(),
            "meta-data": json.dumps({"instance-id": "customcloudbot-mobile-" + room + "-runtime-v2-" + revision, "local-hostname": "mobile-" + room[:8]}).encode()}


def main():
    request = json.loads(sys.stdin.buffer.read(8193))
    # No source path or code can come from stdin. Only this root-installed
    # script's two fixed sibling files are eligible for guest installation.
    documents = seed_documents(request, approved_sources(Path(__file__).absolute().parent))
    output = Path(request["output"])
    if not output.is_absolute() or output.name != "seed.iso.tmp" or output.parent.name != request["roomId"] or output.parent.parent.name != "rooms":
        raise ValueError("invalid seed destination")
    if str(output.resolve()) != str(output) or output.exists() or output.is_symlink():
        raise ValueError("unsafe seed destination")
    import pycdlib
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, rock_ridge="1.09", vol_ident="cidata")
    for name, iso_name in [("user-data", "USERDATA.;1"), ("meta-data", "METADATA.;1")]:
        content = documents[name]
        iso.add_fp(io.BytesIO(content), len(content), iso_path="/" + iso_name, rr_name=name, joliet_path="/" + name)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as destination:
            iso.write_fp(destination)
    finally:
        iso.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No exception detail: third party parsing/write errors may quote input.
        print("Private mobile seed creation failed.", file=sys.stderr)
        sys.exit(1)
