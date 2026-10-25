#!/usr/bin/env python3
"""Create a private NoCloud ISO. Input is one bounded JSON object on stdin."""
import io
import json
import os
from pathlib import Path
import re
import sys

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def seed_documents(request):
    if set(request) != {"roomId", "token", "output"}:
        raise ValueError("invalid seed fields")
    room = request["roomId"]
    token = request["token"]
    if not isinstance(room, str) or not UUID.fullmatch(room) or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("invalid seed identity")
    # JSON is valid YAML. No user value is interpolated into a command or YAML.
    instance_env = "\n".join([
        "MOBILE_BROKER_TOKEN=" + token, "MOBILE_LISTEN_SOCKET=",
        "MOBILE_LISTEN_HOST=10.0.2.15", "MOBILE_LISTEN_PORT=8091",
        "MOBILE_MAX_SLOTS=1", "MOBILE_MAX_RUNNING=1", "MOBILE_EXTERNAL_CONTAINERS=", "",
    ])
    data = {
        "hostname": "mobile-" + room[:8], "manage_etc_hosts": True,
        "ssh_pwauth": False, "disable_root": True, "users": [],
        "write_files": [
            {"path": "/etc/customcloudbot-mobile.instance.env", "owner": "root:root", "permissions": "0600", "content": instance_env},
            {"path": "/etc/systemd/system/customcloudbot-mobile.service.d/instance.conf", "owner": "root:root", "permissions": "0644",
             "content": "[Service]\nEnvironmentFile=/etc/customcloudbot-mobile.instance.env\n"},
        ],
        "runcmd": [["systemctl", "daemon-reload"], ["systemctl", "enable", "customcloudbot-mobile.service"], ["systemctl", "restart", "customcloudbot-mobile.service"]],
    }
    return {"user-data": ("#cloud-config\n" + json.dumps(data)).encode(),
            "meta-data": json.dumps({"instance-id": "customcloudbot-mobile-" + room, "local-hostname": "mobile-" + room[:8]}).encode()}


def main():
    request = json.loads(sys.stdin.buffer.read(8193))
    documents = seed_documents(request)
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
