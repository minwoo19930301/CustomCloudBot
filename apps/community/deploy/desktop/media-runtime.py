#!/usr/bin/env python3
"""Local, non-root virtual audio devices; no remote capture or network listener."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

OUTPUT = "cloudbot_output"
INPUT = "cloudbot_mic_input"
MICROPHONE = "cloudbot_microphone"


def runtime_path():
    value = os.environ.get("DESKTOP_MEDIA_RUNTIME", "/run/desktop/pulse")
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or ".." in Path(value).parts:
        raise ValueError("Invalid desktop media runtime directory")
    return Path(value)


def environment():
    runtime = runtime_path()
    return {**os.environ, "PULSE_RUNTIME_PATH": str(runtime),
            "PULSE_SERVER": "unix:" + str(runtime / "native")}


def pulse_config(runtime):
    return f""".fail
load-module module-native-protocol-unix socket={runtime}/native auth-anonymous=0
load-module module-null-sink sink_name={OUTPUT} rate=48000 channels=2 sink_properties=device.description=CustomCloudBot_Speakers
load-module module-null-sink sink_name={INPUT} rate=48000 channels=1 channel_map=mono sink_properties=device.description=CustomCloudBot_Microphone_Input
load-module module-remap-source master={INPUT}.monitor source_name={MICROPHONE} channels=1 channel_map=mono source_properties=device.description=CustomCloudBot_Microphone
set-default-sink {OUTPUT}
set-default-source {MICROPHONE}
set-source-mute {MICROPHONE} 1
"""


def prepare_runtime():
    runtime = runtime_path()
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = runtime.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Desktop media runtime must be an owned directory")
    runtime.chmod(0o700)
    config = runtime / "default.pa"
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW
    fd = os.open(config, flags, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(pulse_config(runtime))
    return config


def pactl(*arguments):
    result = subprocess.run(["pactl", *arguments], env=environment(),
                            capture_output=True, text=True, timeout=0.6, check=True)
    return json.loads(result.stdout)


def status():
    cameras = []
    for path in sorted(Path("/dev").glob("video[0-9]*")):
        try:
            if stat.S_ISCHR(path.stat().st_mode) and os.access(path, os.R_OK | os.W_OK):
                cameras.append(str(path))
        except OSError:
            pass
    result = {"audio": {"available": False, "output": OUTPUT,
                         "microphone": MICROPHONE, "microphoneConnected": False,
                         "microphoneMuted": True, "remoteStreaming": False},
              "camera": {"available": bool(cameras), "devices": cameras,
                         "remoteStreaming": False}}
    try:
        # One bounded parallel snapshot, not three serial multi-second timeouts.
        with ThreadPoolExecutor(max_workers=3) as pool:
            snapshots = [pool.submit(pactl, "--format=json", "list", kind)
                         for kind in ("sinks", "sources", "sink-inputs")]
            sinks, sources, inputs = (item.result() for item in snapshots)
        speaker = next((s for s in sinks if s["name"] == OUTPUT), None)
        injection = next((s for s in sinks if s["name"] == INPUT), None)
        microphone = next((s for s in sources if s["name"] == MICROPHONE), None)
        available = all((speaker, injection, microphone))
        result["audio"]["available"] = available
        if available:
            result["audio"]["microphoneMuted"] = bool(microphone["mute"])
            result["audio"]["microphoneConnected"] = (
                not microphone["mute"] and
                any(s.get("sink") == injection["index"] and not s.get("corked", False) for s in inputs))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "wait", "status"))
    args = parser.parse_args()
    if args.command == "run":
        config = prepare_runtime()
        os.execvpe("pulseaudio", ["pulseaudio", "--daemonize=no", "--use-pid-file=no",
                   "--exit-idle-time=-1", "--disallow-exit=yes", "--log-target=stderr",
                   "-n", "--file=" + str(config)], environment())
    if args.command == "wait":
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if status()["audio"]["available"]:
                return 0
            time.sleep(0.1)
        print("Virtual audio devices did not become ready", file=sys.stderr)
        return 1
    print(json.dumps(status(), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
