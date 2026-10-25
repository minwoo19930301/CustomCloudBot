import importlib.util
import hashlib
import json
import os
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
bootlog = load('vm-bootlog')
# Real reserved personal-room ID: hexadecimal shape, non-RFC variant bits.
ROOM = 'f6f6cd49-10f4-6102-2f64-da6554d8dba8'
SOURCES = {'device-pool.mjs': '// 기기 풀\nexport class DevicePool {}\n', 'service.mjs': '// service\nexport function start() {}\n'}
REVISION = hashlib.sha256((SOURCES['device-pool.mjs'] + '\0' + SOURCES['service.mjs']).encode()).hexdigest()[:12]


class SeedTests(unittest.TestCase):
    def test_legacy_room_shape_preserves_strict_safe_character_and_length_boundary(self):
        for room in [ROOM, '11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000']:
            for module in [seed, launch, poweroff]:
                self.assertIsNotNone(module.UUID.fullmatch(room))
            docs = seed.seed_documents({'roomId': room, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}, SOURCES)
            self.assertEqual(json.loads(docs['meta-data'])['instance-id'], 'customcloudbot-mobile-' + room + '-runtime-v2-' + REVISION)
        for room in [ROOM + '\n', ROOM + '\r', ROOM + '/', ROOM + '%2f', ROOM[1:], ROOM.replace('-', '/', 1), '../' + ROOM]:
            with self.assertRaises(ValueError):
                seed.seed_documents({'roomId': room, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}, SOURCES)
            with self.assertRaises(ValueError):
                launch.launch_args(room, uid=986)
            with self.assertRaises(ValueError):
                poweroff.poweroff(room)

    def test_private_seed_installs_only_approved_broker_sources_and_instance_settings(self):
        token = 'a' * 64
        docs = seed.seed_documents({'roomId': ROOM, 'token': token, 'output': '/unused/seed.iso.tmp'}, SOURCES)
        data = json.loads(docs['user-data'].decode().split('\n', 1)[1])
        files = data['write_files']
        env = files[0]
        self.assertEqual(env['permissions'], '0600')
        self.assertIn('MOBILE_BROKER_TOKEN=' + token, env['content'])
        self.assertIn('MOBILE_MAX_SLOTS=1\nMOBILE_MAX_RUNNING=1', env['content'])
        self.assertIn('MOBILE_BOOT_SECONDS=600\n', env['content'])
        self.assertNotIn('MOBILE_ANDROID_IMAGE', env['content'])
        self.assertNotIn(token, json.dumps(data['runcmd']))
        self.assertNotIn(token, docs['meta-data'].decode())
        self.assertEqual(data['users'], [])
        self.assertEqual(data['ssh_genkeytypes'], [])
        self.assertEqual(files[3:], [{'path': '/opt/customcloudbot-mobile/' + name, 'owner': 'root:root', 'permissions': '0644', 'content': SOURCES[name]} for name in seed.SOURCE_NAMES])
        self.assertEqual(data['runcmd'][-1], ['systemctl', 'restart', 'customcloudbot-mobile.service'])

    def test_seed_preserves_binder_mount_dependency_instead_of_ignoring_mount_failure(self):
        docs = seed.seed_documents({'roomId': ROOM, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}, SOURCES)
        data = json.loads(docs['user-data'].decode().split('\n', 1)[1])
        mount = [file for file in data['write_files'] if file['path'] == '/etc/systemd/system/dev-binderfs.mount.d/order.conf']
        self.assertEqual(mount, [{'path': '/etc/systemd/system/dev-binderfs.mount.d/order.conf', 'owner': 'root:root', 'permissions': '0644',
                                 'content': '[Unit]\nRequires=systemd-modules-load.service\nAfter=systemd-modules-load.service\n'}])
        self.assertEqual(data['runcmd'][0], ['systemctl', 'daemon-reload'])
        # The seed cannot retroactively fix an early mount failure, and must not
        # mask that failure or replace the golden's filesystem configuration.
        self.assertNotIn('/etc/fstab', [file['path'] for file in data['write_files']])
        self.assertNotIn('mask', [argument for command in data['runcmd'] for argument in command])

    def test_seed_instance_changes_only_for_broker_code_not_token_or_mapping_order(self):
        request = {'roomId': ROOM, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}
        def identity(value, sources):
            return json.loads(seed.seed_documents(value, sources)['meta-data'])['instance-id']
        original = identity(request, SOURCES)
        self.assertEqual(original, identity({**request, 'token': 'b' * 64}, SOURCES))
        self.assertEqual(original, identity(request, dict(reversed(list(SOURCES.items())))))
        for name in seed.SOURCE_NAMES:
            self.assertNotEqual(original, identity(request, {**SOURCES, name: SOURCES[name] + '// update\n'}))

    def test_seed_rejects_missing_extra_unbounded_and_nontext_sources(self):
        request = {'roomId': ROOM, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}
        for sources in [{}, {'service.mjs': SOURCES['service.mjs']}, {**SOURCES, 'extra.mjs': 'unapproved'},
                        {**SOURCES, 'service.mjs': ''}, {**SOURCES, 'service.mjs': b'bytes'},
                        {**SOURCES, 'service.mjs': '한' * (seed.SOURCE_LIMIT // 3 + 1)}]:
            with self.assertRaises(ValueError):
                seed.seed_documents(request, sources)

    def test_source_loader_bounds_reads_and_rejects_nonregular_or_writable_code(self):
        with tempfile.TemporaryDirectory(prefix='ccb-seed-source-') as directory:
            root = Path(directory)
            for name, content in SOURCES.items():
                (root / name).write_text(content, encoding='utf8')
                (root / name).chmod(0o644)
            self.assertEqual(seed.approved_sources(root, owner_uid=os.getuid()), SOURCES)
            with self.assertRaises(ValueError):
                seed.approved_sources(root, owner_uid=os.getuid() + 1)
            root.chmod(0o770)
            with self.assertRaises(ValueError):
                seed.approved_sources(root, owner_uid=os.getuid())
            root.chmod(0o700)
            source = root / 'service.mjs'
            for mode in [0o664, 0o646]:
                source.chmod(mode)
                with self.assertRaises(ValueError):
                    seed.approved_sources(root, owner_uid=os.getuid())
            source.chmod(0o644)
            source.write_bytes(b'x' * (seed.SOURCE_LIMIT + 1))
            with self.assertRaises(ValueError):
                seed.approved_sources(root, owner_uid=os.getuid())
            source.unlink()
            source.symlink_to(root / 'device-pool.mjs')
            with self.assertRaises(OSError):
                seed.approved_sources(root, owner_uid=os.getuid())
            source.unlink()
            os.link(root / 'device-pool.mjs', source)
            with self.assertRaises(ValueError):
                seed.approved_sources(root, owner_uid=os.getuid())
            source.unlink()
            os.mkfifo(source, 0o600)
            with self.assertRaises(ValueError):
                seed.approved_sources(root, owner_uid=os.getuid())

    def test_source_loader_checks_file_owner_after_open(self):
        with tempfile.TemporaryDirectory(prefix='ccb-seed-owner-') as directory:
            root = Path(directory)
            for name, content in SOURCES.items():
                (root / name).write_text(content)
                (root / name).chmod(0o644)
            real_fstat = os.fstat
            def foreign_owned(fd):
                info = real_fstat(fd)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=os.getuid() + 1, st_nlink=info.st_nlink, st_size=info.st_size)
            with patch.object(seed.os, 'fstat', foreign_owned):
                with self.assertRaises(ValueError):
                    seed.approved_sources(root, owner_uid=os.getuid())

    def test_untrusted_seed_fields_are_rejected(self):
        request = {'roomId': ROOM, 'token': 'a' * 64, 'output': '/unused/seed.iso.tmp'}
        for change in [{'roomId': '../other'}, {'token': 'x\nMOBILE_DOCKER_PRIVILEGED=true'}, {'command': 'sh'}]:
            with self.assertRaises(ValueError):
                seed.seed_documents({**request, **change}, SOURCES)

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
                self.assertEqual(args[args.index('-chardev') + 1], 'ringbuf,id=bootlog,size=131072')
                self.assertEqual(args[args.index('-serial') + 1], 'chardev:bootlog')
                self.assertNotIn('-virtfs', args)
                self.assertNotIn('-fsdev', args)
                self.assertNotIn('-enable-kvm', args)
                metadata.write_text(json.dumps({'version': 1, 'roomId': ROOM, 'slot': 3, 'port': 18094, 'command': '/bin/sh'}))
                with self.assertRaises(ValueError):
                    launch.launch_args(ROOM, base=root, uid=986)

    def test_unit_blocks_same_uid_proc_escape_and_does_not_persist_guest_console(self):
        unit = Path(__file__).with_name('customcloudbot-mobile-vm@.service').read_text()
        self.assertIn('InaccessiblePaths=/proc\n', unit)
        self.assertIn('StandardOutput=null\n', unit)
        source = Path(__file__).with_name('vm-launch.py').read_text()
        self.assertIn('ringbuf,id=bootlog,size=131072', source)
        self.assertNotIn('"-serial", "stdio"', source)
        self.assertNotIn('"-serial", "file:', source)

    def test_bootlog_reads_only_fixed_bounded_console_and_redacts_before_truncating(self):
        with tempfile.TemporaryDirectory(prefix='ccb-log-', dir='/tmp') as directory:
            root = Path(directory)
            (root / ROOM).mkdir()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(root / ROOM / 'qmp.sock'))
            listener.listen(1)
            commands = []
            token = 'a' * 64
            payload = 'prior boot log\n' * 2000 + '\nMOBILE_BROKER_TOKEN=' + token + '\n' + token + '\ncloud-init complete\n'
            def guest():
                connection, _ = listener.accept()
                with connection:
                    stream = connection.makefile('rb')
                    connection.sendall(b'{"QMP":{"version":{}}}\r\n')
                    for result in [{}, payload]:
                        request = json.loads(stream.readline())
                        commands.append(request)
                        connection.sendall((json.dumps({'return': result, 'id': request['id']}) + '\r\n').encode())
                    stream.close()
            thread = threading.Thread(target=guest, daemon=True)
            thread.start()
            try:
                text = bootlog.read_bootlog(ROOM, runtime=root, timeout=1)
                self.assertLessEqual(len(text), 16384)
                self.assertNotIn(token, text)
                self.assertNotIn('MOBILE_BROKER_TOKEN', text)
                self.assertIn('cloud-init complete', text)
                self.assertEqual(commands[1], {'execute': 'ringbuf-read', 'id': 'bootlog', 'arguments': {'device': 'bootlog', 'size': 131072, 'format': 'utf8'}})
            finally:
                thread.join(1)
                listener.close()
            with self.assertRaises(ValueError):
                bootlog.read_bootlog('../../another', runtime=root)

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
