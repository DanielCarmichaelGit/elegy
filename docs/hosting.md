# Hosting a cowove relay

The relay is the one piece everyone in a session connects to. Host it once,
and starting a session becomes one click with no tunnels or networking to
think about. Anyone you invite just pastes the invite code.

The relay is a single small Node process with a data folder:

- It holds each session's shared state and the files people share in chat.
- It needs one always-on machine with a disk. Rooms live in that machine's
  memory, so run exactly one instance.
- 512 MB of RAM is plenty for a group of friends.

## 1. Pick where to run it

### Fly.io (recommended)

About $2–5 a month for a small always-on machine with a 3 GB volume.

```bash
fly auth login
fly launch --copy-config --no-deploy      # choose a unique app name when asked
fly volumes create cowove_data --size 3
fly secrets set COWOVE_RELAY_KEY=$(openssl rand -base64 24)
fly deploy
fly secrets list                          # the key is stored; keep your copy
```

Your relay is at `wss://<app-name>.fly.dev`.

### Render

1. In Render, choose **New → Blueprint** and pick this repository. It uses
   [`render.yaml`](../render.yaml): a Docker web service with a 5 GB disk.
   Disks need a paid instance type.
2. Render generates `COWOVE_RELAY_KEY` for you. Copy it from the service's
   **Environment** tab.

Your relay is at `wss://<service-name>.onrender.com`.

### Any Linux server (VPS) with Docker

This setup includes Caddy, which gets and renews an HTTPS certificate
automatically. Point a DNS name at the server first, then:

```bash
git clone <this repo> && cd cowove/deploy
export COWOVE_DOMAIN=relay.example.com
export COWOVE_RELAY_KEY=$(openssl rand -base64 24); echo "$COWOVE_RELAY_KEY"
docker compose up -d
```

Your relay is at `wss://relay.example.com`.

### Just Docker

A prebuilt image is published from this repo's `main` branch:

```bash
docker run -d --name cowove-relay -p 4321:4321 -v cowove-data:/data \
  -e COWOVE_RELAY_KEY=... ghcr.io/danielcarmichaelgit/cowove-relay:latest
```

Put it behind HTTPS (Caddy, nginx, or your platform's proxy) so clients can
use `wss://`. The first time the image is published, GitHub makes the package
private. To pull it without logging in, make it public under your GitHub
profile → **Packages** → `cowove-relay` → **Package settings**. You can also build it yourself with `docker build -t cowove-relay .`

## 2. Point cowove at it

On your machine:

```bash
cowove relay set wss://your-relay.example.com --key <your relay key>
cowove relay            # check it: "ok · 40 ms · …"
```

From then on:

- `cowove join` in a folder starts a new session on your relay.
- The app (`cowove ui`) has it selected under **Hosted relay** when you start a
  session.
- Agents calling `cowove_start_session` use it too.

You can also set it from the app: enter the address and key when starting a
session and leave **Make this my default relay** ticked.

**People you invite don't need the key.** The key only lets you start new
sessions. Joining a session only needs its invite code, which carries the
relay address and that session's own secret, but never your relay key.

## Settings

All settings are environment variables on the relay.

| Variable | Default | What it does |
|---|---|---|
| `COWOVE_RELAY_KEY` | *(none)* | Required to **start** sessions. Without it, anyone who can reach the relay can start sessions on it. |
| `PORT` | `4321` | Port to listen on (Render and Fly set this for you). |
| `COWOVE_DATA` | `/data` in Docker | Where sessions and shared files are stored. |
| `COWOVE_MAX_ROOM_MB` | `256` | Size limit for one session's shared project. Past it, the session stays readable, but new changes are refused. |
| `COWOVE_MAX_ROOM_FILES_MB` | `2048` | Storage for files shared in one session's chat (each file is at most 100 MB). |
| `COWOVE_MAX_CONNS_PER_IP` | `50` | Connections allowed from one address. |
| `COWOVE_ROOM_TTL_DAYS` | `30` | Sessions nobody has opened for this long are deleted, files included. Set it to `0` to keep them forever. |
| `COWOVE_TRUST_PROXY` | off (on in the provided configs) | Use `X-Forwarded-For` to find client addresses. Only turn it on behind a proxy. |

## Checking on it

- `https://your-relay/` shows a small status page.
- `https://your-relay/healthz` returns JSON for monitoring (`ok`, uptime,
  connections, loaded rooms).
- `cowove relay check wss://your-relay` tests it from any machine.
- Logs show sessions connecting and leaving, but never their contents.

## Good to know

- **Privacy.** The relay stores each session's files and chat so people can
  reconnect and catch up. Whoever runs it can read that data, so host it
  yourself or with people you trust. End-to-end encryption would remove this
  requirement, and it's a natural next step.
- **Backups.** Everything lives in the data volume (`/data`). Back it up like
  any other volume, or don't: every collaborator also has the full project on
  their own disk.
- **Updating.** Redeploy (`fly deploy`, a Render redeploy, or
  `docker compose pull && docker compose up -d`). Clients reconnect on their
  own, and edits made during the restart sync once it's back.
- **One instance.** Don't scale the relay to several machines. People in the
  same session must reach the same process.
