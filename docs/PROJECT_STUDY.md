# RemoteLink — A Complete Beginner's Study Guide

*A from-scratch remote desktop application (like AnyDesk / TeamViewer), built with
web technologies. This document explains what it does, how it works, every
technology used and why, and walks through each file — written so that someone
new to all of this can follow along.*

---

## 1. What does this project do?

One machine (the **host**, e.g. your laptop) shares its screen. Another device
(the **viewer**, e.g. a tablet — from any network, any distance) sees that
screen live in a browser and controls it: taps move the real mouse, typing
presses real keys. No app install is needed on the viewer — it's just a web page.

```
   TABLET (viewer)                              LAPTOP (host)
 ┌────────────────┐        internet          ┌─────────────────┐
 │ browser page   │ ◄── encrypted video ──── │ browser page    │
 │ viewer.html    │ ─── mouse/keyboard ────► │ host.html       │
 └────────────────┘      (peer-to-peer)      │       │         │
                                             │       ▼         │
                                             │ agent.js        │
                                             │  └─► xdotool ──►│ real cursor
                                             └─────────────────┘
```

---

## 2. The big idea: three problems every remote desktop must solve

| Problem | Our solution |
|---|---|
| **1. Move video + input between two machines fast** | WebRTC — the browser's built-in real-time peer-to-peer engine |
| **2. Help two machines FIND each other across the internet** | A small "signaling" server (Node.js + WebSockets) + STUN/TURN |
| **3. Turn received input events into REAL mouse/keyboard actions** | A native agent process using `xdotool` (browsers alone aren't allowed to do this) |

Understanding these three is understanding the whole project.

---

## 3. Technologies used, and why each one

### WebRTC (Web Real-Time Communication)
The core. A browser API for sending live media and data **directly between two
devices** (peer-to-peer), encrypted end-to-end (DTLS-SRTP). We use three parts:

- `getDisplayMedia()` — asks the user's permission and captures the screen as a video stream.
- `RTCPeerConnection` — the pipe that carries that stream to the other browser.
- `RTCDataChannel` — a low-latency message channel over the same pipe; we send mouse/keyboard events through it.

**Why WebRTC?** It's the only browser technology that connects two devices
*directly* — video doesn't pass through any server, so latency is minimal and
the server stays tiny and cheap.

### WebSockets (the `ws` library)
A persistent two-way connection between browser and server. WebRTC peers can't
find each other on their own — someone must carry their "handshake" messages
(called SDP offers/answers and ICE candidates) back and forth first. Our
signaling server does this over WebSockets. After the handshake, the WebSocket
goes idle — all the heavy traffic is peer-to-peer.

### STUN and TURN (NAT traversal)
Home/mobile networks hide devices behind routers (NAT), so devices don't know
their own public address.

- **STUN** (free Google servers): "mirror" servers that tell a device its public IP/port so peers can try to connect directly. Works for ~85% of network pairs.
- **TURN** (Open Relay, free tier): a relay of last resort for strict networks (e.g. mobile carrier NAT). Media flows through it — still encrypted, it can't read anything.

Both are listed in `public/config.js`; the browser tries direct first, then relay.

### Node.js
JavaScript outside the browser — runs our two server-side programs
(`server.js`, `agent.js`). Chosen because the whole project can then be one
language (JavaScript) end to end.

### xdotool
A Linux command-line tool that fakes keyboard/mouse input at the X11 display
server level: `xdotool mousemove 500 300 click 1` really moves the cursor.
Browsers are sandboxed — a web page may *never* inject OS input (imagine ads
moving your mouse). So a small native program must do this part, and ours
shells out to xdotool.

### cloudflared (Cloudflare Tunnel)
Gives the laptop a temporary public `https://…trycloudflare.com` URL without
router configuration, so a viewer on any network can reach the signaling
server. Free, no account. (A permanent deployment would use a small VPS instead.)

### Languages & libraries at a glance

| Layer | Language / library |
|---|---|
| Web pages (host, viewer, login) | HTML + CSS + plain JavaScript (no framework) |
| Real-time media & control | WebRTC (built into browsers, no library) |
| Signaling server + input agent | Node.js, `ws` (the only npm dependency) |
| Input injection | `xdotool` (system package) |
| Password security | Node's built-in `crypto` (PBKDF2 hashing) |
| Launch scripts | Bash |
| Public access | `cloudflared` binary |

There are **no AI models** in this project — "model" in our early discussions
meant the *architecture model* (the design), which lives in `architecture.html`.

---

## 4. The files, one by one

```
remote-Desktop/
├── start-host.sh          # launcher: same-network use
├── start-public.sh        # launcher: any-network use (adds the tunnel)
├── cloudflared            # tunnel binary
├── docs/
│   ├── architecture.html  # visual architecture diagram
│   └── PROJECT_STUDY.md   # this document
├── signaling-server/
│   ├── server.js          # web server + matchmaker + accounts
│   ├── agent.js           # native input agent (the "hands")
│   ├── users.json         # accounts (created at first signup; hashed passwords)
│   └── package.json       # declares the ws dependency
└── public/
    ├── config.js          # STUN/TURN list + signaling URL (shared by pages)
    ├── login.html         # sign in / create account
    ├── host.html          # the shared machine's page (the "eyes")
    └── viewer.html        # the controlling device's page (the "remote control")
```

### `signaling-server/server.js` — the matchmaker (~250 lines)

Runs on the laptop, does three jobs:

1. **Static file server** — serves the HTML pages over HTTP on port 8080, so
   the only thing either device needs is a URL.
2. **Accounts API** — `POST /api/signup` and `POST /api/login`. Passwords are
   never stored: we store a *hash* made with **PBKDF2** (100,000 rounds of
   SHA-256 plus a random salt per user) in `users.json`. Login returns a random
   **token** the viewer presents later. Five wrong passwords lock the account
   for 5 minutes (brute-force protection).
3. **Signaling** — the WebSocket "switchboard". It keeps a `rooms` map of
   Session IDs. A host sends `register` with its 9-digit ID; a viewer sends
   `join` with the ID **and a valid login token** (rejected otherwise). Then
   the server blindly relays the WebRTC handshake messages (`offer`, `answer`,
   `candidate`) between them. It never sees pixels or keystrokes — those flow
   peer-to-peer after the handshake.

### `signaling-server/agent.js` — the hands (~150 lines)

A tiny Node program on the host machine. It listens on `ws://127.0.0.1:9091` —
**localhost only**, so nothing remote can ever talk to it directly. The host
page forwards each control event to it, and it translates them to `xdotool`
commands:

- `{t:'move', x, y}` → `xdotool mousemove x y`
- `{t:'down', b:0}` → `xdotool mousedown 1` (browser button 0 = X11 button 1)
- `{t:'key', k:'Enter', down:true}` → `xdotool keydown Return` (browser key names → X11 keysym names)
- Plain characters are typed (`xdotool type`), but if Ctrl/Alt is held they're
  pressed as keys instead — that's how **Ctrl+C stays a shortcut** rather than
  becoming the letter "c".

Two robustness details worth studying:
- **Move coalescing**: mouse moves arrive fast; each injection spawns a
  process. Queued moves are replaced by the newest one so injection never lags
  behind reality.
- **Stuck-key protection**: the agent remembers every key/button currently
  held down, and if the connection drops it releases them all — otherwise a
  lost "key up" would leave e.g. Ctrl haunted-pressed on the real desktop
  forever (a classic remote-desktop bug we hit and fixed).

### `public/host.html` — the eyes

The page open on the shared laptop. Step by step:
1. Generates a 9-digit Session ID (like AnyDesk's address).
2. **Start sharing** → `getDisplayMedia()` captures the screen (native
   resolution, 30 fps) after the browser's permission popup.
3. Registers the ID with the signaling server; waits.
4. When a viewer joins, creates the `RTCPeerConnection`, attaches the screen
   track, creates the `control` data channel, and performs the offer/answer
   handshake through the server.
5. Tells the viewer its **real screen size** over the data channel — clicks
   are mapped against this, so even if the video stream gets scaled the
   cursor lands exactly where the viewer tapped.
6. Incoming control events → forwarded to the agent on `ws://127.0.0.1:9091`
   (and shown in an on-page log, capped at 150 lines).
7. **Stop sharing** (button or the browser's own stop bar) tears everything
   down and mints a fresh ID for next time.
8. **✉ Invite via email** opens your mail app with a prefilled invite link
   (`viewer.html?sid=…`).

Quality/latency tuning applied to the video sender:
- `contentHint = 'text'` — desktop UI is text; encode for legibility.
- `degradationPreference = 'maintain-resolution'` — if bandwidth drops, lower
  the framerate but **never blur**.
- `maxBitrate = 6 Mbps` — enough for a crisp desktop; capped so slow links
  don't build up queueing delay (unbounded bitrate = seconds of lag on 4G).

### `public/viewer.html` — the remote control

The page on the tablet/any device:
1. **Account gate** — no login token in the browser's localStorage → redirect
   to `login.html` (and back after signing in). Invite links pre-fill the ID.
2. Joins the session (ID + token), answers the WebRTC offer, and shows the
   incoming stream in a `<video>` element. `playoutDelayHint = 0` tells the
   browser to render frames immediately instead of buffering (~150 ms saved).
3. **Input capture**: mouse events on the video are converted to host-screen
   coordinates — as a *fraction* of the visible picture (subtracting any black
   letterbox bars) multiplied by the host's announced screen size. Mouse moves
   are throttled to ~30/second so they can't flood the channel.
4. **Touch keyboard**: tablets fire no useful key events, so the ⌨ button
   focuses an invisible text field to summon the on-screen keyboard, and the
   text it produces is diffed into key events (with a proper press *and*
   release for keys like space — a stuck-spacebar bug we fixed).
5. **Full screen**: the ⛶ button; click mapping stays correct, focus is
   restored so typing keeps working, and on Chrome desktop **Keyboard Lock**
   captures system combos (Alt+Tab, Ctrl+W) for the remote machine.
6. **Stuck-key protection, viewer side**: on any focus loss it sends key-up
   for everything it believes is pressed.

### `public/login.html` — sign in / create account

A small form that calls `/api/signup` or `/api/login`, stores the returned
token + email in localStorage, and returns you to where you were headed.

### `public/config.js` — shared connection settings

The STUN/TURN server list and the signaling WebSocket URL (auto-derives
`ws://` vs `wss://` from how the page was loaded, so the same file works on
localhost and through the HTTPS tunnel).

### The launch scripts

- `start-host.sh` — same-network mode: starts `server.js` + `agent.js`.
- `start-public.sh` — any-network mode: same plus a cloudflared tunnel, and
  prints the public URL. Both free their ports first so a crashed previous run
  can't block them (`EADDRINUSE`).

---

> **Want the packet-level version?** How routing works on a LAN vs across the
> internet, NAT types, STUN/TURN/ICE algorithms, DTLS/SRTP/SCTP, congestion
> control, and a build-it-from-raw roadmap:
> **[NETWORKING_DEEP_DIVE.md](NETWORKING_DEEP_DIVE.md)**

## 5. Life of one session, end to end

1. Laptop runs `./start-public.sh` → server + agent + tunnel start; public URL printed.
2. Laptop browser opens `host.html` → Start sharing → screen captured, ID `417 902 385` registered. Host page connects to the local agent: "Native control: ACTIVE".
3. Host clicks **✉ Invite via email** → friend receives the link.
4. Friend's tablet opens the link → redirected to `login.html` → creates an account → back on `viewer.html`, ID pre-filled → Connect.
5. Server checks the token, pairs the two, relays the WebRTC handshake. The browsers try STUN (direct); if the network is strict, they fall back to the TURN relay.
6. Video flows tablet-ward; every tap/keystroke flows laptop-ward on the data channel → host page → agent → xdotool → real cursor moves. Round trip is typically tens of milliseconds.
7. Host presses **Stop sharing** (or Ctrl+C in the terminal) → stream, session, and public URL all die; viewer sees "Host stopped sharing".

---

## 6. Security design (and honest limits)

**In place:**
- All media/input is end-to-end encrypted by WebRTC itself; the tunnel and TURN relay only ever see ciphertext.
- Screen capture requires an explicit user click and shows the browser's persistent "sharing" indicator.
- Viewers must have an account; passwords stored as salted PBKDF2 hashes; failed-login lockout.
- The input agent binds to localhost only; one viewer per session; every event visible in the host log; each run gets a fresh URL and each session a fresh ID.

**Limits to respect:**
- Whoever has the URL + Session ID + an account can fully control the machine — treat those like passwords, run sessions only while supervising them, Ctrl+C when done.
- The free TURN relay and tunnel are shared test-grade services; production would self-host both (coturn + a VPS).
- Login tokens live in server memory — a restart signs everyone out (harmless, they log in again).

---

## 7. Ideas for taking it further

- **Package as an installable app** (Electron/Tauri): bundle server + agent + host page into a double-click application — the viewer stays a plain URL. (Needs Node 14+; this machine has Node 10.)
- **Host-side "accept" prompt** before a viewer is admitted (AnyDesk-style).
- Clipboard sync, file transfer, audio, multi-monitor selection.
- On-screen Ctrl/Alt/Esc buttons in the viewer for tablets.
- Wayland support (`ydotool`/`wlrctl`) and Windows/macOS agents (`SendInput`/`CGEvent`).

---

## 8. Mini glossary

| Term | Meaning |
|---|---|
| **P2P (peer-to-peer)** | Two devices talking directly, no middleman server |
| **Signaling** | The introduction phase: exchanging connection details via a server |
| **SDP offer/answer** | The "here are my capabilities/addresses" messages of the WebRTC handshake |
| **ICE candidate** | One possible network path a peer proposes trying |
| **NAT** | Router feature that hides devices behind one public IP (why P2P is hard) |
| **STUN** | Server that tells a device its public address (enables direct P2P) |
| **TURN** | Relay server used when direct P2P is impossible |
| **DataChannel** | WebRTC's low-latency message pipe (our control channel) |
| **X11 / keysym** | Linux display system / its name for a key (`Return`, `space`, `BackSpace`) |
| **PBKDF2** | Slow, salted password-hashing algorithm — makes stolen hashes useless |
| **Token** | Random secret proving "this request comes from a logged-in user" |
