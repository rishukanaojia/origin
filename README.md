# RemoteLink — a cross-network remote desktop model

A working model of how tools like **AnyDesk / TeamViewer / Teams** connect two
machines that sit on **different networks, behind different routers, at any
distance** — without either having a public IP.

- **Architecture design** → open [`docs/architecture.html`](docs/architecture.html)
  (also published as a shareable page). It explains the whole model: the
  rendezvous/signaling server, NAT traversal (STUN / ICE / TURN), the encrypted
  WebRTC transport, and the security model.
- **Prototype** → a runnable proof-of-concept that implements that model:
  screen sharing + remote input across networks, using WebRTC.
- **Production plan** → [`docs/PRODUCTION_DESIGN.md`](docs/PRODUCTION_DESIGN.md):
  unique IDs bound to device keys, mandatory login (SSO/OPAQUE), password
  recovery, peer-verified device passwords, an untrusted-server privacy model,
  and the prototype→production gap list.

## The core idea in one paragraph

~90% of devices are behind NAT, so they can't be dialed directly. RemoteLink
uses a small public **signaling server** to introduce two peers by a 9-digit
**Session ID**, has them discover their public addresses via **STUN**, and then
**hole-punches** a direct peer-to-peer link (via **ICE**). Screen video and
mouse/keyboard events flow over an **encrypted WebRTC channel** — the server
never sees them. When a network is too strict for direct P2P, a **TURN** relay
carries the encrypted stream so the connection *always* works.

## Install on any device (lightweight PWA)

The app is a **Progressive Web App**, so it installs on **every device** —
Android/iPhone phones, tablets, Windows, macOS, Linux — straight from the
browser, with its own icon and full-screen window, and it's **lightweight**
(no big download; it reuses the browser already on the device):

- **Phone / tablet:** open the app URL → browser menu → **Add to Home Screen**.
- **Desktop (Chrome/Edge):** open the app URL → click **⬇ Install app** (or the
  install icon in the address bar) → it opens as its own windowed app.

Works fully offline-capable for the UI (service worker), and the same install
works on all operating systems.

> **What each device can do:**
> - **Control *from* any device** (phone/tablet/laptop): the PWA is all you need. ✅
> - **Be controlled** (share screen + receive real mouse/keyboard): needs native
>   OS input, so it works on **desktops** (Windows/macOS/Linux, via the app or the
>   input agent) but **not on phones/tablets** — mobile browsers can't inject
>   input into their own OS. This is the same split AnyDesk/TeamViewer have.

## Desktop app (installable, cross-platform software)

There is a real **installable desktop application** (Electron) — no browser, no
terminal. It bundles the signaling server and input agent and opens the peer UI
in its own window. The code is **OS-independent**: input injection uses
[nut.js](https://nutjs.dev), which ships prebuilt binaries for **Windows,
macOS and Linux** (with `xdotool` as a Linux fallback), so the same app runs
on all three.

### Single-file executables (in `desktop-app/dist/`)

There is **no one binary that runs on every OS** — each OS only executes its own
format. So we ship one single-file executable *per* OS, all from this one codebase:

| OS | File | Notes |
|---|---|---|
| **Debian / Ubuntu** | `RemoteLink-1.0.0-linux.deb` | `sudo dpkg -i` (or double-click in Software) → installs to `/opt/RemoteLink` with an app-menu entry. **Built.** |
| **Linux** (any distro) | `RemoteLink-1.0.0-linux.AppImage` | `chmod +x` → double-click. Portable: no install, no dependencies. **Built & tested.** |
| **Windows** | `RemoteLink-1.0.0-windows.exe` | Portable — double-click, no install. **Built here, but not yet tested on a real Windows machine.** |
| **macOS** | build on a Mac: `npm run dist` → `.dmg` | Apple's toolchain can't be run from Linux. |
| **Phone / tablet** | the **PWA** (Add to Home Screen) | A Play Store `.apk` needs the Android SDK (Bubblewrap/TWA). |

- **Run from source (Linux/macOS):** `./RemoteLink.sh`
  (uses the Node 20 in `~/.local/node-v20`). On any OS: `cd desktop-app && npm start`.

### Building the Windows / macOS installers

The app is cross-platform, but Electron apps with native modules must be
**packaged on each target OS** (you can't build a working Windows `.exe` or
macOS `.dmg` from Linux — it needs that OS's toolchain / wine / code-signing).
On the target machine, with Node 18+ installed:

```bash
cd desktop-app
npm install          # nut.js auto-fetches that OS's prebuilt binary
npm run dist         # → Windows: .exe (nsis) + portable   |   macOS: .dmg + .zip
```

`npm run dist` builds for whatever OS it runs on. (A CI matrix with
Windows/macOS/Linux runners produces all three from one push.)

The app shows this machine's **permanent ID** and **access password**. To
connect to another machine, type its ID + password; that machine gets an
**Accept/Decline** prompt, then shares its screen. Either side can **⇄ Swap**
to reverse who shares and who controls.

> **Cross-network note:** each app instance runs its own embedded signaling
> server, so two machines must share **one** server to find each other. For a
> laptop↔tablet test, the laptop runs the app + tunnel and the tablet opens the
> tunnel URL in its browser. For two desktop apps across the internet, point
> both at one deployed signaling server (a small VPS) — a documented next step.
> Tablets/phones use the browser/PWA form; a native mobile app is a separate build.

## Run the browser prototype

Requires Node.js (works on the v10 in this environment; v14+ recommended).
For real mouse/keyboard control on a Linux/X11 host, also install xdotool once:

```bash
sudo apt install xdotool
```

Then start everything on the host laptop with one command:

```bash
./start-host.sh      # web+signaling server on :8080, input agent on :9091
```

Then:

1. **Host** — open `http://localhost:8080/host.html`, click **Start sharing**,
   pick a screen/window. Note the **Session ID**.
2. **Viewer** — on another machine/network, open `http://<server-ip>:8080/viewer.html`,
   enter that Session ID, click **Connect**.
3. You'll see the host's screen in the viewer. Click the video and move the
   mouse / type — events stream to the host and appear in its control log.

> **Testing across real networks:** the two browsers can be on any networks as
> long as both can reach the signaling server's public IP. STUN handles most NAT
> pairs; add TURN (below) for the strict ones. On a single machine you can test
> with two browser tabs.

## How real control works (the input agent)

Browsers sandbox OS input for safety, so the host *page* can't move the mouse.
The `agent.js` process (started by `start-host.sh`) bridges that gap:

```
viewer (tab) --WebRTC--> host.html --ws://127.0.0.1:9091--> agent.js --> xdotool --> real cursor
```

The agent listens on **localhost only** (nothing remote can reach it directly),
translates events to `xdotool` commands (mouse move/click/scroll, typing,
special keys), and coalesces high-rate mouse moves so injection keeps up.
The host page shows "Native control: ACTIVE" when the agent is connected.
On Windows/macOS the same agent would swap `xdotool` for `SendInput`/`CGEvent`
(e.g. via `robotjs`).

## Remaining production steps

| Gap | Why | Production path |
|-----|-----|-----------------|
| **No TURN relay** | STUN-only connects ~85% of network pairs; symmetric NATs need a relay. | Run [coturn](https://github.com/coturn/coturn) and add its `turn:` URL + credentials in [`public/config.js`](public/config.js). |
| **Not packaged as an app** | Currently a script + browser page. | Wrap server+agent+host UI in **Electron or Tauri** for a double-click installable (needs Node 14+ to build). The viewer stays a plain URL — zero install on the controlling device. |

Other production steps: authentication + access passwords, an attended-consent
prompt on the host, rotating short-lived TURN credentials, adaptive bitrate,
and geo-distributed relays for low latency at distance.

## Files

## Peer model — permanent IDs, no accounts (AnyDesk-style)

Every machine runs the **same app** ([`app.html`](public/app.html)) and is a
peer with:

- a **permanent numeric ID** (generated once, kept in this browser/install's
  storage; the server remembers it in `signaling-server/peers.json` and proves
  ownership with a stored secret so nobody can steal your ID), and
- an **access password** the other side must enter to connect.

There is **no email and no login** — the ID is the identity, the password is
the security. To connect, enter the other machine's ID + access password. The
callee gets an **Accept / Decline** prompt before their screen is shared.

**Either side can share or control, and you can ⇄ Swap roles mid-session** —
the viewer becomes the one being controlled and vice-versa, without
reconnecting.

> **On permanence:** the ID persists per-origin. Opened on a stable origin
> (`localhost`, or the future packaged app) it never changes. A machine reached
> through the throwaway tunnel URL gets a fresh ID when that URL changes —
> packaging as a desktop app (Electron/Tauri, needs Node 14+) stores the ID in
> a local file so both ends are permanent.

```
docs/architecture.html     # the architecture model (visual design)
start-host.sh              # one-command launcher for the host laptop
signaling-server/
  server.js                # rendezvous + signaling + static file server
  agent.js                 # native input agent (xdotool injection, localhost-only)
  package.json
public/
  config.js                # ICE (STUN/TURN) config, shared
  app.html                 # THE unified peer app (open this on every machine)
  app.js                   # app logic: identity, calling, role-swap, control
  host.html, viewer.html,  # legacy split pages (superseded by app.html)
  login.html
```
