#!/usr/bin/env python3
"""Load this deployment's own nft table. Never flush shared firewall tables."""
import ipaddress
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys

CONFIG = Path("/etc/sysconfig/customcloudbot-mobile-vm-public-ip")
TABLE = "community_mobile_vm_guard"


def rules(uid, public_ip):
    address = ipaddress.IPv4Address(public_ip)
    if not address.is_global or type(uid) is not int or uid <= 0:
        raise ValueError("invalid firewall identity")
    return f"""table inet {TABLE} {{
 chain vm_egress {{
  ct state invalid drop
  ct state established,related accept
  meta nfproto ipv6 reject with icmpx type admin-prohibited
  ip daddr 169.254.169.254 udp dport 53 accept
  ip daddr 169.254.169.254 tcp dport 53 accept
  fib daddr type local reject with icmpx type admin-prohibited
  ip daddr {{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, {address} }} reject with icmpx type admin-prohibited
  return
 }}
 chain output {{
  type filter hook output priority -110; policy accept;
  meta skuid {uid} jump vm_egress
 }}
}}
"""


def main():
    if os.getuid() != 0:
        raise ValueError("root setup required")
    info = CONFIG.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 64:
        raise ValueError("unsafe firewall configuration")
    uid = pwd.getpwnam("ccb-mobile-vm").pw_uid
    payload = rules(uid, CONFIG.read_text().strip())
    # Replacement is one atomic nft transaction. Only this dedicated table is
    # replaced; established production Docker and desktop policies remain intact.
    existing = subprocess.run(["/usr/sbin/nft", "list", "table", "inet", TABLE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    if existing.returncode == 0:
        payload = "delete table inet " + TABLE + "\n" + payload
    subprocess.run(["/usr/sbin/nft", "--check", "--file", "-"], input=payload.encode(), check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["/usr/sbin/nft", "--file", "-"], input=payload.encode(), check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Private mobile VM firewall setup failed.", file=sys.stderr)
        sys.exit(1)
