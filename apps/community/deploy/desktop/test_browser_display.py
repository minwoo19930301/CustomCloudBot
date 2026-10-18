"""Exercise the browser window rules against real Xvfb/Openbox, without Chrome data."""
import ctypes
import ctypes.util
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest


TOOLS = ("Xvfb", "openbox", "xprop", "xwininfo")


@unittest.skipUnless(all(shutil.which(tool) for tool in TOOLS), "requires Xvfb, Openbox and x11-utils")
class BrowserDisplayTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="browser-display-test-")
        self.addCleanup(self.directory.cleanup)
        self.logs = {}
        def log_file(name):
            path = Path(self.directory.name) / (name + ".log")
            self.logs[name] = path
            handle = path.open("w")
            self.addCleanup(handle.close)
            return handle
        read_fd, write_fd = os.pipe()
        self.xvfb = subprocess.Popen(
            ["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "960x640x24", "-nolisten", "tcp", "-ac"],
            pass_fds=(write_fd,), stdout=log_file("xvfb"), stderr=subprocess.STDOUT,
        )
        os.close(write_fd)
        self.addCleanup(self.stop, self.xvfb)
        try:
            self.assertTrue(select.select([read_fd], [], [], 10)[0], "Xvfb did not start")
            display_number = os.read(read_fd, 32).decode().strip()
            self.assertTrue(display_number.isdecimal())
        finally:
            os.close(read_fd)
        self.env = {**os.environ, "DISPLAY": ":" + display_number, "HOME": self.directory.name}
        ready = Path(self.directory.name) / "openbox.ready"
        self.wm = subprocess.Popen(
            ["openbox", "--config-file", str(Path(__file__).with_name("browser-openbox.xml")),
             "--startup", "touch " + shlex.quote(str(ready))],
            env=self.env, stdout=log_file("openbox"), stderr=subprocess.STDOUT,
        )
        self.addCleanup(self.stop, self.wm)
        # EWMH ownership precedes theme/font loading and event-handler setup.
        # Openbox invokes --startup only after its window management is running.
        self.wait_for(ready.is_file, description="Openbox startup callback", timeout=15)
        self.assertIn("window id #", self.xprop("-root", "_NET_SUPPORTING_WM_CHECK"))

        self.x = ctypes.CDLL(ctypes.util.find_library("X11"))
        pointer, window = ctypes.c_void_p, ctypes.c_ulong
        signatures = {
            "XOpenDisplay": ([ctypes.c_char_p], pointer),
            "XDefaultRootWindow": ([pointer], window),
            "XCreateSimpleWindow": ([pointer, window, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                     ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong], window),
            "XSetClassHint": ([pointer, window, pointer], ctypes.c_int),
            "XInternAtom": ([pointer, ctypes.c_char_p, ctypes.c_int], ctypes.c_ulong),
            "XChangeProperty": ([pointer, window, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int,
                                 ctypes.c_int, pointer, ctypes.c_int], ctypes.c_int),
            "XMapWindow": ([pointer, window], ctypes.c_int),
            "XSync": ([pointer, ctypes.c_int], ctypes.c_int),
            "XCloseDisplay": ([pointer], ctypes.c_int),
        }
        for name, (args, result) in signatures.items():
            method = getattr(self.x, name)
            method.argtypes, method.restype = args, result
        self.display = self.x.XOpenDisplay(self.env["DISPLAY"].encode())
        self.assertTrue(self.display)
        self.addCleanup(self.x.XCloseDisplay, self.display)
        self.root = self.x.XDefaultRootWindow(self.display)

    @staticmethod
    def stop(process):
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def diagnostics(self):
        details = [f"Xvfb status: {self.xvfb.poll()}; Openbox status: {self.wm.poll()}"]
        for name, path in self.logs.items():
            details.append(name + ":\n" + path.read_text(errors="replace")[-8000:])
        return "\n".join(details)

    def wait_for(self, predicate, description="expected X window state", timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.xvfb.poll() is not None or self.wm.poll() is not None:
                self.fail("Display process exited while waiting for " + description + "\n" + self.diagnostics())
            if predicate():
                return
            time.sleep(0.05)
        self.fail("Timed out waiting for " + description + "\n" + self.diagnostics())

    def xprop(self, *args):
        return subprocess.run(["xprop", *args], env=self.env, capture_output=True, text=True, timeout=2).stdout

    def window(self, window_class="Google-chrome", kind="NORMAL"):
        class ClassHint(ctypes.Structure):
            _fields_ = [("name", ctypes.c_char_p), ("klass", ctypes.c_char_p)]
        window = self.x.XCreateSimpleWindow(self.display, self.root, 40, 50, 480, 320, 0, 0, 0)
        hint = ClassHint(window_class.lower().encode(), window_class.encode())
        self.x.XSetClassHint(self.display, window, ctypes.byref(hint))
        property_atom = self.x.XInternAtom(self.display, b"_NET_WM_WINDOW_TYPE", 0)
        kind_atom = self.x.XInternAtom(self.display, ("_NET_WM_WINDOW_TYPE_" + kind).encode(), 0)
        value = (ctypes.c_ulong * 1)(kind_atom)
        self.x.XChangeProperty(self.display, window, property_atom, 4, 32, 0, value, 1)
        self.x.XMapWindow(self.display, window)
        self.x.XSync(self.display, 0)
        self.wait_for(lambda: "_OB_APP_TYPE(UTF8_STRING)" in self.xprop("-id", hex(window), "_OB_APP_TYPE"),
                      description=f"Openbox managing {window_class} {kind} window {hex(window)}")
        return window

    def geometry(self, window):
        info = subprocess.check_output(["xwininfo", "-id", hex(window)], env=self.env, text=True, timeout=2)
        fields = ("Absolute upper-left X", "Absolute upper-left Y", "Width", "Height")
        return tuple(int(re.search(re.escape(field) + r":\s*(-?\d+)", info).group(1)) for field in fields)

    def test_normal_and_later_incognito_windows_fill_browser_view(self):
        # Incognito uses the same class/type as regular Chrome; new windows must
        # receive the rule even when an earlier browser window is already open.
        for _ in range(2):
            window = self.window()
            self.wait_for(lambda: self.geometry(window) == (0, 0, 960, 640))
            state = self.xprop("-id", hex(window), "_NET_WM_STATE")
            self.assertIn("_NET_WM_STATE_MAXIMIZED_VERT", state)
            self.assertIn("_NET_WM_STATE_MAXIMIZED_HORZ", state)
            self.assertNotIn("_NET_WM_STATE_FULLSCREEN", state)

    def test_native_dialogs_and_other_apps_keep_their_size(self):
        self.window()
        for window in (self.window(kind="DIALOG"), self.window(window_class="XTerm")):
            self.wait_for(lambda: self.geometry(window)[2:] == (480, 320))
            self.assertNotIn("MAXIMIZED", self.xprop("-id", hex(window), "_NET_WM_STATE"))


if __name__ == "__main__":
    unittest.main()
