# TinyCld on Railway — ops doc

This fork runs TinyCld on Railway **with local changes preserved** and
**automatic upstream sync** from the tinycld team.

## How it fits together

```
tinycld/tinycld (upstream)          your fork                      Railway
─────────────────────────           ───────────────────────        ──────────────
release v0.8.1 ──── tag ──►  deploy = v0.8.1 + your commits ──►  ghcr.io/<owner>/tinycld:latest
        │                          ▲        │                        │
        └── new release ───────────┘        └── push your commits ───┘
            daily workflow merges               same workflow builds    Image Auto Updates
            (conflicts fail loudly)             + pushes image          deploys new digest
```

- **`main`** — pristine mirror of upstream. Never commit here; it's fast-forwarded daily.
- **`deploy`** — what ships. Based on an upstream release tag; your commits live on top.
  Sync uses **merge**, never rebase — your changes survive every upstream release.
- Workflow: `.github/workflows/sync-and-build.yml` — syncs, assembles the pnpm
  workspace from upstream's pinned release assets (`manifest.json` clones each
  feature package at a pinned SHA, `pnpm-lock.yaml` pins the dependency graph),
  builds `linux/amd64`, pushes to GHCR. Your own `push` to `deploy` skips sync
  and goes straight to build.

## Railway service setup

1. **Source**: Docker image `ghcr.io/<owner>/tinycld:latest`.
   The first pushed GHCR package is **private** — either make it public
   (package → Package settings → Change visibility; the code is AGPL anyway)
   or add GHCR credentials under Railway → Settings → Registry credentials.
2. **Volume** (critical): mount a volume at **`/workspace/pb_data`**.
   Everything stateful (PocketBase DB, uploaded files, releases, backups) lives
   there. Any other path = silent data loss on every redeploy. Size it for
   Drive/mail attachments — 10 GB is a sane start.
3. **Variables**:
   - `PRIMARY_DOMAIN` — your public domain (e.g. `mail.example.com`). Feeds the
     setup URL and cert SANs even in proxy mode.
   - `PUBLIC_SCHEME=https` — Railway's edge terminates TLS; the container serves plain HTTP.
   - `AUTOCERT_ENABLED` — **leave unset** (Let's Encrypt HTTP-01 can't reach :80 on Railway).
   - Optional: `SENTRY_DSN`, `POSTMARK_SERVER_TOKEN` (mail delivery), `VAPID_PUBLIC_KEY` + `VAPID_SUBJECT` (web push).
4. **Networking**: generate a domain, target port **`7090`** (plain HTTP).
5. **Healthcheck path**: `/api/health`.
6. **Settings → Image auto-updates**: enable, pick a maintenance window.
   This is what turns "new image on GHCR" into "Railway redeploy".
7. **Memory**: the container ships Node + Go and runs in-app rebuilds on package
   installs — give it ≥ 2 GB.

## Making a change

```bash
git clone https://github.com/<owner>/tinycld && cd tinycld
git checkout deploy
# ...edit...
git commit -am "my change" && git push
```

The workflow builds and publishes the image; Railway rolls it out at the next
maintenance window (or redeploy manually for instant).

## When upstream ships a release

The daily cron merges the new tag into `deploy` and rebuilds. If the merge
conflicts (your change and upstream's touch the same lines), the workflow goes
red with instructions — resolve locally:

```bash
git checkout deploy
git remote add upstream https://github.com/tinycld/tinycld.git
git fetch upstream tag vX.Y.Z --no-tags
git merge vX.Y.Z    # resolve, commit
git push            # pipeline rebuilds automatically
```

Manual trigger anytime: Actions → "Sync upstream & publish Railway image" → Run workflow.

## Modifying a feature package (mail/calendar/contacts/…)

The image bakes feature packages cloned **from upstream at pinned SHAs**
(`scripts/ci-assemble-workspace.sh`). Two supported ways to ship changes:

1. **PR upstream first** — if it's a generic improvement, merging it upstream
   means the next sync picks it up with zero extra plumbing.
2. **Fork the package repo** (e.g. `tinycld/mail`), then in the fork change
   `ci-assemble-workspace.sh`'s clone step to pull from your fork (the script
   honors `TINYCLD_REPO_BASE` for bootstrap, but sibling clones come from the
   manifest's `repo` field — patch the `git clone` line or the manifest). Note
   the pinned SHA still applies; point it at a SHA that exists in your fork.

## Caveats

- **Mail ports**: the image listens on 993 (IMAPS) / 465 (SMTPS) in addition to
  HTTP. Railway exposes only the HTTP port publicly by default — use Railway
  TCP proxies if you need real IMAP/SMTP from outside. Mail *delivery* goes
  through Postmark (`POSTMARK_SERVER_TOKEN`), which works fine on Railway.
- **AGPL-3.0**: TinyCld is AGPL. If you modify it and serve users over the
  network, you must make your modified source available to them — keeping this
  fork public satisfies that.
- **Backups**: the volume is the only copy. Snapshot it periodically (Railway
  volume backups, or `sqlite3 /workspace/pb_data/data.db "VACUUM INTO ..."`).
