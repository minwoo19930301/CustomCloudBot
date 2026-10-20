#!/usr/bin/env python3
"""Internal, non-root files/PTY bridge for the existing shared desktop container."""

import asyncio
import codecs
import contextlib
import fcntl
import ipaddress
import json
import os
import pty
import re
import signal
import stat
import struct
import sys
import termios
import time
from pathlib import Path
from urllib.parse import quote

from aiohttp import WSMsgType, web

MAX_FILE = 8 * 1024 * 1024
MAX_ENTRIES = 1000
MAX_INPUT = 16 * 1024
MAX_REPLAY = 64 * 1024
MAX_PENDING = 128 * 1024
SESSION_ID = re.compile(r"^[a-f0-9]{64}$")
MAX_INPUT_REGIONS = 256
MAX_ACCESSIBLE_NODES = 3500


def browser_on_main_display(pid):
    """Limit the native tree to Chrome on the browser's X display, never terminals."""
    try:
        pid = int(pid)
        if pid <= 0 or Path(os.readlink(f"/proc/{pid}/exe")).name not in ("chrome", "google-chrome", "chromium"):
            return False
        with open(f"/proc/{pid}/environ", "rb") as source:
            values = source.read(65536).split(b"\0")
        if b"DISPLAY=:99" in values or b"DISPLAY=:99.0" in values:
            return True
        # Chrome clears its initial environment on Linux. Its explicit display
        # argument remains readable and still restricts us to the browser view.
        with open(f"/proc/{pid}/cmdline", "rb") as source:
            arguments = source.read(65536).split(b"\0")
        if b"--display=:99" in arguments or b"--display=:99.0" in arguments:
            return True
        # Chrome's process-title rewrite can also flatten argv into one string.
        # The entrypoint puts --display first; match that exact prefix only.
        return bool(re.match(rb"^\S+/chrome --display=:99(?:\.0)?(?: |$)", arguments[0]))
    except (ValueError, TypeError, OSError):
        return False


def empty_input_regions(available=False):
    return {"available": available, "regions": [], "observedAt": int(time.time() * 1000), "truncated": False}


def collect_input_regions(desktop, atspi, browser_process=browser_on_main_display, budget=0.25):
    """Read geometry and states only; never request accessible text, names or values."""
    result = empty_input_regions(True)
    deadline = time.monotonic() + budget
    stack, seen, rectangles = [], set(), set()
    # ACTIVE filters out covered/background Chrome windows and native dialogs.
    for index in range(min(desktop.childCount, 64)):
        if time.monotonic() >= deadline:
            result["truncated"] = True
            return result
        try:
            app = desktop[index]
            if not browser_process(app.get_process_id()):
                continue
            # Keep libatspi's normal cache: disabling it stalls Chrome's native
            # childCount query on Bookworm. The worker drains events and clears
            # cached objects before each snapshot to refresh state and geometry.
            for position in range(min(app.childCount, 64)):
                window = app[position]
                state = window.getState()
                if all(state.contains(value) for value in (atspi.STATE_ACTIVE, atspi.STATE_VISIBLE, atspi.STATE_SHOWING)):
                    stack.append(window)
        except Exception:
            continue
    while stack:
        if len(seen) >= MAX_ACCESSIBLE_NODES or len(result["regions"]) >= MAX_INPUT_REGIONS or time.monotonic() >= deadline:
            result["truncated"] = True
            break
        node = stack.pop()
        try:
            if node in seen:
                continue
            seen.add(node)
            state = node.getState()
            if state.contains(atspi.STATE_DEFUNCT):
                continue
            visible = all(state.contains(value) for value in (atspi.STATE_VISIBLE, atspi.STATE_SHOWING))
            if visible and state.contains(atspi.STATE_EDITABLE) and state.contains(atspi.STATE_ENABLED) and not state.contains(atspi.STATE_READ_ONLY):
                bounds = node.queryComponent().getExtents(atspi.DESKTOP_COORDS)
                x, y, width, height = (int(bounds.x), int(bounds.y), int(bounds.width), int(bounds.height))
                width, height = min(x + width, 32768) - max(x, 0), min(y + height, 32768) - max(y, 0)
                x, y = max(x, 0), max(y, 0)
                if width > 0 and height > 0 and -32768 < x < 32768 and -32768 < y < 32768 and width <= 32768 and height <= 32768:
                    rectangle = (x, y, width, height)
                    if rectangle not in rectangles:
                        rectangles.add(rectangle)
                        result["regions"].append({"x": x, "y": y, "width": width, "height": height, "inputMode": "text"})
                # The editable's text descendants add no independently editable area.
                continue
            remaining = MAX_ACCESSIBLE_NODES - len(seen) - len(stack)
            child_count = node.childCount
            children = min(child_count, max(remaining, 0))
            if children < child_count:
                result["truncated"] = True
            for index in range(children - 1, -1, -1):
                child = node[index]
                if child is not None:
                    stack.append(child)
        except Exception:
            # Defunct frame/navigation and unsupported Component interfaces are normal.
            continue
    return result


def input_regions_worker():
    """Isolate native DBus calls: a wedged application cannot block files or PTYs."""
    try:
        import pyatspi
        from gi.repository import GLib
        pyatspi.setTimeout(100, 200)
        context = GLib.MainContext.default()
    except (ImportError, ValueError, AttributeError):
        pyatspi = None
    for line in sys.stdin:
        if line != "regions\n":
            break
        result = empty_input_regions()
        if pyatspi is not None:
            try:
                # Drain native cache updates without running another event loop forever.
                for _ in range(128):
                    if not context.pending():
                        break
                    context.iteration(False)
                desktop = pyatspi.Registry.getDesktop(0)
                desktop.clearCache()
                result = collect_input_regions(desktop, pyatspi)
            except Exception:
                pass
        print(json.dumps(result, separators=(",", ":")), flush=True)


class BrowserInputRegions:
    """One bounded native reader and short shared cache for every viewing session."""

    def __init__(self, timeout=1.2, cache_seconds=0.2):
        self.timeout, self.cache_seconds = timeout, cache_seconds
        self.process = None
        self.lock = asyncio.Lock()
        self.cached, self.cached_at = empty_input_regions(), 0
        self.closed = False

    async def stop_worker(self):
        process, self.process = self.process, None
        if process is not None:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
            await process.wait()

    async def read(self):
        if self.process is None or self.process.returncode is not None:
            await self.stop_worker()
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, str(Path(__file__).resolve()), "--input-regions-worker",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=65536,
                env={**os.environ, "DISPLAY": ":99"})
        self.process.stdin.write(b"regions\n")
        await self.process.stdin.drain()
        line = await self.process.stdout.readline()
        if not line:
            raise ValueError("Accessibility reader stopped")
        return json.loads(line)

    async def get(self):
        if self.closed:
            return empty_input_regions()
        async with self.lock:
            if self.closed:
                return empty_input_regions()
            if time.monotonic() - self.cached_at < self.cache_seconds:
                return self.cached
            try:
                result = await asyncio.wait_for(self.read(), timeout=self.timeout)
                if not isinstance(result, dict) or not isinstance(result.get("regions"), list) or len(result["regions"]) > MAX_INPUT_REGIONS:
                    raise ValueError("Invalid accessibility response")
                self.cached = result
            except (TimeoutError, OSError, ValueError):
                await self.stop_worker()
                # Never keep old positions after a failed or timed-out refresh.
                self.cached = empty_input_regions()
            self.cached_at = time.monotonic()
            return self.cached

    async def close(self):
        self.closed = True
        async with self.lock:
            await self.stop_worker()


class HomeFiles:
    """Walk relative names with directory FDs, never following symlinks."""

    def __init__(self, home):
        self.home = Path(home).absolute()
        self.fd = os.open(self.home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def close(self):
        os.close(self.fd)

    @staticmethod
    def parts(value):
        if not isinstance(value, str) or len(value) > 4096 or value.startswith("/") or "\\" in value or "\0" in value:
            raise web.HTTPBadRequest(text="Invalid workspace path")
        pieces = value.split("/")
        if ".." in pieces or len(pieces) > 64:
            raise web.HTTPBadRequest(text="Invalid workspace path")
        return [piece for piece in pieces if piece not in ("", ".")]

    def open(self, value, directory=False):
        parts = self.parts(value)
        fd = os.dup(self.fd)
        try:
            for index, piece in enumerate(parts):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if index < len(parts) - 1 or directory:
                    flags |= os.O_DIRECTORY
                next_fd = os.open(piece, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.fstat(fd)
            if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
                raise web.HTTPNotFound(text="Workspace item not found")
            return fd, "/".join(parts)
        except BaseException:
            os.close(fd)
            raise

    def list(self, value):
        try:
            fd, path = self.open(value, directory=True)
            try:
                entries = []
                truncated = False
                with os.scandir(fd) as items:
                    for index, item in enumerate(items):
                        if index >= MAX_ENTRIES:
                            truncated = True
                            break
                        try:
                            info = os.stat(item.name, dir_fd=fd, follow_symlinks=False)
                        except OSError:
                            continue
                        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                            continue
                        entries.append({
                            "name": item.name,
                            "path": (path + "/" if path else "") + item.name,
                            "type": "directory" if stat.S_ISDIR(info.st_mode) else "file",
                            "size": info.st_size if stat.S_ISREG(info.st_mode) else 0,
                            "modified": int(info.st_mtime * 1000),
                        })
                entries.sort(key=lambda item: (item["type"] != "directory", item["name"].casefold()))
                return {"path": path, "entries": entries, "truncated": truncated}
            finally:
                os.close(fd)
        except OSError:
            raise web.HTTPNotFound(text="Workspace directory not found") from None

    def read(self, value):
        try:
            fd, path = self.open(value)
            try:
                if os.fstat(fd).st_size > MAX_FILE:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE, actual_size=MAX_FILE + 1)
                with os.fdopen(fd, "rb", closefd=False) as source:
                    body = source.read(MAX_FILE + 1)
                if len(body) > MAX_FILE:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE, actual_size=len(body))
                return body, path.rsplit("/", 1)[-1]
            finally:
                os.close(fd)
        except OSError:
            raise web.HTTPNotFound(text="Workspace file not found") from None


class TerminalClient:
    def __init__(self, terminal, ws):
        self.terminal = terminal
        self.ws = ws
        self.queue = asyncio.Queue(maxsize=32)
        self.pending = 0
        self.closed = False
        self.closer = None
        self.task = asyncio.create_task(self.send())

    def stop(self):
        self.closed = True
        self.terminal.clients.discard(self)
        self.terminal.last_activity = time.monotonic()
        if self.closer is None:
            self.closer = asyncio.create_task(self.close_socket())
        if self.task is not asyncio.current_task():
            self.task.cancel()
        return self.closer

    async def close_socket(self):
        with contextlib.suppress(asyncio.TimeoutError, ConnectionError, RuntimeError):
            await asyncio.wait_for(self.ws.close(), timeout=2)

    def offer(self, event):
        if self.closed:
            return
        size = len(json.dumps(event, ensure_ascii=False).encode("utf-8"))
        if self.queue.full() or self.pending + size > MAX_PENDING:
            self.stop()
            return
        self.pending += size
        self.queue.put_nowait((event, size))

    async def send(self):
        try:
            while True:
                event, size = await self.queue.get()
                self.pending -= size
                await asyncio.wait_for(self.ws.send_json(event), timeout=5)
                if event["type"] == "exit":
                    break
        except (asyncio.CancelledError, asyncio.TimeoutError, ConnectionError, RuntimeError):
            pass
        finally:
            await self.stop()


class Terminal:
    def __init__(self, home):
        self.loop = asyncio.get_running_loop()
        self.clients = set()
        self.replay = ""
        self.input = bytearray()
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.last_activity = time.monotonic()
        self.code = None
        self.eof = False
        self.fd = -1
        self.environment = {
            "HOME": str(home), "USER": "desktop", "LOGNAME": "desktop", "SHELL": "/bin/bash",
            "PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "C.UTF-8",
            "DISPLAY": ":99", "HISTFILE": "/dev/null", "PS1": "\\u@oci:\\w\\$ ",
            "PULSE_SERVER": "unix:/run/desktop/pulse/native", "PULSE_RUNTIME_PATH": "/run/desktop/pulse",
        }
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(home)
                os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], self.environment)
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd
        os.set_inheritable(fd, False)
        os.set_blocking(fd, False)
        self.resize(100, 30)
        self.loop.add_reader(fd, self.read)
        self.watcher = asyncio.create_task(self.watch())

    def emit(self, data):
        if not data:
            return
        self.last_activity = time.monotonic()
        self.replay = (self.replay + data).encode("utf-8")[-MAX_REPLAY:].decode("utf-8", "ignore")
        for client in tuple(self.clients):
            client.offer({"type": "output", "data": data})

    def read(self):
        if self.fd < 0 or self.eof:
            return
        for _ in range(4):
            try:
                data = os.read(self.fd, 16384)
            except BlockingIOError:
                return
            except OSError:
                data = b""
            if not data:
                self.eof = True
                self.loop.remove_reader(self.fd)
                self.emit(self.decoder.decode(b"", final=True))
                return
            self.emit(self.decoder.decode(data))

    def write(self):
        if self.fd < 0:
            return
        try:
            if self.input:
                sent = os.write(self.fd, self.input)
                del self.input[:sent]
        except BlockingIOError:
            return
        except OSError:
            self.input.clear()
        if not self.input:
            self.loop.remove_writer(self.fd)

    def feed(self, data):
        if not isinstance(data, str):
            raise ValueError("Invalid terminal input")
        encoded = data.encode("utf-8")
        if len(encoded) > MAX_INPUT or len(self.input) + len(encoded) > MAX_REPLAY or self.fd < 0 or self.code is not None:
            raise ValueError("Terminal input limit exceeded")
        self.last_activity = time.monotonic()
        self.input.extend(encoded)
        self.loop.add_writer(self.fd, self.write)

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not 2 <= cols <= 400 or not 2 <= rows <= 200:
            raise ValueError("Invalid terminal dimensions")
        if self.fd >= 0:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.last_activity = time.monotonic()

    def attach(self, ws):
        if len(self.clients) >= 4:
            raise web.HTTPTooManyRequests(text="Too many terminal viewers")
        self.last_activity = time.monotonic()
        client = TerminalClient(self, ws)
        self.clients.add(client)
        client.offer({"type": "ready"})
        if self.replay:
            client.offer({"type": "output", "data": self.replay})
        if self.code is not None:
            client.offer({"type": "exit", "code": self.code})
        return client

    async def watch(self):
        while True:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.read()
                self.code = os.waitstatus_to_exitcode(status)
                self.close_fd()
                for client in tuple(self.clients):
                    client.offer({"type": "exit", "code": self.code})
                return
            await asyncio.sleep(0.05)

    def close_fd(self):
        if self.fd >= 0:
            self.loop.remove_reader(self.fd)
            self.loop.remove_writer(self.fd)
            os.close(self.fd)
            self.fd = -1

    async def close(self):
        if self.code is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.pid, signal.SIGHUP)
            self.close_fd()
            try:
                await asyncio.wait_for(asyncio.shield(self.watcher), timeout=1)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(self.pid, signal.SIGKILL)
                await self.watcher
        clients = tuple(self.clients)
        await asyncio.gather(*(client.stop() for client in clients), return_exceptions=True)
        await asyncio.gather(*(client.task for client in clients), return_exceptions=True)


class Terminals:
    def __init__(self, home, max_sessions=12, idle_seconds=600):
        self.home = home
        self.max_sessions = max_sessions
        self.idle_seconds = idle_seconds
        self.sessions = {}

    def get(self, session):
        if not isinstance(session, str) or not SESSION_ID.fullmatch(session):
            raise web.HTTPBadRequest(text="Invalid terminal session")
        for key, terminal in tuple(self.sessions.items()):
            if terminal.code is not None:
                self.sessions.pop(key, None)
        if session not in self.sessions:
            if len(self.sessions) >= self.max_sessions:
                raise web.HTTPTooManyRequests(text="Terminal session limit reached")
            self.sessions[session] = Terminal(self.home)
        return self.sessions[session]

    async def reap(self, now=None):
        now = time.monotonic() if now is None else now
        for key, terminal in tuple(self.sessions.items()):
            if now - terminal.last_activity >= self.idle_seconds:
                self.sessions.pop(key, None)
                await terminal.close()

    async def close(self):
        sessions, self.sessions = tuple(self.sessions.values()), {}
        await asyncio.gather(*(session.close() for session in sessions))


def allowed_peer(address):
    try:
        value = ipaddress.ip_address(address)
        if isinstance(value, ipaddress.IPv6Address) and value.ipv4_mapped:
            value = value.ipv4_mapped
        return value.is_loopback or str(value) == "172.30.50.2"
    except (ValueError, TypeError):
        return False


def create_app(home="/home/desktop", idle_seconds=600, max_sessions=12, input_regions=None):
    files = HomeFiles(home)
    terminals = Terminals(files.home, max_sessions=max_sessions, idle_seconds=idle_seconds)
    browser_inputs = input_regions if input_regions is not None else BrowserInputRegions()

    @web.middleware
    async def private_network(request, handler):
        peer = request.transport.get_extra_info("peername") if request.transport else None
        # Browser pages in the desktop must not open the internal, ticket-free API.
        if not peer or not allowed_peer(peer[0]) or request.headers.get("Origin"):
            raise web.HTTPForbidden(text="Workspace bridge is private")
        response = await handler(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def health(_request):
        return web.json_response({"ok": True, "terminal": True, "files": True})

    async def listing(request):
        return web.json_response(files.list(request.query.get("path", "")))

    async def browser_input_regions(_request):
        return web.json_response(await browser_inputs.get())

    async def download(request):
        body, name = files.read(request.query.get("path", ""))
        return web.Response(body=body, content_type="application/octet-stream", headers={
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe=""),
        })

    async def terminal(request):
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=MAX_INPUT * 6 + 1024, compress=False)
        if not ws.can_prepare(request).ok:
            raise web.HTTPBadRequest(text="WebSocket upgrade required")
        session = terminals.get(request.query.get("session", ""))
        if len(session.clients) >= 4:
            raise web.HTTPTooManyRequests(text="Too many terminal viewers")
        await ws.prepare(request)
        client = session.attach(ws)
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    if message.type == WSMsgType.BINARY:
                        await ws.close(code=1008, message=b"JSON text messages required")
                    break
                try:
                    value = json.loads(message.data)
                    if not isinstance(value, dict):
                        raise ValueError("Invalid terminal message")
                    if value.get("type") == "input":
                        session.feed(value.get("data"))
                    elif value.get("type") == "resize":
                        session.resize(value.get("cols"), value.get("rows"))
                    else:
                        raise ValueError("Unknown terminal message")
                except (ValueError, UnicodeError, OSError):
                    await ws.close(code=1008, message=b"Invalid terminal message")
                    break
        finally:
            await client.stop()
            await asyncio.gather(client.task, return_exceptions=True)
        return ws

    async def lifecycle(_app):
        async def cleanup_loop():
            while True:
                await asyncio.sleep(30)
                await terminals.reap()
        cleaner = asyncio.create_task(cleanup_loop())
        yield
        cleaner.cancel()
        await asyncio.gather(cleaner, return_exceptions=True)
        await terminals.close()
        await browser_inputs.close()
        files.close()

    app = web.Application(middlewares=[private_network], client_max_size=MAX_INPUT * 6 + 1024)
    app.cleanup_ctx.append(lifecycle)
    app.router.add_get("/health", health)
    app.router.add_get("/files", listing)
    app.router.add_get("/file", download)
    app.router.add_get("/terminal", terminal)
    app.router.add_get("/browser/input-regions", browser_input_regions)
    return app


if __name__ == "__main__":
    if os.geteuid() == 0:
        raise SystemExit("Workspace bridge must run as the desktop user")
    if sys.argv[1:] == ["--input-regions-worker"]:
        input_regions_worker()
    else:
        web.run_app(create_app(), host="0.0.0.0", port=6083, access_log=None, print=None)
