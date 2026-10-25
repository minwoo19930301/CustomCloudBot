#!/usr/bin/env python3
"""Fixed systemd VM entry point; never accepts a command, port or token in argv."""
import json
import os
from pathlib import Path
import re
import stat
import sys

BASE = Path("/var/lib/customcloudbot-mobile-vm")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def regular(path, owner):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or info.st_mode & 0o022:
        raise ValueError("unsafe VM file")


def launch_args(room, base=BASE, uid=None):
    uid = os.getuid() if uid is None else uid
    if not UUID.fullmatch(room) or uid == 0:
        raise ValueError("invalid VM identity")
    directory = base / "rooms" / room
    for parent in [base, base / "base", base / "rooms", directory]:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("unsafe VM directory")
    runtime_file = directory / "runtime.json"
    regular(runtime_file, 0)
    if runtime_file.stat().st_size > 1024:
        raise ValueError("invalid VM metadata")
    spec = json.loads(runtime_file.read_text())
    if set(spec) != {"version", "roomId", "slot", "port"} or spec["version"] != 1 or spec["roomId"] != room or type(spec["slot"]) is not int or not 0 <= spec["slot"] < 100 or spec["port"] != 18091 + spec["slot"]:
        raise ValueError("invalid VM metadata")
    for name in ["golden.qcow2", "Image", "initrd"]:
        regular(base / "base" / name, 0)
    regular(directory / "seed.iso", 0)
    regular(directory / "disk.qcow2", uid)
    return ["/usr/libexec/qemu-kvm", "-machine", "virt", "-accel", "tcg,thread=multi", "-cpu", "max", "-smp", "2", "-m", "4096",
            "-kernel", str(base / "base/Image"), "-initrd", str(base / "base/initrd"),
            "-append", "root=LABEL=cloudimg-rootfs rw console=ttyAMA0",
            "-drive", "file=" + str(directory / "disk.qcow2") + ",format=qcow2,if=virtio",
            "-drive", "file=" + str(directory / "seed.iso") + ",format=raw,if=virtio,readonly=on",
            "-netdev", "user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:" + str(spec["port"]) + "-:8091",
            "-device", "virtio-net-pci,netdev=net0",
            "-object", "rng-random,filename=/dev/urandom,id=rng0", "-device", "virtio-rng-pci,rng=rng0,max-bytes=1024,period=1000",
            "-display", "none", "-chardev", "ringbuf,id=bootlog,size=131072", "-serial", "chardev:bootlog", "-monitor", "none",
            "-qmp", "unix:/run/customcloudbot-mobile-vm/" + room + "/qmp.sock,server=on,wait=off", "-nodefaults", "-no-reboot"]


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("invalid arguments")
        args = launch_args(sys.argv[1])
        os.execv(args[0], args)
    except Exception:
        print("Private mobile VM launch failed.", file=sys.stderr)
        sys.exit(1)
