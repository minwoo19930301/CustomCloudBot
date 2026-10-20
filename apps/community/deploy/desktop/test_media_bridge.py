import asyncio
import array
import importlib.util
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import WSServerHandshakeError, WSMsgType
from aiohttp.test_utils import TestClient, TestServer

spec = importlib.util.spec_from_file_location("media_bridge", Path(__file__).with_name("media-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Player:
    def __init__(self):
        self.returncode = None
        self.frames = []
        self.closed = False
        self.stdin = SimpleNamespace(write=self.frames.append, drain=self.drain,
                                     close=lambda: setattr(self, "closed", True),
                                     transport=SimpleNamespace(get_write_buffer_size=lambda: 0))

    async def drain(self):
        pass

    def kill(self):
        self.returncode = -9

    async def wait(self):
        return self.returncode


class MediaBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.players, self.mutes = [], []
        self.available = True

        def status():
            return {"audio": {"available": self.available, "microphoneMuted": not self.mutes or self.mutes[-1]}}

        async def player():
            item = Player()
            self.players.append(item)
            return item

        async def mute(value):
            self.mutes.append(value)

        self.client = TestClient(TestServer(bridge.create_app(status, player, mute, receive_timeout=0.3)))
        await self.client.start_server()
        self.route = "/microphone?session=" + "a" * 64

    async def asyncTearDown(self):
        await self.client.close()

    async def settle(self):
        for _ in range(100):
            if self.players and self.players[-1].closed:
                return
            await asyncio.sleep(0.005)
        self.fail("Microphone player was not closed")

    async def test_exclusive_microphone_and_immediate_disconnect_cleanup(self):
        ws = await self.client.ws_connect(self.route)
        self.assertEqual(await ws.receive_json(), {"type": "ready", "format": "s16le", "sampleRate": 48000, "channels": 1})
        self.assertEqual(self.mutes, [False])
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect(self.route)
        self.assertEqual(error.exception.status, 409)
        await ws.send_bytes(b"\x10\x00" * 240)
        for _ in range(100):
            if self.players[0].frames:
                break
            await asyncio.sleep(0.005)
        self.assertEqual(self.players[0].frames, [b"\x10\x00" * 240])
        self.assertTrue((await (await self.client.get("/status")).json())["microphone"]["connected"])
        await ws.close()
        await self.settle()
        self.assertEqual(self.mutes, [False, True])
        self.assertEqual(self.players[0].returncode, -9)
        self.assertFalse((await (await self.client.get("/status")).json())["microphone"]["connected"])

    async def test_rejects_browser_origin_and_unknown_device_arguments(self):
        self.assertEqual((await self.client.get("/status", headers={"Origin": "https://example.test"})).status, 403)
        for route in ("/microphone?session=wrong", self.route + "&device=other"):
            with self.assertRaises(WSServerHandshakeError) as error:
                await self.client.ws_connect(route)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.players, [])

    async def test_absent_runtime_is_unavailable_and_camera_is_never_promised(self):
        self.available = False
        state = await (await self.client.get("/status")).json()
        self.assertFalse(state["microphone"]["available"])
        self.assertFalse(state["camera"]["supported"])
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect(self.route)
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.players, [])

    async def test_text_and_partial_sample_frames_close_and_remute(self):
        for frame in ("not-pcm", b"\x00"):
            ws = await self.client.ws_connect(self.route)
            await ws.receive_json()
            if isinstance(frame, str):
                await ws.send_str(frame)
            else:
                await ws.send_bytes(frame)
            message = await ws.receive()
            self.assertEqual(message.type, WSMsgType.CLOSE)
            await self.settle()
            self.assertTrue(self.mutes[-1])

    async def test_silent_abandoned_connection_times_out(self):
        ws = await self.client.ws_connect(self.route)
        await ws.receive_json()
        self.assertEqual((await ws.receive(timeout=2)).type, WSMsgType.CLOSE)
        await self.settle()
        self.assertTrue(self.mutes[-1])

    async def test_oversize_frame_is_discarded(self):
        ws = await self.client.ws_connect(self.route)
        await ws.receive_json()
        await ws.send_bytes(b"\x00" * (bridge.MAX_FRAME + 2))
        self.assertEqual((await ws.receive()).type, WSMsgType.CLOSE)
        await self.settle()
        self.assertEqual(self.players[0].frames, [])

    async def test_rate_limit_closes_without_retaining_excess_input(self):
        ws = await self.client.ws_connect(self.route)
        await ws.receive_json()
        for _ in range(32):
            await ws.send_bytes(b"\x00" * bridge.MAX_FRAME)
        self.assertEqual((await ws.receive()).type, WSMsgType.CLOSE)
        await self.settle()
        self.assertLess(len(self.players[0].frames), 32)

    async def test_player_that_exits_before_ready_is_never_unmuted(self):
        original = Player.__init__
        def exited(player):
            original(player)
            player.returncode = 1
        with patch.object(Player, "__init__", exited):
            with self.assertRaises(WSServerHandshakeError) as error:
                await self.client.ws_connect(self.route)
        self.assertEqual(error.exception.status, 503)
        self.assertNotIn(False, self.mutes)

    async def test_ready_requires_a_matching_pulse_process_stream(self):
        query = SimpleNamespace(returncode=0, wait=AsyncMock(return_value=0),
                                communicate=AsyncMock(return_value=(b'[{"properties":{"application.process.id":"123"}}]', b"")))
        with patch.object(bridge.asyncio, "create_subprocess_exec", AsyncMock(return_value=query)):
            await bridge.wait_player_ready(SimpleNamespace(returncode=None, pid=123))
            with self.assertRaises(RuntimeError):
                await bridge.wait_player_ready(SimpleNamespace(returncode=1, pid=123))

    def test_trusted_socket_peers_only(self):
        for peer in ("127.0.0.1", "::1", "172.30.50.2", "::ffff:172.30.50.2"):
            self.assertTrue(bridge.allowed_peer(peer))
        for peer in (None, "172.30.50.3", "8.8.8.8", "garbage"):
            self.assertFalse(bridge.allowed_peer(peer))


@unittest.skipUnless(all(shutil.which(name) for name in ("pulseaudio", "pactl", "pacat", "parec")), "PulseAudio runtime is required")
class RealPulseBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_pcm_reaches_microphone_and_disconnect_mutes_and_kills_player(self):
        with tempfile.TemporaryDirectory(prefix="cloudbot-mic-") as directory, tempfile.TemporaryFile() as log:
            environment = {**os.environ, "DESKTOP_MEDIA_RUNTIME": directory + "/pulse",
                           "PULSE_RUNTIME_PATH": directory + "/pulse", "PULSE_SERVER": "unix:" + directory + "/pulse/native"}
            daemon = subprocess.Popen([sys.executable, str(bridge.runtime_file), "run"], env=environment, stderr=log)
            client = None
            recorder = None
            players = []
            try:
                result = await asyncio.to_thread(subprocess.run,
                    [sys.executable, str(bridge.runtime_file), "wait"], env=environment, capture_output=True, timeout=15)
                if result.returncode:
                    log.seek(0)
                    self.fail(log.read().decode(errors="replace"))
                with patch.dict(os.environ, environment):
                    async def player_factory():
                        player = await bridge.start_player()
                        players.append(player)
                        return player
                    client = TestClient(TestServer(bridge.create_app(player_factory=player_factory)))
                    await client.start_server()
                    ws = await client.ws_connect("/microphone?session=" + "f" * 64)
                    self.assertEqual((await ws.receive_json())["type"], "ready")
                    with tempfile.TemporaryFile() as capture:
                        recorder = subprocess.Popen(["parec", "--raw", "--format=s16le", "--rate=48000", "--channels=1",
                                                     "--device=" + bridge.runtime.MICROPHONE], env=environment,
                                                    stdout=capture, stderr=subprocess.DEVNULL)
                        await asyncio.sleep(0.1)
                        tone = array.array("h", (int(10000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(1920))).tobytes()
                        for _ in range(20):
                            await ws.send_bytes(tone)
                            await asyncio.sleep(0.04)
                        await asyncio.sleep(0.15)
                        await ws.close()
                        for _ in range(100):
                            if players[0].returncode is not None:
                                break
                            await asyncio.sleep(0.02)
                        self.assertIsNotNone(players[0].returncode)
                        state = await asyncio.to_thread(bridge.runtime.status)
                        self.assertTrue(state["audio"]["microphoneMuted"])
                        self.assertFalse(state["audio"]["microphoneConnected"])
                        recorder.terminate()
                        await asyncio.to_thread(recorder.wait, timeout=5)
                        recorder = None
                        capture.seek(0)
                        data = capture.read()
                        values = array.array("h")
                        values.frombytes(data[:len(data) - len(data) % 2])
                        self.assertGreater(len(values), 1000)
                        self.assertGreater(max(abs(value) for value in values), 1000)
                    await client.close()
                    client = None
            finally:
                if client is not None:
                    await client.close()
                if recorder is not None:
                    recorder.terminate()
                    await asyncio.to_thread(recorder.wait, timeout=5)
                daemon.terminate()
                await asyncio.to_thread(daemon.wait, timeout=5)
