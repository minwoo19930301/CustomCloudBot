import importlib.util
import json
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


seed = load('vm-seed')
launch = load('vm-launch')
firewall = load('vm-firewall')
poweroff = load('vm-poweroff')
ROOM = '11111111-1111-4111-8111-111111111111'


class SeedTests(unittest.TestCase):
    def test_private_seed_overrides_only_instance_identity(self):
        token = 'a' * 64
        docs = seed.seed_documents({'roomId': ROOM, 'token': token, 'output': '/unused/seed.iso.tmp'})
        data = json.loads(docs['user-data'].decode().split('\n', 1)[1])
        files = data['write_files']
        env = files[0]
        self.assertEqual(env['permissions'], '0600')
        self.assertIn('MOBILE_BROKER_TOKEN=' + token, env['content'])
        self.assertIn('MOBILE_MAX_SLOTS=1\nMOBILE_MAX_RUNNING=1', env['content'])
        self.assertNotIn('MOBILE_ANDROID_IMAGE', env['content'])
        self.assertNotIn(token, json.dumps(data['runcmd']))
        self.assertNotIn(token, docs['meta-data'].decode())
        self.assertEqual(data['users'], [])
        self.assertEqual(data['runcmd'][-1], ['systemctl', 'restart', 'customcloudbot-mobile.service'])

    def test_untrusted_seed_fields_are_rejected(self):
        request = {'roomId': ROOM, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}
        for change in [{'roomId': '../other'}, {'token': 'x\nMOBILE_DOCKER_PRIVILEGED=true'}, {'command': 'sh'}]:
            with self.assertRaises(ValueError):
                seed.seed_documents({**request, **change})

    def test_launcher_rejects_root_or_an_arbitrary_instance_before_file_reads(self):
        for room, uid in [(ROOM, 0), ('../../etc', 986), (ROOM + ';command', 986)]:
            with self.assertRaises(ValueError):
                launch.launch_args(room, uid=uid)

    def test_launcher_binds_only_private_broker_port_and_never_accepts_extra_configuration(self):
        with tempfile.TemporaryDirectory(prefix='ccb-launch-') as directory:
            root = Path(directory)
            room = root / 'rooms' / ROOM
            room.mkdir(parents=True)
            (root / 'base').mkdir()
            for target in [root / 'base' / name for name in ['golden.qcow2', 'Image', 'initrd']] + [room / 'seed.iso', room / 'disk.qcow2']:
                target.write_text('fixture')
                target.chmod(0o640)
            metadata = room / 'runtime.json'
            metadata.write_text(json.dumps({'version': 1, 'roomId': ROOM, 'slot': 3, 'port': 18094}))
            metadata.chmod(0o640)
            actual_lstat = Path.lstat
            def root_owned(path):
                value = actual_lstat(path)
                return SimpleNamespace(st_mode=value.st_mode & ~0o022, st_uid=986 if path.name == 'disk.qcow2' else 0, st_nlink=value.st_nlink)
            with patch.object(Path, 'lstat', root_owned):
                args = launch.launch_args(ROOM, base=root, uid=986)
                self.assertEqual(args[0], '/usr/libexec/qemu-kvm')
                self.assertEqual(args[args.index('-netdev') + 1], 'user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:18094-:8091')
                self.assertEqual(args[args.index('-qmp') + 1], 'unix:/run/customcloudbot-mobile-vm/' + ROOM + '/qmp.sock,server=on,wait=off')
                self.assertEqual(args[args.index('-object') + 1], 'rng-random,filename=/dev/urandom,id=rng0')
                self.assertIn('virtio-rng-pci,rng=rng0,max-bytes=1024,period=1000', args)
                self.assertNotIn('-virtfs', args)
                self.assertNotIn('-fsdev', args)
                self.assertNotIn('-enable-kvm', args)
                metadata.write_text(json.dumps({'version': 1, 'roomId': ROOM, 'slot': 3, 'port': 18094, 'command': '/bin/sh'}))
                with self.assertRaises(ValueError):
                    launch.launch_args(ROOM, base=root, uid=986)

    def test_unit_blocks_same_uid_proc_escape_and_does_not_record_guest_console(self):
        unit = Path(__file__).with_name('customcloudbot-mobile-vm@.service').read_text()
        self.assertIn('InaccessiblePaths=/proc\n', unit)
        self.assertIn('StandardOutput=null\n', unit)
        source = Path(__file__).with_name('vm-launch.py').read_text()
        self.assertIn('"-serial", "none"', source)

    def test_firewall_scope_preserves_host_and_only_allows_metadata_dns(self):
        text = firewall.rules(986, '168.107.91.96')
        self.assertIn('meta skuid 986 jump vm_egress', text)
        self.assertIn('169.254.169.254 udp dport 53 accept', text)
        self.assertIn('169.254.169.254 tcp dport 53 accept', text)
        self.assertNotIn('dport 80 accept', text)
        self.assertNotIn('flush ruleset', text)
        self.assertIn('meta nfproto ipv6 reject', text)
        self.assertIn('127.0.0.0/8', text)
        for uid, address in [(0, '168.107.91.96'), (986, '127.0.0.1'), (986, '1.2.3.4;flush ruleset')]:
            with self.assertRaises(ValueError):
                firewall.rules(uid, address)

    def test_qmp_poweroff_waits_for_exit_after_shutdown_event(self):
        with tempfile.TemporaryDirectory(prefix='ccb-qmp-', dir='/tmp') as directory:
            root = Path(directory)
            (root / ROOM).mkdir()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(root / ROOM / 'qmp.sock'))
            listener.listen(1)
            commands = []
            def guest():
                connection, _ = listener.accept()
                stream = connection.makefile('rb')
                connection.sendall(b'{"QMP":{"version":{}}}\r\n')
                for name in ['qmp_capabilities', 'system_powerdown']:
                    request = json.loads(stream.readline())
                    commands.append(request['execute'])
                    connection.sendall((json.dumps({'return': {}, 'id': name}) + '\r\n').encode())
                connection.sendall(b'{"event":"SHUTDOWN"}\r\n')
                time.sleep(0.1)
                stream.close()
                connection.close()
            thread = threading.Thread(target=guest, daemon=True)
            thread.start()
            started = time.monotonic()
            poweroff.poweroff(ROOM, runtime=root, timeout=1)
            self.assertGreaterEqual(time.monotonic() - started, 0.09)
            self.assertEqual(commands, ['qmp_capabilities', 'system_powerdown'])
            thread.join(1)
            listener.close()

    def test_qmp_absent_socket_is_bounded_and_invalid_instance_rejected(self):
        with tempfile.TemporaryDirectory(prefix='ccb-qmp-', dir='/tmp') as directory:
            poweroff.poweroff(ROOM, runtime=Path(directory), timeout=0.1)
            with self.assertRaises(ValueError):
                poweroff.poweroff('../../other', runtime=Path(directory))


if __name__ == '__main__':
    unittest.main()
