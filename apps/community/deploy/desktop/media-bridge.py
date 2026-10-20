#!/usr/bin/env python3
"""Private, ephemeral microphone ingress for the shared virtual computer."""

import asyncio
import contextlib
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import time

from aiohttp import WSMsgType, web

runtime_file = Path(__file__).with_name("media-runtime.py")
if not runtime_file.exists():
    runtime_file = Path("/usr/local/bin/desktop-media")
loader = importlib.machinery.SourceFileLoader("desktop_media_runtime", str(runtime_file))
spec = importlib.util.spec_from_loader(loader.name, loader)
runtime = importlib.util.module_from_spec(spec)
loader.exec_module(runtime)

SESSION = re.compile(r"^[a-f0-9]{64}$")
MAX_FRAME = 8192
MAX_PENDING = 256 * 1024
BYTES_PER_SECOND = 48000 * 2


def allowed_peer(address):
    try:
        value = ipaddress.ip_address(address)
        if isinstance(value, ipaddress.IPv6Address) and value.ipv4_mapped:
            value = value.ipv4_mapped
        return value.is_loopback or str(value) == "172.30.50.2"
    except (ValueError, TypeError):
        return False


async def set_mute(muted):
    process = await asyncio.create_subprocess_exec(
        "pactl", "set-source-mute", runtime.MICROPHONE, "1" if muted else "0",
        env=runtime.environment(), stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL)
    try:
        if await asyncio.wait_for(process.wait(), 0.6) != 0:
            raise RuntimeError("Virtual microphone unavailable")
    except BaseException:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        raise


async def start_player():
    player = await asyncio.create_subprocess_exec(
        "pacat", "--playback", "--raw", "--format=s16le", "--rate=48000",
        "--channels=1", "--channel-map=mono", "--latency-msec=60",
        "--device=" + runtime.INPUT, "--client-name=CustomCloudBot_Microphone",
        env=runtime.environment(), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    try:
        await wait_player_ready(player)
        return player
    except BaseException:
        if player.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                player.kill()
        await player.wait()
        if player.stdin:
            player.stdin.close()
        raise


async def wait_player_ready(player, timeout=0.8):
    """Spawn is not readiness: require this process's actual PulseAudio stream."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if player.returncode is not None:
            raise RuntimeError("Microphone player exited before connecting")
        query = await asyncio.create_subprocess_exec(
            "pactl", "--format=json", "list", "sink-inputs", env=runtime.environment(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            output, _ = await asyncio.wait_for(query.communicate(), min(0.4, max(0.01, deadline - time.monotonic())))
            if query.returncode == 0:
                streams = json.loads(output)
                if player.returncode is None and any(
                    str(stream.get("properties", {}).get("application.process.id")) == str(player.pid)
                    for stream in streams):
                    return
        except (TimeoutError, ValueError, TypeError):
            pass
        finally:
            if query.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    query.kill()
            await query.wait()
        await asyncio.sleep(0.03)
    raise RuntimeError("Microphone player did not connect to PulseAudio")


def create_app(status_reader=runtime.status, player_factory=start_player,
               mute=set_mute, receive_timeout=8):
    active = None
    sessions = set()
    cleanup_tasks = set()
    status_lock = asyncio.Lock()
    cached_status, cached_at = None, 0

    async def read_status():
        nonlocal cached_status, cached_at
        async with status_lock:
            if cached_status is None or time.monotonic() - cached_at >= 0.25:
                cached_status = await asyncio.to_thread(status_reader)
                cached_at = time.monotonic()
            return cached_status

    @web.middleware
    async def private_network(request, handler):
        peer = request.transport.get_extra_info("peername") if request.transport else None
        if not peer or not allowed_peer(peer[0]) or request.headers.get("Origin"):
            raise web.HTTPForbidden(text="Media bridge is private")
        response = await handler(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def status(_request):
        state = await read_status()
        return web.json_response({
            "ok": True,
            "microphone": {"supported": True, "available": bool(state["audio"]["available"]),
                           "connected": active is not None, "muted": bool(state["audio"]["microphoneMuted"])},
            "camera": {"supported": False, "available": False, "reason": "host-device-required"},
            "audioOutput": {"supported": False},
        })

    async def microphone(request):
        nonlocal active, cached_at
        if set(request.query) != {"session"} or not SESSION.fullmatch(request.query.get("session", "")):
            raise web.HTTPBadRequest(text="Invalid microphone session")
        ws = web.WebSocketResponse(heartbeat=15, receive_timeout=receive_timeout,
                                   max_msg_size=MAX_FRAME, compress=False)
        if not ws.can_prepare(request).ok:
            raise web.HTTPBadRequest(text="WebSocket upgrade required")
        if active is not None:
            raise web.HTTPConflict(text="Microphone is already in use")
        # Reserve before the first await: competing upgrades cannot share the mic.
        reservation = object()
        active = reservation
        player = None
        sessions.add(ws)
        try:
            state = await read_status()
            if not state["audio"]["available"]:
                raise web.HTTPServiceUnavailable(text="Virtual microphone unavailable")
            player = await player_factory()
            if player.returncode is not None:
                raise RuntimeError("Microphone player exited before connecting")
            await mute(False)
            cached_at = 0
            await ws.prepare(request)
            await ws.send_json({"type": "ready", "format": "s16le", "sampleRate": 48000, "channels": 1})
            tokens, previous = BYTES_PER_SECOND * 2, time.monotonic()
            async for message in ws:
                if message.type != WSMsgType.BINARY:
                    if message.type == WSMsgType.TEXT:
                        await ws.close(code=1003, message=b"PCM binary frames required")
                    break
                frame = message.data
                now = time.monotonic()
                tokens = min(BYTES_PER_SECOND * 2, tokens + (now - previous) * BYTES_PER_SECOND)
                previous = now
                if not frame or len(frame) % 2 or len(frame) > MAX_FRAME or len(frame) > tokens:
                    await ws.close(code=1008, message=b"Invalid or excessive PCM input")
                    break
                tokens -= len(frame)
                if player.returncode is not None or player.stdin.transport.get_write_buffer_size() > MAX_PENDING:
                    await ws.close(code=1011, message=b"Microphone input stopped")
                    break
                player.stdin.write(frame)
                await asyncio.wait_for(player.stdin.drain(), timeout=1)
        except (TimeoutError, BrokenPipeError, ConnectionError, RuntimeError, OSError):
            if ws.prepared:
                await ws.close(code=1011, message=b"Microphone disconnected")
            else:
                raise web.HTTPServiceUnavailable(text="Virtual microphone unavailable")
        finally:
            # Stop the producer before any await. A client disconnect can cancel
            # this request while pactl is pending; it must never leave pacat alive.
            if player is not None:
                if player.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        player.kill()
                if player.stdin:
                    # close() may flush buffered PCM; abort discards it now.
                    player.stdin.transport.abort()

            async def finish_cleanup():
                nonlocal active, cached_at
                try:
                    with contextlib.suppress(Exception):
                        await mute(True)
                    if player is not None:
                        await player.wait()
                finally:
                    sessions.discard(ws)
                    if active is reservation:
                        active = None
                    cached_at = 0

            # Keep a strong reference and shield cleanup from HTTP handler
            # cancellation. The reservation remains held until cleanup completes.
            cleanup = asyncio.create_task(finish_cleanup())
            cleanup_tasks.add(cleanup)
            cleanup.add_done_callback(cleanup_tasks.discard)
            await asyncio.shield(cleanup)
        return ws

    async def shutdown(_app):
        await asyncio.gather(*(ws.close(code=1001, message=b"Media bridge stopping") for ws in tuple(sessions)))

    async def reap(_app):
        if cleanup_tasks:
            await asyncio.gather(*tuple(cleanup_tasks), return_exceptions=True)

    app = web.Application(middlewares=[private_network], client_max_size=MAX_FRAME)
    app.on_shutdown.append(shutdown)
    app.on_cleanup.append(reap)
    app.router.add_get("/health", status)
    app.router.add_get("/status", status)
    app.router.add_get("/microphone", microphone)
    return app


if __name__ == "__main__":
    if os.geteuid() == 0:
        raise SystemExit("Media bridge must run as the desktop user")
    web.run_app(create_app(), host="0.0.0.0", port=6084, access_log=None, print=None)
