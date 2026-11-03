# Volumora sync server

Optional. Keeps snapshots of each account's data on a server you run, so a reinstall does not lose anything.
Accounts are folders under `data/users/`; registration needs an invitation code.

Run it with `docker compose up -d --build`. It listens on 127.0.0.1:8787; put HTTPS in front of it, for example
Tailscale Funnel (`tailscale funnel --bg 8787`) or Caddy with `reverse_proxy 127.0.0.1:8787` and `request_body { max_size 64MB }`.

Updates, optional: `auto-update.sh` checks main every five minutes and rebuilds once the new commit's CI has passed. If
the server does not come up it goes back to the previous version; the last copy of the code and `data/` is in `previous/`.
It only updates `server.js`, `admin.js` and `package.json`. Changes to `Dockerfile`, `docker-compose.yml` or the script
itself still need copying by hand. Switch it on once, with the script copied to the server folder:

```
(crontab -l 2>/dev/null; echo '*/5 * * * * flock -n /tmp/volumora-update.lock $HOME/volumora-sync/auto-update.sh >> $HOME/volumora-sync/auto-update.log 2>&1') | crontab -
```

Administration, run on the server:

```
docker compose exec volumora-sync node admin.js invite        # one new invitation code
docker compose exec volumora-sync node admin.js invites       # all codes and who used them
docker compose exec volumora-sync node admin.js users         # accounts with size
docker compose exec volumora-sync node admin.js reset-password NAME
docker compose exec volumora-sync node admin.js delete-user NAME
```

Back up the `data/` folder like any other data. The server can read every account's data, so run it only for people who trust you.

## Other apps and push

`/v1/apps/<name>/snapshot` works like `/v1/snapshot`, in a place of its own, so another app of the same account can never overwrite the Volumora data. `/v1/push/key`, `/v1/push/subscribe` and `/v1/push/alarms` send timed reminders by Web Push; the server makes its key pair on first use and keeps it in `data/push.json`.
