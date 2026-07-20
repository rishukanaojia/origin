# RemoteLink Networking Deep Dive — How Packets Actually Find Their Way

*Companion to [PROJECT_STUDY.md](PROJECT_STUDY.md). This explains the network
path in protocol-level detail — same network, different networks, every
protocol and algorithm involved — with the RFC numbers you'd need to build it
from raw sockets yourself.*

---

## 0. The protocol stack we ride on

Everything below sits on the classic layers. Know where each piece lives:

```
┌──────────────────────────────────────────────────────────────────┐
│ APPLICATION   HTTP · WebSocket · SDP · STUN · TURN · RTP/RTCP    │
│ SECURITY      TLS (signaling) · DTLS + SRTP (media/data)         │
│ TRANSPORT     TCP (signaling)  · UDP (media, preferred) · SCTP   │
│ NETWORK       IP (routing between networks happens HERE)         │
│ LINK          Ethernet / Wi-Fi (ARP lives here)                  │
└──────────────────────────────────────────────────────────────────┘
```

Two separate "conversations" exist in RemoteLink, on different transports:

1. **Signaling** (finding each other): browser ⇄ server, WebSocket over TCP.
2. **Media + control** (the actual desktop): browser ⇄ browser, RTP & SCTP
   over DTLS over **UDP** — UDP because real-time traffic would rather *drop*
   a late packet than wait for a TCP retransmission.

---

## 1. Same network (your LAN test: tab → laptop on one Wi-Fi)

### 1.1 Reaching the server: `http://10.79.57.113:8080`

`10.x.x.x` is **private address space** (RFC 1918: `10/8`, `172.16/12`,
`192.168/16`) — valid only inside your LAN. When the tab requests that URL:

1. **Same-subnet check.** The tab compares the target IP with its own IP+netmask
   (e.g. `10.79.57.42/24`). Same prefix → the laptop is on-link; no router needed.
2. **ARP** (Address Resolution Protocol). IP packets on a LAN are delivered
   inside Ethernet/Wi-Fi frames, which address by **MAC**, not IP. The tab
   broadcasts *"who has 10.79.57.113?"*; the laptop replies with its MAC; the
   answer is cached (see it: `ip neigh`).
3. **TCP three-way handshake** to port 8080: `SYN → SYN-ACK → ACK`.
4. **HTTP GET** `/viewer.html` over that TCP connection.
5. **WebSocket upgrade** — one more HTTP request with
   `Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Key: <random>`.
   Server answers `101 Switching Protocols`, and from then on the same TCP
   connection carries WebSocket **frames** (a tiny binary framing: FIN bit,
   opcode, mask bit, length, payload — RFC 6455) instead of HTTP. That's our
   signaling channel.

### 1.2 The P2P part on a LAN

Even on one network, WebRTC runs the full ICE machinery (§3) — it just finishes
instantly, because both sides gather **host candidates** (their own private
IPs) and a direct check `10.79.57.42 → 10.79.57.113` succeeds on the first try.

One modern wrinkle: browsers hide your private IP from web pages for privacy,
so host candidates appear as **mDNS names** like `a2c9…f.local` (multicast DNS,
RFC 6762 — resolution by asking "who is this name?" on multicast group
`224.0.0.251:5353`). The peer's browser resolves it back to the real IP
locally; the JavaScript never sees it.

> **Client isolation caveat:** hotspots/campus Wi-Fi often block
> client-to-client frames at the access point. Then nothing on the LAN path
> works — not ARP, not the direct check — and you must go through the internet
> path (§2) even though both devices sit on the same router.

---

## 2. Different networks — the real problem: NAT

### 2.1 What your router actually does

Your laptop has `10.79.57.113`; the internet can't route to that (millions of
networks use the same range). The router performs **NAPT** (Network Address
& Port Translation). For every outbound UDP/TCP flow it writes a row in its
translation table:

```
inside (src)            outside (rewritten src)      remote (dst)
10.79.57.113:53211  →   203.0.113.7:41822        →   142.250.1.1:19302
```

Replies arriving at `203.0.113.7:41822` are translated back. Two consequences:

- A device behind NAT **does not know its own public address**.
- **Unsolicited inbound packets match no table row and are dropped.** This is
  why "no server at all" is physically impossible across the internet:
  *someone* must have a reachable address to make the introduction.

### 2.2 NAT behavior types (RFC 4787 — this decides your fate)

Two independent behaviors matter:

**Mapping** — when the same inside socket talks to a *different* remote, does
the router reuse the same outside port?
- *Endpoint-independent* (good): same outside port for everyone → others can be
  told about it and hit it.
- *Address/port-dependent* ("symmetric", bad): a **new** outside port per
  destination → the port you discovered via a STUN server is useless for
  reaching you from anywhere else.

**Filtering** — who may send *in* through a mapping?
- *Endpoint-independent*: anyone who knows the mapping (easiest).
- *Address-dependent / address+port-dependent*: only remotes you've already
  sent packets **to** (this is what hole punching exploits).

Roughly: most home routers = punchable; mobile carrier NAT (CGNAT, often
symmetric on both ends) = frequently not → TURN needed. This is the "~85%
direct" statistic.

### 2.3 STUN — learning your public address (RFC 8489)

A STUN server is a mirror: you send a UDP **Binding Request**, it replies
"here is the address:port I saw you from".

The packet is beautifully simple — build one yourself in ~50 lines:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|0 0|  Type=0x0001 (Binding Req)|         Message Length          |
|                 Magic Cookie = 0x2112A442                       |
|                 Transaction ID (96 bits, random)                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

The response carries `XOR-MAPPED-ADDRESS`: your public IP/port **XORed with
the magic cookie**. Why XOR? Some broken NATs "helpfully" rewrite anything in
a payload that looks like their own IP; XOR hides it from them.

### 2.4 UDP hole punching — the core trick

Peers A and B each learned their public `(IP, port)` via STUN and exchanged
them through the signaling server. Now **both fire UDP packets at each other
simultaneously**:

```
A → B:  A's NAT creates row "A allowed to talk to B"   (packet may die at B's NAT)
B → A:  B's NAT creates row "B allowed to talk to A"   — and A's NAT now has a
                                                          row permitting B → in!
next A → B:  passes B's NAT (B already has the row)     TUNNEL OPEN 🎉
```

Each side's *outbound* packet is what unlocks its own NAT's filter for the
other side's packets. Timing doesn't need to be perfect — ICE retransmits.
This fails only when a symmetric NAT changes ports per-destination so the
advertised port is wrong.

### 2.5 TURN — the relay of last resort (RFC 8656)

When punching fails, both peers connect *outbound* to a public relay (outbound
always works). Protocol flow: `Allocate` (get a relayed address on the server)
→ `CreatePermission` (authorize the peer's IP) → data via `Send`/`Data`
indications, upgraded to **ChannelBind** (a 4-byte header per packet instead
of a full STUN header — bandwidth matters on relays). TURN servers usually
also listen on **TCP 443** so the traffic can sneak through corporate
firewalls disguised as HTTPS. Media through TURN is still DTLS-encrypted;
the relay sees only ciphertext.

Our `config.js` lists Google STUN + the OpenRelay TURN service; production
would run its own [coturn](https://github.com/coturn/coturn).

---

## 3. ICE — the algorithm that picks the path (RFC 8445)

ICE (Interactive Connectivity Establishment) is what actually decides
same-network vs punched vs relayed. Both browsers run it automatically; here
is what happens under the hood.

**Step 1 — Gather candidates** (each is a `(transport, IP, port)` you might be
reachable at):

| Type | How obtained | Example |
|---|---|---|
| `host` | Your own interfaces | `10.79.57.113:53211` |
| `srflx` (server-reflexive) | STUN binding | `203.0.113.7:41822` |
| `relay` | TURN allocation | `171.x.x.x:60111` (on the relay) |

**Step 2 — Exchange** candidate lists through the signaling server, inside SDP
(`a=candidate:…` lines) — this is the *only* role signaling plays here.

**Step 3 — Prioritize.** Each candidate gets a 32-bit priority:

```
priority = 2²⁴ × type-preference        (host=126 > srflx=100 > relay=0)
         + 2⁸  × local-preference       (prefer some interfaces over others)
         + (256 − component-id)
```

Candidates are paired (every local × every remote, same transport), and pairs
sorted by `2³² × min(P_a,P_b) + 2 × max(P_a,P_b) + (controlling side higher?1:0)`
— so "direct beats punched beats relayed" falls out of the arithmetic
automatically.

**Step 4 — Connectivity checks.** Down the sorted checklist, each side sends
**STUN Binding Requests** *to the peer* (not to a server this time), signed
with credentials exchanged in SDP (`a=ice-ufrag` / `a=ice-pwd`,
MESSAGE-INTEGRITY = HMAC-SHA1) so strangers can't hijack the check. A
request+response in both directions = pair **succeeded**. These very packets
are simultaneously doing the hole punching of §2.4. Receiving a check from an
address you haven't sent one to yet triggers an immediate reverse check
("triggered checks") — that's the simultaneity requirement made robust.

**Step 5 — Nominate.** The *controlling* side (the offerer — our host) picks
the best succeeded pair, marks a final check with the `USE-CANDIDATE` flag,
and media switches to that pair. STUN keepalives (consent freshness, RFC 7675)
re-verify the path every few seconds; if the network changes (Wi-Fi → 4G), an
**ICE restart** regathers and renegotiates without tearing down the call.

You can watch every candidate, check, and the winning pair live in
`chrome://webrtc-internals` while a session runs — the single best learning
tool for all of this.

---

## 4. After the path exists — securing and streaming

The nominated UDP path now carries three protocols **multiplexed on one port**
(distinguished by the first byte of each packet — RFC 7983):

### 4.1 DTLS handshake (RFC 6347)
TLS adapted for datagrams (adds sequence numbers + retransmission to the
handshake, since UDP reorders/drops). Both browsers generated self-signed
certificates; each SDP carried the certificate's SHA-256 **fingerprint**
(`a=fingerprint:…`). After the handshake, each side checks the peer
certificate against the fingerprint from signaling — this pins the encryption
to the signaling exchange and is why a tamper-proof signaling server matters.
No certificate authority is involved.

### 4.2 SRTP for the screen video (RFC 3711, keys via DTLS-SRTP RFC 5764)
Video frames are encoded (VP8/VP9/H.264 — negotiated in SDP; our `contentHint
= 'text'` biases the encoder for legible text) and packetized into **RTP**:
sequence number (detect loss), timestamp (reorder/schedule), SSRC (stream id),
payload — then encrypted as SRTP.

Alongside runs **RTCP** feedback, which is where the "algorithms" live:

- **NACK** — "I missed sequence 4711, resend it."
- **PLI** (Picture Loss Indication) — "too broken, send me a fresh keyframe."
- **Transport-wide congestion control feedback** — per-packet arrival times.

### 4.3 The bandwidth algorithm: Google Congestion Control (GCC)
The sender continuously answers "how many bits/second can this path take?"
using two estimators, taking the **minimum**:

1. **Delay-based:** a Kalman-ish filter watches the *trend* of one-way delay.
   Rising delay = a router queue somewhere is filling = back off *before*
   packets drop (this is what keeps latency low).
2. **Loss-based:** >10% loss → multiplicative decrease; <2% → gentle ~5%/s
   increase (AIMD, like TCP's spirit but rate-based).

The result drives the encoder's target bitrate in real time. Our
`maxBitrate = 6 Mbps` caps it from above; our `degradationPreference =
'maintain-resolution'` tells the encoder to shed *framerate*, not sharpness,
when GCC lowers the budget. The viewer's `playoutDelayHint = 0` shrinks the
receive-side jitter buffer — normally it delays frames slightly to smooth out
network jitter; we trade that smoothness for immediacy.

### 4.4 SCTP for the control channel (RFC 8831)
Mouse/keyboard events ride a **DataChannel** = SCTP (Stream Control
Transmission Protocol, originally a telecom signaling transport) encapsulated
*inside* DTLS over the same UDP port. SCTP gives us message boundaries,
multiple streams, and per-channel choices of ordered/unordered,
reliable/unreliable. We use one channel, `ordered: true`, fully reliable — a
lost "mouse up" must be retransmitted, and out-of-order clicks would be chaos.

---

## 5. The tunnel: how `trycloudflare.com` reaches a laptop with no public IP

`cloudflared` solves NAT for the *signaling server* the same way WebRTC solves
it for media — **the laptop dials out**:

1. `cloudflared` opens persistent outbound **QUIC** (UDP 7844, HTTP/3-era
   transport) connections to Cloudflare's nearest edge and registers the
   random hostname.
2. A viewer anywhere resolves `…trycloudflare.com` (DNS → Cloudflare edge),
   connects with normal **HTTPS/WSS on 443**.
3. The edge looks up which tunnel owns that hostname and forwards the request
   *down the already-open outbound connection* to your laptop → to
   `localhost:8080`.

No port forwarding, because nothing ever connects inbound to the laptop — the
laptop's own outbound connection is the road in. (Same principle as ngrok,
and as TURN.) Bonus: the public leg is HTTPS, which browsers require for
`getDisplayMedia` and which upgrades our WebSocket to WSS automatically.

---

## 6. And the actual *routing* — how packets cross the internet at all

Once a packet has a public destination IP, classic IP routing takes over
(nothing WebRTC-specific):

- Your device checks its **routing table**: not my subnet → send to the
  **default gateway** (your router). See it: `ip route`.
- Your router does the same toward your ISP. Each hop, the router looks up the
  destination in its forwarding table, picks the **longest matching prefix**,
  decrements TTL, forwards.
- Between ISPs, routes are learned via **BGP** (Border Gateway Protocol) —
  the internet's routing algorithm, a path-vector protocol where networks
  advertise "I can reach prefix X via path Y" to their neighbors.
- Watch your actual path: `traceroute 8.8.8.8` (it works by sending packets
  with TTL 1, 2, 3… and collecting the "TTL expired" errors from each hop).

So end to end, a single tap on the tab traverses: Wi-Fi frame → tablet's
router (NAT) → carrier CGNAT → BGP-routed hops → (direct to laptop's NAT, or
via TURN relay) → laptop → host page → agent → xdotool → cursor moves. Tens
of milliseconds, typically 5–15 router hops.

---

## 7. Build-it-from-raw roadmap

The order I'd implement (and what you'll learn at each step):

1. **TCP chat server** with raw sockets (`net` in Node) — sockets, framing.
2. **WebSocket server from scratch** (no `ws`): parse the HTTP Upgrade, do the
   `Sec-WebSocket-Accept` SHA-1 dance, decode frames — RFC 6455. ~200 lines.
3. **STUN client from scratch** over `dgram` (UDP): build the binding request
   binary yourself, parse XOR-MAPPED-ADDRESS — RFC 8489. ~80 lines. Now you
   can print your own public IP:port.
4. **UDP hole-punch demo**: two laptops on different networks + your step-3
   client + a 30-line "introducer" server that swaps their addresses. When a
   raw `dgram` packet crosses two NATs, you have personally reproduced the
   core magic of AnyDesk/WebRTC/online games.
5. **Minimal ICE**: candidates, pairing, checks with retransmission — read
   RFC 8445 §6; implement just enough for two candidates each.
6. **Media**: here, stop hand-rolling — use the browser's WebRTC (what this
   project does) or a library (`aiortc` for Python, Pion for Go, libwebrtc
   for C++). DTLS+SRTP+GCC from scratch is a multi-year project.

**Key RFCs** (free at rfc-editor.org): 6455 WebSocket · 8489 STUN · 8656 TURN ·
8445 ICE · 4787 NAT behaviors · 8866 SDP · 5764 DTLS-SRTP · 3711 SRTP ·
8831 DataChannels · 7675 consent · plus the `draft-ietf-rmcat-gcc` congestion
control draft.

**Best debugging tools**: `chrome://webrtc-internals` (live candidates, pairs,
bitrate graphs), Wireshark with filter `stun || dtls`, `ip route`, `ip neigh`,
`traceroute`, `sudo tcpdump -i any udp and port 19302`.
