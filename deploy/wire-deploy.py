#!/usr/bin/env python3
"""Deployment transport for JD Manager.

Same script is used by the GitHub Actions pipeline and from a workstation, so
the deploy path is identical whether it is run by CI or by hand.

Configuration comes from environment variables:

  DEPLOY_HOST        target hostname or IP            (required)
  DEPLOY_USER        ssh user                         (default root)
  DEPLOY_PASSWORD    ssh password                     (required; pass via a
                                                      secret, never on argv)
  DEPLOY_PORT        ssh port                         (default 22)
  APP_DIR            install dir                      (default /srv/jd-manager)
  APP_PORT           app port                         (default 3099)
  APP_NAME           pm2 process name                 (default jd-manager)
  DOMAIN             public hostname                  (e.g. jd.jihltd.com)
  IPV4 / IPV6        addresses for the nginx listen   (nginx subcommands)
  HEALTH_URL         post-deploy smoke URL

Subcommands:
  pack                 build dist/jd-manager.tar.gz
  check-ssh            prove the ssh transport works (read-only)
  remote-deploy        upload the tarball and run deploy-server.sh
  remote-nginx-http    install an ACME-only vhost (pre-certificate bootstrap)
  remote-cert          obtain/renew the Let's Encrypt certificate
  remote-nginx-tls     install the HTTPS vhost (redirect + reverse proxy)
  smoke                assert HEALTH_URL returns 200
"""

import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
TARBALL = DIST / "jd-manager.tar.gz"

# Runtime files that make up a release. Everything else (tests, deploy
# tooling, vcs metadata, the secret-bearing .deploy dir) stays out.
RELEASE_INCLUDE = ["server.js", "package.json", "README.md", "public", "data"]

HOST = os.environ.get("DEPLOY_HOST", "")
USER = os.environ.get("DEPLOY_USER", "root")
PORT = os.environ.get("DEPLOY_PORT", "22")
APP_DIR = os.environ.get("APP_DIR", "/srv/jd-manager")
APP_PORT = os.environ.get("APP_PORT", "3099")
APP_NAME = os.environ.get("APP_NAME", "jd-manager")
DOMAIN = os.environ.get("DOMAIN", "")
IPV4 = os.environ.get("IPV4", "")
IPV6 = os.environ.get("IPV6", "")
HEALTH_URL = os.environ.get("HEALTH_URL", "")


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def need(name, value):
    if not value:
        die(f"{name} is not set")


def _ssh_base():
    return [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=20",
        "-p", PORT,
        f"{USER}@{HOST}",
    ]


def _run(cmd, check=True):
    print("+ " + " ".join(str(c) for c in cmd), flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    if out.strip():
        print(out.rstrip())
    if check and proc.returncode != 0:
        die(f"command failed ({proc.returncode})")
    return proc.returncode


def ssh(remote_cmd, check=True):
    need("DEPLOY_HOST", HOST)
    need("DEPLOY_PASSWORD", os.environ.get("DEPLOY_PASSWORD"))
    # sshpass -e keeps the password out of the process list.
    return _run(["sshpass", "-e"] + _ssh_base() + [remote_cmd], check=check)


def scp(local, remote):
    _run([
        "sshpass", "-e", "scp",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-P", PORT,
        str(local), f"{USER}@{HOST}:{remote}",
    ])


def put(local, remote):
    """Copy a text file to the host, normalising CRLF -> LF first."""
    put_text(Path(local).read_text(), remote)


def put_text(text, remote):
    """Write in-memory text to the host with LF line endings."""
    data = text.encode("utf-8").replace(b"\r\n", b"\n")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".tmp") as fh:
        fh.write(data)
        tmp = fh.name
    try:
        scp(tmp, remote)
    finally:
        os.unlink(tmp)


def pack():
    expected = os.environ.get("EXPECTED_VERSION")
    if expected:
        import json
        pkg = json.loads((ROOT / "package.json").read_text())
        if pkg.get("version") != expected:
            die(f"package.json version {pkg.get('version')} != tag {expected}")

    DIST.mkdir(exist_ok=True)
    with tarfile.open(TARBALL, "w:gz") as tar:
        for item in RELEASE_INCLUDE:
            p = ROOT / item
            if p.exists():
                tar.add(p, arcname=item)
    print(f"packed {TARBALL} ({TARBALL.stat().st_size} bytes)")


def smoke():
    need("HEALTH_URL", HEALTH_URL)
    import urllib.request
    req = urllib.request.Request(HEALTH_URL, headers={"User-Agent": "ci-smoke"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            code, body = r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - report and fail
        die(f"smoke request to {HEALTH_URL} failed: {exc}")
    print(f"smoke {HEALTH_URL} -> {code}")
    if code != 200:
        die(f"expected 200, got {code}")
    if "JD Manager" not in body:
        die("response did not contain the 'JD Manager' page marker")


def _remote_env():
    return " ".join([
        f"APP_DIR='{APP_DIR}'",
        f"APP_PORT='{APP_PORT}'",
        f"APP_NAME='{APP_NAME}'",
        "TARBALL=/tmp/jd-manager.tar.gz",
    ])


def remote_deploy():
    put(ROOT / "deploy" / "deploy-server.sh", "/tmp/deploy-server.sh")
    scp(TARBALL, "/tmp/jd-manager.tar.gz")
    ssh(f"{_remote_env()} bash /tmp/deploy-server.sh")


def _render_nginx(template):
    conf = (ROOT / "deploy" / "nginx" / template).read_text()
    for key, val in (("@@HOST@@", DOMAIN), ("@@IP@@", IPV4), ("@@IP6@@", IPV6), ("@@PORT@@", APP_PORT)):
        conf = conf.replace(key, val)
    return conf


def _install_vhost(template):
    need("DOMAIN", DOMAIN)
    put_text(_render_nginx(template), "/tmp/jd-manager.conf")
    dest = "/etc/nginx/conf.d/zzz-jd-manager.conf"
    ssh(
        "set -e; "
        f"[ -f {dest} ] && cp -a {dest} {dest}.bak-$(date +%s); "
        f"cp /tmp/jd-manager.conf {dest}; chmod 644 {dest}; chown root:root {dest}; "
        "nginx -t; systemctl reload nginx; sleep 1; "
        f"curl -sk -o /dev/null -w 'local https=%{{http_code}}' -H 'Host: {DOMAIN}' https://127.0.0.1/; echo"
    )


def remote_nginx_http():
    _install_vhost("jd-manager-http.conf")


def remote_nginx_tls():
    _install_vhost("jd-manager.conf")


def remote_cert():
    need("DOMAIN", DOMAIN)
    script = (
        "set -uo pipefail; "
        "mkdir -p /var/www/letsencrypt; "
        f"certbot certonly --webroot -w /var/www/letsencrypt -d {DOMAIN} "
        "--non-interactive --agree-tos --keep-until-expiring --expand 2>&1 | tail -15; "
        f"test -f /etc/letsencrypt/live/{DOMAIN}/fullchain.pem && echo CERT_OK || {{ echo CERT_MISSING; exit 1; }}"
    )
    ssh(script)


def check_ssh():
    ssh("hostname; uname -sr; "
        f"pm2 describe {APP_NAME} >/dev/null 2>&1 && pm2 describe {APP_NAME} | "
        "grep -E 'status|script path' || echo 'app not yet deployed'")


DISPATCH = {
    "pack": pack,
    "check-ssh": check_ssh,
    "remote-deploy": remote_deploy,
    "remote-nginx-http": remote_nginx_http,
    "remote-cert": remote_cert,
    "remote-nginx-tls": remote_nginx_tls,
    "smoke": smoke,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in DISPATCH:
        die(f"usage: {Path(sys.argv[0]).name} <{'|'.join(DISPATCH)}>")
    if shutil.which("sshpass") is None and sys.argv[1] not in ("pack", "smoke"):
        die("sshpass is required (apt-get install sshpass)")
    DISPATCH[sys.argv[1]]()


if __name__ == "__main__":
    main()
