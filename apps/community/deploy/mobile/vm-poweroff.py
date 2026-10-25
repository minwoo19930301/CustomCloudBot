#!/usr/bin/env python3
"""Ask only this VM to power down, then let systemd enforce its stop timeout."""
import json
from pathlib import Path
import re
import socket
import sys
import time

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def poweroff(room, runtime=Path('/run/customcloudbot-mobile-vm'), timeout=30):
    if not UUID.fullmatch(room):
        raise ValueError('invalid VM identity')
    deadline = time.monotonic() + timeout
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(min(2, timeout))
        connection.connect(str(runtime / room / 'qmp.sock'))
        pending = bytearray()

        def receive():
            while b'\n' not in pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('VM stop timeout')
                connection.settimeout(min(2, remaining))
                chunk = connection.recv(4096)
                if not chunk:
                    raise EOFError()
                pending.extend(chunk)
                if len(pending) > 65536:
                    raise ValueError('invalid QMP response')
            line, _, rest = pending.partition(b'\n')
            pending[:] = rest
            return json.loads(line)

        if 'QMP' not in receive():
            raise ValueError('invalid QMP greeting')
        for operation in ['qmp_capabilities', 'system_powerdown']:
            connection.sendall((json.dumps({'execute': operation, 'id': operation}) + '\r\n').encode())
            while True:
                response = receive()
                if response.get('id') == operation:
                    if 'return' not in response:
                        raise ValueError('QMP command rejected')
                    break
        # SHUTDOWN is followed by the final disk flush. Wait for EOF, not only
        # that event, before ExecStop returns and systemd signals remaining tasks.
        while time.monotonic() < deadline:
            try:
                receive()
            except socket.timeout:
                continue
    except (OSError, EOFError, TimeoutError):
        pass  # A dead/unresponsive VM is handled by systemd's bounded fallback.
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('invalid arguments')
        poweroff(sys.argv[1])
    except Exception:
        print('Private mobile VM graceful stop was unavailable.', file=sys.stderr)
        sys.exit(1)
