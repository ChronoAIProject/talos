# Talos Worker Installation

Talos workers must reach the private control-plane address. There is no public worker endpoint. Connect the machine to the organization network or its VPN before running `talos-worker init` or the daemon.

## Requirements

- Node.js 22 or newer, including npm.
- macOS or Linux for the installer and managed user service.
- Windows can run the same JavaScript release under Node.js 22, but service installation is manual through Task Scheduler or another supervisor.
- Access to the org-shared `talos` service in NyxID.

The installer defaults to the `ChronoAIProject/talos` repository; set `TALOS_GITHUB_REPO=owner/repository` to install from a fork.

## 1. Create a Pool and Enroll the Machine

Use your personal NyxID key. These requests are proxied with your verified identity, so the pool is owned by your NyxID `sub`.

```sh
nyxid proxy request talos /v1/pools -m POST \
  -d '{"id":"my-mac-pool","visibility":"private","tags":{"region":"home"}}'

nyxid proxy request talos /v1/pools/my-mac-pool/machines -m POST \
  -d '{"id":"my-mac","tags":{"os":"macos","browser":true,"headed_display":true,"residential_ip":true},"capacity":1,"online":true}'
```

The enrollment response contains `worker_token` exactly once. Store it in a password manager or temporary environment variable immediately. Talos stores only its hash and cannot show it again.

```sh
export TALOS_WORKER_TOKEN='tw_value-returned-by-enrollment'
```

## 2. Install

Once the repository has a real GitHub location:

```sh
curl -fsSL https://raw.githubusercontent.com/ChronoAIProject/talos/main/scripts/install-worker.sh | bash
```

Until the placeholder is replaced, or when using a fork:

```sh
curl -fsSL https://raw.githubusercontent.com/ChronoAIProject/talos/main/scripts/install-worker.sh | bash -s -- --version worker-v0.1.0
```

To pin a release:

```sh
curl -fsSL https://raw.githubusercontent.com/ChronoAIProject/talos/main/scripts/install-worker.sh | bash -s -- --version worker-v0.1.0 -s -- --version worker-v0.1.0
```

The installer verifies Node.js 22+, downloads the platform-independent JavaScript release, installs Playwright beside it, and links `~/.local/bin/talos-worker`.

## 3. Initialize

With the machine connected to the required network or VPN:

```sh
talos-worker init
```

The setup prompts for the private control-plane URL, machine and worker ids, token, and browser profile path. The token prompt is hidden. Configuration is stored at `~/.talos-worker/config.json` with mode `0600`, then setup verifies `/healthz` and installs Chromium.

For non-interactive setup, keep the token in an environment variable rather than a command-line argument:

```sh
talos-worker init \
  --control-plane-url http://talos-control-plane.talos.svc.cluster.local \
  --machine-id my-mac \
  --worker-id my-mac-worker \
  --token-env TALOS_WORKER_TOKEN \
  --profile-path "$HOME/.talos-worker/profile"
```

## 4. Install the User Service

```sh
talos-worker service install
talos-worker status
```

On macOS this creates `~/Library/LaunchAgents/ai.chrono.talos-worker.plist`. On Linux it creates `~/.config/systemd/user/talos-worker.service`. Both run `~/.local/bin/talos-worker run` and read the protected config file.

Windows users should run `talos-worker run` through Task Scheduler, configured to start at login and restart on failure. Point the action at the installed `talos-worker.js` using Node.js 22. Automated Windows service installation is intentionally not claimed.

## 5. Verify With a Task

```sh
nyxid proxy request talos /v1/tasks -m POST \
  -d '{"kind":"browse","goal":"Return the page title from example.com","pool_id":"my-mac-pool","mode":"read_only"}'
```

Use the returned task id to check completion:

```sh
nyxid proxy request talos /v1/tasks/TASK_ID
```

## 6. Rotate a Worker Token

Rotation invalidates the previous token immediately and returns the replacement once:

```sh
nyxid proxy request talos /v1/machines/my-mac/rotate-token -m POST \
  -d '{}'

export TALOS_WORKER_TOKEN='tw_new-value-returned-once'
talos-worker init \
  --control-plane-url http://talos-control-plane.talos.svc.cluster.local \
  --machine-id my-mac \
  --worker-id my-mac-worker \
  --token-env TALOS_WORKER_TOKEN \
  --profile-path "$HOME/.talos-worker/profile"
talos-worker service install
```

`talos-worker status` never prints the token. Environment variables such as `TALOS_WORKER_TOKEN` override file values when running the daemon.
