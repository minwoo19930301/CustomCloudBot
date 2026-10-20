import array
import importlib.util
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("media-runtime.py")
spec = importlib.util.spec_from_file_location("media_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeConfigTests(unittest.TestCase):
    def test_runtime_rejects_config_injection(self):
        for value in ("relative", "/tmp/x\nload-module module-native-protocol-tcp", "/tmp/../other"):
            with patch.dict(os.environ, {"DESKTOP_MEDIA_RUNTIME": value}), self.assertRaises(ValueError):
                runtime.runtime_path()

    def test_socket_and_config_are_private_and_have_no_automatic_capture(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DESKTOP_MEDIA_RUNTIME": directory + "/pulse"}):
            config = runtime.prepare_runtime()
            self.assertEqual(config.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            value = config.read_text()
            self.assertNotIn("protocol-tcp", value)
            self.assertNotIn("module-udev-detect", value)
            self.assertIn("set-source-mute cloudbot_microphone 1", value)
            self.assertNotIn("master=cloudbot_output.monitor", value)

    def test_refuses_symlinked_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, "target")
            target.mkdir()
            link = Path(directory, "pulse")
            link.symlink_to(target, target_is_directory=True)
            with patch.dict(os.environ, {"DESKTOP_MEDIA_RUNTIME": str(link)}), self.assertRaises(ValueError):
                runtime.prepare_runtime()


@unittest.skipUnless(all(shutil.which(name) for name in ("pulseaudio", "pactl", "pacat", "parec")), "PulseAudio runtime is required")
class PulseIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cloudbot-media-")
        self.addCleanup(self.directory.cleanup)
        self.environment = {**os.environ, "DESKTOP_MEDIA_RUNTIME": self.directory.name + "/pulse",
                            "PULSE_RUNTIME_PATH": self.directory.name + "/pulse",
                            "PULSE_SERVER": "unix:" + self.directory.name + "/pulse/native"}
        self.log = tempfile.TemporaryFile()
        self.addCleanup(self.log.close)
        self.process = subprocess.Popen([sys.executable, str(SCRIPT), "run"], env=self.environment, stderr=self.log)
        self.addCleanup(self.stop_daemon)
        result = subprocess.run([sys.executable, str(SCRIPT), "wait"], env=self.environment, capture_output=True, timeout=15)
        if result.returncode:
            self.log.seek(0)
            self.fail(self.log.read().decode(errors="replace") + result.stderr.decode())

    def stop_daemon(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)

    def record(self, sink):
        samples = array.array("h", (int(10000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(24000)))
        with tempfile.TemporaryFile() as capture:
            recorder = subprocess.Popen(["parec", "--raw", "--format=s16le", "--rate=48000", "--channels=1",
                                         "--latency-msec=20", "--process-time-msec=5",
                                         "--device=" + runtime.MICROPHONE], env=self.environment, stdout=capture, stderr=subprocess.DEVNULL)
            def wait_for_capture(minimum):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    size = os.fstat(capture.fileno()).st_size
                    if size >= minimum:
                        return size
                    if recorder.poll() is not None:
                        self.fail("PulseAudio recorder exited before delivering samples")
                    time.sleep(0.01)
                self.fail(f"PulseAudio capture stalled at {os.fstat(capture.fileno()).st_size} bytes; expected {minimum}")
            try:
                # A running process is not proof that its capture stream is ready.
                # Wait for delivered silence, then keep the recorder alive until
                # at least the entire tone duration has arrived at stdout.
                initial_bytes = wait_for_capture(4096)
                subprocess.run(["pacat", "--playback", "--raw", "--format=s16le", "--rate=48000", "--channels=1",
                                "--latency-msec=30", "--process-time-msec=10",
                                "--device=" + sink], input=samples.tobytes(), env=self.environment, check=True, timeout=5)
                wait_for_capture(initial_bytes + len(samples) * samples.itemsize)
            finally:
                recorder.terminate()
                recorder.wait(timeout=5)
            capture.seek(0)
            data = capture.read()
        recorded = array.array("h")
        recorded.frombytes(data[:len(data) - len(data) % 2])
        self.assertGreater(len(recorded), 5000)
        return max(abs(value) for value in recorded)

    def test_virtual_microphone_is_muted_at_start_and_receives_only_input_sink(self):
        with patch.dict(os.environ, self.environment):
            state = runtime.status()
        self.assertTrue(state["audio"]["available"])
        self.assertTrue(state["audio"]["microphoneMuted"])
        self.assertFalse(state["audio"]["microphoneConnected"])
        subprocess.run(["pactl", "set-source-mute", runtime.MICROPHONE, "0"], env=self.environment, check=True)
        self.assertLess(self.record(runtime.OUTPUT), 50, "Speaker output must not loop into the microphone")
        self.assertGreater(self.record(runtime.INPUT), 1000, "Input sink must reach the virtual microphone")
