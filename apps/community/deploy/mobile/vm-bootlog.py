#!/usr/bin/env python3
"""Private operator-only, bounded console diagnostic; never read guest env files."""
import json
import os
from pathlib import Path
import re
import socket
import sys
import time

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
BUFFER_BYTES = 131072
OUTPUT_CHARS = 16384


def read_bootlog(room, runtime=Path('/run/customcloudbot-mobile-vm'), timeout=5):
    if not UUID.fullmatch(room):
        raise ValueError('invalid VM identity')
    deadline = time.monotonic() + timeout
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(runtime / room / 'qmp.sock'))
        pending = bytearray()
        def receive():
            while b'\n' not in pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('boot diagnostic timeout')
                connection.settimeout(remaining)
                chunk = connection.recv(8192)
                if not chunk:
                    raise EOFError()
                pending.extend(chunk)
                # QMP JSON can escape one console byte as six characters.
                if len(pending) > BUFFER_BYTES * 6 + 8192:
                    raise ValueError('oversized QMP response')
            line, _, rest = pending.partition(b'\n')
            pending[:] = rest
            return json.loads(line)
        if 'QMP' not in receive():
            raise ValueError('invalid QMP greeting')
        commands = [
            {'execute': 'qmp_capabilities', 'id': 'capabilities'},
            {'execute': 'ringbuf-read', 'id': 'bootlog', 'arguments': {'device': 'bootlog', 'size': BUFFER_BYTES, 'format': 'utf8'}},
        ]
        for command in commands:
            connection.sendall((json.dumps(command) + '\r\n').encode())
            while True:
                response = receive()
                if response.get('id') == command['id']:
                    if 'return' not in response:
                        raise ValueError('QMP diagnostic unavailable')
                    break
        text = response['return']
        if not isinstance(text, str) or len(text) > BUFFER_BYTES:
            raise ValueError('invalid console response')
        # Defense in depth for diagnostics; normal cloud-init write_files logs
        # contain paths/lengths, not credentials. Redact before clipping a tail.
        text = re.sub(r'(?im)^.*MOBILE_BROKER_TOKEN.*$', '[private credential line omitted]', text)
        text = re.sub(r'(?i)\b[0-9a-f]{64}\b', '[private hexadecimal value omitted]', text)
        return text[-OUTPUT_CHARS:]


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 2:
            raise ValueError('root and one room identifier are required')
        print(json.dumps({'roomId': sys.argv[1], 'consoleTail': read_bootlog(sys.argv[1])}))
    except Exception:
        print('Private mobile boot diagnostic unavailable.', file=sys.stderr)
        sys.exit(1)
