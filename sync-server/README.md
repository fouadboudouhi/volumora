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

## Claude for everyone, on one key

With a Claude key stored (admin screen in the app, kept in `data/ai.json`), `/v1/ai/messages` forwards the apps'
requests to Claude and books what each answer cost on the account, against a monthly budget in dollars.

The server, not the app, decides what may be asked for, because every request is paid with that one key. The lists
are at the top of `server.js`: `MODELS` (only models with a price in the table), `MAX_OUTPUT_TOKENS`, `AI_BETAS`,
and of Claude's own tools only web search and web fetch. **When an app is to use another model, add it here first**,
with its prices, or its requests are answered with `400 model`.

A request passes only while the budget covers what it may cost (the longest answer allowed plus what Claude has to
read), and requests that are still running count as spent. At most four per account run at once. So `402 budget`
can come a little before the budget is used up to the cent, and `429 busy` means: wait for the one that is running.
It is a guess made before the request runs, so set a hard spend limit for the key at Anthropic as well.

## Limits

Sign-in, registration, push and admin calls: 16 KB. Reminders: 256 KB. A Claude request: 8 MB. A snapshot: 64 MB,
and only from someone signed in. A body over its limit is refused and never kept in memory.

Twenty wrong passwords for one account within an hour lock its sign-in for the rest of that hour, also with the
right password; devices that are signed in keep working. The count is kept in `data/failures.json`, so a restart
does not reset it. To lift a lock at once, stop the server, delete that file and start it again.

`admin.js` writes the same files as the running server. Changing an account with it in the very moment that account
is signing in or getting a Claude answer can lose one of the two changes; run it again if a change did not stick.

## Other apps and push

`/v1/apps/<name>/snapshot` works like `/v1/snapshot`, in a place of its own, so another app of the same account can never overwrite the Volumora data. `/v1/push/key`, `/v1/push/subscribe` and `/v1/push/alarms` send timed reminders by Web Push; the server makes its key pair on first use and keeps it in `data/push.json`.
