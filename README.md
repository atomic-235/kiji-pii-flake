# kiji-pii-flake

Local PII masking for [OpenCode](https://opencode.ai): a small HTTP service that runs the
[Kiji PII model](https://huggingface.co/DataikuNLP/kiji-pii-model-onnx) on CPU, plus an OpenCode
plugin that masks outgoing model requests when you ask it to.

Nothing leaves the machine for detection. The service listens on `127.0.0.1:8788`.

## What it does

- Masks names, emails, phones, addresses and other PII in outgoing request bodies.
- Toggleable: off by default, `/kiji` toggles, `/kiji on|off|status` sets explicitly.
- Structural fields (`model`, `providerID`, `id`, `role`, …) and binary payloads are never touched.
- Fail-open: if the service is down or slow, requests go out unchanged.

It does **not** mask API tokens — for that use the regex plugin in
[`atomic-235/shared`](https://github.com/atomic-235/shared) (`secret-filter.ts`).

## Install

Three parts: a Nix installation (or Node, see below), the service, the plugin.

### 1. Start the service

Any system with Nix — NixOS, other Linux, WSL — needs nothing beyond `nix` with flakes enabled:

```bash
nix run github:atomic-235/kiji-pii-flake
```

That builds the package, pins the quantised model (~66 MB) in the store, and serves
`POST /redact` and `GET /health` on `127.0.0.1:8788`.

To keep it around and run it as a background process:

```bash
nix profile install github:atomic-235/kiji-pii-flake
kiji-pii-server &          # or supervise it however you prefer
```

`KIJI_PORT`, `KIJI_HOST` and `KIJI_THREADS` are read by the server.

### 2. Install the plugin

Pick one:

```bash
# a) npm (once published: cd plugin && npm publish)
opencode plugin add opencode-kiji-pii

# b) one-liner, drops the plugin file into ~/.config/opencode/plugins/
curl -fsSL https://raw.githubusercontent.com/atomic-235/kiji-pii-flake/main/install-plugin.sh | bash

# c) manual, via opencode.json
```

For (c), add the package or a local path to `plugins` in `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-kiji-pii"]
}
```

Local checkouts also work: `"plugins": ["./path/to/kiji-pii-flake/plugin"]`.

### 3. Restart OpenCode

```bash
opencode service restart
opencode plugin list    # should list local.kiji-filter
```

## Usage

```
/kiji            toggle
/kiji on         enable masking
/kiji off        disable masking
/kiji status     report the current state
```

`enable kiji` / `disable kiji` / `turn kiji off` work too. The state is stored in plugin
storage, so it survives restarts. Default is off.

The service URL defaults to `http://127.0.0.1:8788`; override with `KIJI_PII_URL`.

## NixOS / Home Manager (optional)

The flake exposes `packages.<system>.kiji-pii` and `overlays.default`, so the service can be a
systemd user unit instead of a background process:

```nix
{
  inputs.kiji-pii.url = "github:atomic-235/kiji-pii-flake";
  inputs.kiji-pii.inputs.nixpkgs.follows = "nixpkgs";
}
```

```nix
systemd.user.services.kiji-pii = {
  Unit.Description = "Kiji PII redaction service";
  Service = {
    ExecStart = "${pkgs.kiji-pii}/bin/kiji-pii-server";
    Restart = "on-failure";
  };
  Install.WantedBy = [ "default.target" ];
};
```

## Container (macOS, Windows, or no Nix/Node)

A multi-arch image is built by CI and published to GHCR — nothing needs to be installed on the
host except Docker or Podman:

```bash
podman run -d --rm --name kiji-pii \
  -p 127.0.0.1:8788:8788 \
  ghcr.io/atomic-235/kiji-pii:latest

curl -s 127.0.0.1:8788/health
```

Linux `amd64` and `arm64` are both built natively (no emulation), so Apple Silicon runs the
arm64 image. The model is baked into the image; it starts without network access.
The plugin still installs normally — it only talks to `KIJI_PII_URL`.

Tags: `latest`, `sha-<commit>`. To build the image locally:

```bash
nix build .#docker && docker load -i result
```

## Without Nix

The service is plain Node (>= 22) plus `onnxruntime-node`, so it runs anywhere:

```bash
git clone https://github.com/atomic-235/kiji-pii-flake
cd kiji-pii-flake/server
npm ci
KIJI_MODEL_DIR=/path/to/model node server.mjs
```

Download the model files from the revision pinned in `version.json` —
`model_quantized.onnx`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`,
`label_mappings.json` — from
`https://huggingface.co/DataikuNLP/kiji-pii-model-onnx/resolve/<revision>/<file>`
into `KIJI_MODEL_DIR`.

The plugin itself is plain TypeScript and needs no Nix at all — use install path (a) or (b).

## Development

```bash
cd plugin && bun test      # 18 tests over command parsing, string collection and body rewriting
nix build .#default        # the service
```

## Layout

```
plugin/            opencode plugin, published as opencode-kiji-pii
server/            Node service: tokenizer + onnxruntime, 512-token windows
package.nix        Nix package for the service (model pinned in version.json)
install-plugin.sh  one-liner installer
.github/workflows  multi-arch container build, pushed to ghcr.io/atomic-235/kiji-pii
```
