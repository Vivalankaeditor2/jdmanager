# JD Manager

A very simple web app for creating and managing job descriptions.

No dependencies, no build step — it runs on Node's built-in modules only.

## Deployment

Hosted at **https://jd.jihltd.com** (isolated subdomain, HTTPS).

- **Server:** `5.189.163.58` (Plesk/CentOS 8). App lives in `/srv/jd-manager`.
- **Process:** PM2 process `jd-manager`, bound to `127.0.0.1:3099`.
  `pm2-root.service` is enabled and `pm2 save` includes this app, so it
  restarts on reboot.
- **Web server:** `/etc/nginx/conf.d/zzz-jd-manager.conf` — HTTP 301 → HTTPS,
  HTTPS reverse-proxies to `127.0.0.1:3099`. Named `zzz-*` so it sorts last and
  does **not** become nginx's implicit default server for the shared IP.
- **TLS:** Let's Encrypt cert for `jd.jihltd.com` (certbot webroot,
  `/var/www/letsencrypt`), auto-renewing.
- **DNS:** Cloudflare `A jd.jihltd.com -> 5.189.163.58`, DNS-only (grey cloud).

### Redeploy (automated)

Pushing a `v*` tag runs the **CI/CD** workflow (see `BUILD-SPEC.md` and
`.github/workflows/ci-cd.yml`): it tests the app, then redeploys it and smoke
tests the public URL.

To deploy by hand, the same code path the pipeline uses is available locally:

```bash
python3 deploy/wire-deploy.py pack             # build dist/jd-manager.tar.gz
DEPLOY_HOST=5.189.163.58 DEPLOY_USER=root \
DEPLOY_PASSWORD=... python3 deploy/wire-deploy.py remote-deploy
```

`remote-deploy` backs up the current release, extracts the new one, restarts
PM2, health-checks `127.0.0.1:3099`, and **rolls back automatically** if the
check fails.

### Local

```powershell
cd C:\Ravee\NLightWorkspace\jd-manager
node server.js
```

Then open **http://localhost:3000**

To use a different port: `$env:PORT=4000; node server.js`

## Features

- View a list of all job descriptions with search and status filters
- Create, edit, and delete job descriptions
- Add/edit/reorder-free sections (headings) and bullet responsibilities
- Draft / published status
- Print a clean copy of any job description

## Data

Stored as plain JSON in `data/jds.json`. Edit that file directly if you prefer,
or delete it to start empty (it is recreated automatically).

## Tests

Zero-dependency, using Node's built-in test runner (Node ≥ 20):

```bash
npm test        # node --test   (10 API + static tests)
npm run check   # syntax check
```

The tests boot the real server on an ephemeral port against a temporary data
file and exercise the HTTP API end to end.

## API

| Method | Path           | Purpose             |
|--------|----------------|---------------------|
| GET    | /api/jds       | List all            |
| GET    | /api/jds/:id   | Get one             |
| POST   | /api/jds       | Create              |
| PUT    | /api/jds/:id   | Update              |
| DELETE | /api/jds/:id   | Delete              |
