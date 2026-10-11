# BUILD-SPEC.md — JD Manager

Reverse-engineered specification of the JD Manager service as it actually
exists, plus the CI/CD pipeline built to ship it. Written after the fact from
the running system (app, PM2, nginx, Let's Encrypt, Cloudflare) — it is the
source of truth for reproducing or extending the system.

- **Product:** JD Manager — a simple web app for creating and managing job descriptions.
- **Current version:** 1.1.0
- **Live:** https://jd.jihltd.com
- **Repository:** https://github.com/Vivalankaeditor2/jdmanager

---

## 1. Application

### 1.1 Runtime
- Node.js ≥ 20 (target runtime), **zero runtime dependencies** — built-ins only
  (`http`, `fs`, `path`, `crypto`).
- Single process, single file entry point: `server.js`.

### 1.2 Configuration (environment)
| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_FILE` | `<app>/data/jds.json` | JSON datastore path |

### 1.3 Data model
One file, `data/jds.json`, holding an array of job descriptions:

```json
{
  "id": "12-hex-chars",
  "title": "string (defaults to 'Untitled role')",
  "department": "string",
  "location": "string",
  "employmentType": "string",
  "summary": "string",
  "status": "draft | published",
  "sections": [{ "id": "hex", "heading": "string", "items": ["bullet", "..."] }],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

Normalisation rules: all string fields trimmed; `status` coerced to
`published` only when exactly `"published"`, otherwise `draft`; empty bullet
items dropped; `id`/`createdAt` preserved on update; `updatedAt` refreshed on
every write.

### 1.4 HTTP API
| Method | Path | Success | Notes |
|--------|------|---------|-------|
| GET | `/api/jds` | 200 | List all |
| GET | `/api/jds/:id` | 200 / 404 | Get one |
| POST | `/api/jds` | 201 | Create; body JSON |
| PUT | `/api/jds/:id` | 200 / 404 | Update |
| DELETE | `/api/jds/:id` | 200 / 404 | Delete |
| — | unsupported method | 405 | |
| — | malformed JSON body | 400 | |

Static files are served from `public/`; `/` maps to `index.html`. Missing files
return 404 and path traversal outside `public/` is rejected (403/404).

### 1.5 UI
Single page (`public/index.html` + `app.js` + `styles.css`): list with search
and status filters, create/edit/delete, dynamic sections and bullets,
draft/published status, print view.

**Highlighted form element (explicit requirement):** the **Status** dropdown in
the editor is emphasised via

```css
#editorForm > label:nth-child(4) > select { /* brand border, tinted bg, focus ring */ }
```

This is covered by a regression test so it cannot silently disappear.

### 1.6 Seed
Ships with one published JD, id `seedbdmgr001` — "Business Development Manager",
derived from `BusinessDevelopment.docx`.

---

## 2. Topology (as deployed)

| Concern | Value |
|---------|-------|
| Host | `5.189.163.58` (`vmi660923.contaboserver.net`), CentOS 8 + Plesk |
| IPv6 | `2a02:c207:2066:923::1` |
| App dir | `/srv/jd-manager` |
| Process | PM2 `jd-manager`, `127.0.0.1:3099` |
| Web server | nginx `/etc/nginx/conf.d/zzz-jd-manager.conf` |
| TLS | Let's Encrypt `jd.jihltd.com`, certbot webroot `/var/www/letsencrypt` |
| DNS | Cloudflare `A jd.jihltd.com -> 5.189.163.58`, DNS-only |
| Auth | SSH `root` + password (host key not in `authorized_keys`) |

### 2.1 Hard constraints
1. **No `default_server` in nginx.** The first `server` block per `IP:port` in
   include order is the implicit default. Custom vhosts **must** sort last →
   file is named `zzz-jd-manager.conf`. Verified: unknown Host does not reach
   the app, and neighbours keep their prior behaviour.
2. **Shared host with live neighbours** — `attendance-api`, `staging.jihltd.com`,
   `preview.jihltd.com`, `icbm.exon.lk`, `sports.javainstitute.org`,
   `test2.javainstitute.edu.lk`, `system.roadwininternational.com`. Deploys must
   not touch them.
3. **Cloudflare token** (`/root/.secrets/cloudflare_dns_token`) manages only the
   `jihltd.com` zone; `javainstitute.*`/`exon.lk` are not manageable from here.
4. **PM2 boot:** `pm2-root.service` is enabled (`pm2 resurrect`); always
   `pm2 save` after changing processes.

### 2.2 Request path
```
client → Cloudflare DNS → 5.189.163.58:443 (nginx)
       → 301 http→https at :80 (ACME path exempt)
       → reverse_proxy → 127.0.0.1:3099 (node) → /srv/jd-manager/data/jds.json
```

---

## 3. CI/CD pipeline

Defined in `.github/workflows/ci-cd.yml`. GitHub-hosted runners (no runner
needed on the shared box).

### 3.1 Triggers
| Event | Jobs |
|-------|------|
| PR → `main` | `ci` |
| push → `main` | `ci` |
| push tag `v*` | `ci` → `deploy` + `release` |

### 3.2 Jobs
- **`ci`** — `npm run check` (syntax) and `npm test` (Node built-in test runner).
- **`deploy`** — `needs: ci`, tag only, `environment: production` (attach required
  reviewers to gate it). Steps: build tarball → verify SSH → remote deploy →
  smoke test public URL. Each step is skipped with a warning if the deploy
  secrets are absent, so an unconfigured repo stays green.
- **`release`** — `needs: ci`, tag only, `permissions: contents: write`, creates a
  GitHub Release from the tag via `gh release create`.

### 3.3 Deployment code path (single source of truth)
Both CI and local use `deploy/wire-deploy.py`; server work is in
`deploy/deploy-server.sh`. Subcommands: `pack`, `check-ssh`, `remote-deploy`,
`remote-nginx-http`, `remote-cert`, `remote-nginx-tls`, `smoke`.

Release tarball contains **only** `server.js`, `package.json`, `README.md`,
`public/`, `data/` — deploy tooling, tests and `.deploy/` (secrets) are excluded.

Remote deploy sequence:
1. `cp -a` current release → `/srv/jd-manager.bak-<ts>`
2. extract new tarball over the app dir (runtime `data/` preserved)
3. `pm2 restart jd-manager --update-env` (or `pm2 start`) then `pm2 save`
4. **health check** `http://127.0.0.1:3099/` (expect 200) + `/api/jds` probe
5. on failure → **automatic rollback** to the backup and restart
6. prune backups, keep newest 3

### 3.4 Required GitHub configuration
**Secrets** (Settings → Secrets and variables → Actions → Secrets):
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PASSWORD`.

**Variables** (optional overrides): `DEPLOY_DOMAIN` (default `jd.jihltd.com`),
`DEPLOY_IPV4`, `DEPLOY_IPV6`, `DEPLOY_HEALTH_URL`.

> Without the three secrets, `ci` and `release` still run and `deploy` skips.

### 3.5 Manual run
```bash
python3 deploy/wire-deploy.py pack
DEPLOY_HOST=5.189.163.58 DEPLOY_USER=root DEPLOY_PASSWORD=... \
  python3 deploy/wire-deploy.py remote-deploy
python3 deploy/wire-deploy.py smoke      # HEALTH_URL=...
```

### 3.6 First-time server provisioning (new host)
```bash
python3 deploy/wire-deploy.py pack
python3 deploy/wire-deploy.py remote-nginx-http   # ACME bootstrap vhost
python3 deploy/wire-deploy.py remote-cert         # obtain certificate
python3 deploy/wire-deploy.py remote-nginx-tls    # redirect + reverse proxy
python3 deploy/wire-deploy.py remote-deploy
python3 deploy/wire-deploy.py smoke
```

---

## 4. Verification / acceptance
- `npm test` — 10 tests (API CRUD, validation, error codes, static serving,
  traversal guard, highlighted-element CSS) all passing.
- CI `ci` job green on PR/push; `deploy` + `release` green on a `v*` tag.
- `https://jd.jihltd.com/` → 200 (contains "JD Manager"); `http` → 301 → https.
- Neighbour vhosts unchanged after deploy; unknown Host does not hit the app.

---

## 5. Known limitations / future work
- No authentication on the app (anyone with the URL can edit JDs).
- Datastore is a single JSON file (fine for this scale; no concurrency locking).
- Deploy credentials are password-based; migrating to a dedicated deploy key
  with `authorized_keys` + `ssh` would remove the password secret.
- `deploy` auto-runs on tags. Add required reviewers to the `production`
  environment in GitHub to require manual approval.
