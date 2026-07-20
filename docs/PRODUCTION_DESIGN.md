# RemoteLink — Production / Industry Design

*How to take the prototype to something a company can deploy: unique permanent
IDs, mandatory login, password recovery, per-device access passwords, and real
privacy — with no third-party servers.*

---

## 0. The contradiction, resolved first

You asked for **login accounts + globally unique IDs + password reset**, and
also **"without servers"**. Those cannot both hold literally:

| Requirement | Why it needs a server |
|---|---|
| **Globally unique ID** | Uniqueness needs one authority to allocate it. Two offline devices can always pick the same number. |
| **Login before access** | Something must verify the password and refuse the unauthenticated. If the check runs only in the app, a patched app skips it. |
| **Password reset** | Recovery requires an out-of-band channel + state you don't control locally. |
| **Reaching a peer across the internet** | ~90% of machines are behind NAT and cannot be dialled directly. A rendezvous point is physics, not a design choice. (See [NETWORKING_DEEP_DIVE.md](NETWORKING_DEEP_DIVE.md).) |

**What is achievable — and is what "no servers / privacy" should mean:**

> **One small server that YOU own and host, which can never see your screen,
> your keystrokes, or your passwords.**

- **No vendor servers.** Unlike AnyDesk/TeamViewer, nothing routes through a
  third party. You run it on-prem or in your own cloud tenancy.
- **Zero-knowledge.** The server stores password *verifiers*, never passwords;
  it relays *encrypted* handshakes, never media.
- **Tiny.** It carries no video — a $5 VPS or one small on-prem VM serves
  thousands of users (see the capacity notes in §9).
- **Air-gapped mode** for factory/industrial LANs: no internet server at all
  (§8).

Everything below assumes that model.

---

## 1. Architecture

```
        ┌──────────────────────── YOUR INFRASTRUCTURE ────────────────────────┐
        │                                                                     │
        │   Identity + Signaling server        coturn (TURN relay)            │
        │   ├─ accounts (verifiers only)       └─ sees only ciphertext        │
        │   ├─ unique ID allocation                                           │
        │   ├─ device pubkey registry                                         │
        │   └─ relays SDP/ICE (opaque)                                        │
        └────────▲───────────────────────────────────▲────────────────────────┘
                 │ login (OPAQUE/SSO) + signaling     │
                 │                                    │
          ┌──────┴───────┐                    ┌───────┴──────┐
          │  Device A    │◄══ E2E encrypted ══►│  Device B    │
          │  (keypair in │    screen + input   │  (keypair in │
          │  OS keystore)│    — never via srv   │  OS keystore)│
          └──────────────┘                     └──────────────┘
```

The server is an **introducer and a bouncer**, never a conduit for content.

---

## 2. Identity: unique permanent IDs

**Device keypair.** On first launch the app generates an **Ed25519 keypair**
stored in the OS keystore (Windows DPAPI / macOS Keychain / Linux Secret
Service). The private key never leaves the device.

**ID allocation (server-side, guaranteed unique).**

1. App authenticates the user (§3), then sends its **public key**.
2. Server allocates the next free ID from a **database with a UNIQUE
   constraint** — atomic, so collisions are impossible (unlike the prototype's
   random 9-digit guess).
3. Server binds `id → (public_key, owner_user_id)` permanently.

**Why a keypair beats the prototype's shared secret:** ownership is proven by
*signing a server challenge*, so the secret is never transmitted and a breached
server database cannot be used to impersonate a device.

```sql
CREATE TABLE devices (
  id            CHAR(9) PRIMARY KEY,          -- the permanent ID
  public_key    BYTEA NOT NULL UNIQUE,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  name          TEXT,                          -- "Lab PC 3"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
```

ID format: 9 digits for humans, or namespaced for industry
(`ACME-04412`). Permanent across reinstall **if** the keypair is backed up or
the user re-claims the device while logged in; otherwise a reinstall gets a new
ID and an admin can re-map it.

---

## 3. Login — no access without it

**Enforced server-side.** The app shows nothing and can call nobody until it
holds a valid session token. Never rely on the UI to gate access: the *server*
refuses `register`, `call`, and `signal` without a valid token. (The prototype's
`join` check was the right instinct; extend it to every message.)

**Password handling: zero-knowledge (OPAQUE, or SRP-6a).**
The password never reaches the server — not even hashed-in-transit. The client
proves knowledge of it; the server stores only a verifier. Consequences:

- A full database breach reveals **no passwords** (nothing to crack offline).
- Your own admins cannot read user passwords. Good for GDPR/SOC2 posture.

If OPAQUE is too much lift for v1, the acceptable fallback is: **Argon2id**
hash server-side (memory-hard; *not* PBKDF2/SHA-256 as the prototype uses),
over TLS, with strict rate limiting.

**Sessions:** short-lived access token (~15 min) + rotating refresh token,
**bound to the device public key** so a stolen token is useless off-device.

**For industry, the real answer is SSO.** Most companies will require
**OIDC/SAML** (Okta, Azure AD, Google Workspace). Then:
- No passwords in your system at all — and no password-reset problem.
- Central offboarding: disable in the IdP → RemoteLink access dies instantly.
- MFA comes free from the IdP.

> **Recommendation:** SSO/OIDC as the primary path for industry; OPAQUE
> password login for standalone/SMB deployments.

---

## 4. Password recovery ("when they lose their password")

Recovery **always** needs an out-of-band channel. Ranked for your context:

| Method | Needs | Verdict |
|---|---|---|
| **SSO / IdP** | Company IdP | ✅ Best — reset is the IdP's problem, not yours |
| **Admin reset** | An admin console | ✅ Best fit for industry; no email infrastructure |
| **Recovery codes** | Nothing! 10 one-time codes shown at signup, stored offline | ✅ Great "no-server-email" answer |
| **Email OTP** | SMTP (the thing that bit us earlier) | ⚠️ Works, but needs a mail sender |
| **Security questions** | — | ❌ Weak, don't |

**Important and reassuring:** in this design the login password **does not
encrypt any content** — screen data is protected by per-session WebRTC keys,
not by the password. So a password reset **loses nothing**. (Contrast with
end-to-end encrypted storage products, where reset = data loss.) After reset,
the user re-authenticates and their device keypair — hence their **permanent ID
— survives untouched.**

Flow (admin reset): admin marks account for reset → user's sessions revoked →
user sets a new password via one-time link/code → devices re-attest with their
existing keypairs → same IDs, no re-provisioning.

---

## 5. Per-device access password (set by the user)

This is the "can someone connect to *this* machine" gate, distinct from login.

**Key upgrade over the prototype: verify it peer-to-peer, not on the server.**
Today the server stores `accessHash` and checks it — meaning the server *could*
authorize a connection. In production:

- The access password is hashed with **Argon2id and stored only on the device**.
- The **caller proves knowledge of it directly to the callee** over the
  encrypted channel — ideally a **PAKE (SPAKE2/OPAQUE)** so neither the password
  nor a crackable hash ever crosses the wire, and the server learns nothing.
- The server's only job is to introduce; it **cannot** grant access to a machine.

Per-device policy the user/admin controls:
- **Prompt-to-approve** (default; the Accept/Decline we already have),
- **Unattended access** with access password (for servers/kiosks),
- **Allowlist**: only these IDs/users may even ring this device,
- Lockout after N failed attempts, and a physical-presence requirement option.

---

## 6. Privacy: making the server untrusted

WebRTC already encrypts media end-to-end (DTLS-SRTP). But there's a subtle hole
the prototype has: **the DTLS fingerprints are exchanged through the server**,
so a malicious/compromised server could swap them and MITM the session.

**Fix — bind the handshake to device keys:**

1. Each device **signs its SDP (including the DTLS fingerprint)** with its
   Ed25519 private key.
2. The peer verifies that signature against the public key it has for that ID
   (from the server, pinned **TOFU** on first contact, or issued by your
   company PKI).
3. Show a **verification code / SAS** (like Signal's safety numbers) that both
   users can compare out-of-band for high-security sessions.

Result: even a fully compromised server **cannot** read or inject into a
session — it can only deny service. That is what "privacy" should mean here,
and it's what makes it defensible in industry.

Also: **self-host coturn** (never the free public relay — it's shared,
rate-limited, and a third party); it only ever sees ciphertext.

---

## 7. What "industry-grade" adds beyond the above

- **Audit log** (essential, often legally required): who connected to which
  device, when, from where, duration, files transferred. Append-only, exportable
  to SIEM. The server can log this *without* seeing content.
- **RBAC / groups**: technicians → lab machines; contractors → one device,
  business hours only.
- **Device inventory & naming**, online/offline status, grouping.
- **Session recording** (with consent banner) for compliance.
- **Deployment**: MSI/GPO/Intune (Windows), PKG/MDM (macOS), .deb/.rpm (Linux).
  **Code signing + notarization** is mandatory — unsigned binaries won't pass IT.
- **Signed auto-update** channel.
- **Consent & indicators**: persistent "you are being viewed" banner, block
  input option, instant kill-switch.
- **HA**: stateless signaling nodes behind a load balancer with **Redis** for
  presence (the prototype's in-memory `online` map is single-process only).

---

## 8. Air-gapped / LAN-only mode (real "no servers")

For factory floors and secure sites, this is the one configuration where
**literally zero servers** works:

- Peers discover each other on the LAN via **mDNS** (no rendezvous needed —
  they're on the same broadcast domain).
- Direct ICE host candidates connect immediately; no STUN, no TURN.
- Identity: pre-provisioned device certificates from your PKI, or TOFU pinning.
- Accounts: local admin-provisioned, or the LAN's own directory.

Ship this as a deployment mode — it's a genuine differentiator for industrial
customers and satisfies "no servers" honestly.

---

## 9. Capacity (why the small server is fine)

Media is peer-to-peer, so the server stays idle after introductions:

- **Signaling**: thousands of idle WebSockets per modest node; scale out
  horizontally with Redis presence.
- **The real cost is TURN** (~15% of connections relay video). Budget bandwidth
  there; everything else is rounding error.
- Sessions remain **1:1** by design (see the pairing logic). Many-viewers-on-one-screen
  is a different product (needs N connections or an SFU) — a deliberate later choice.

---

## 10. Gap list: prototype → production

| # | Prototype today | Production |
|---|---|---|
| 1 | Random 9-digit ID, may collide; shared "secret" | DB-allocated unique ID bound to an **Ed25519 keypair** in the OS keystore |
| 2 | No login on the app; anyone with the URL uses it | **Mandatory login**, enforced on *every* server message |
| 3 | PBKDF2-SHA256 password hash on server | **OPAQUE/SRP** (zero-knowledge) or Argon2id + **SSO/OIDC** for industry |
| 4 | No password recovery | **SSO / admin reset / recovery codes** (no email needed) |
| 5 | Server stores & checks device access password | **Argon2id local only**, verified **peer-to-peer via PAKE** |
| 6 | DTLS fingerprints trusted from server (MITM-able) | **Sign SDP with device key** + TOFU/PKI pinning + SAS code |
| 7 | Free public TURN (third party) | **Self-hosted coturn** |
| 8 | State in memory + `peers.json` file | **Postgres + Redis**, HA, backups |
| 9 | No rate limiting | Throttle register/call/login; lockouts; ID-enumeration defence |
| 10 | No audit trail | Append-only audit log → SIEM |
| 11 | Unsigned AppImage | Signed/notarized MSI, PKG, deb/rpm + auto-update |

---

## 11. Suggested build order

1. **Postgres + accounts + unique-ID allocation** with keypair attestation, and
   the login gate enforced on every message. *(Biggest correctness win.)*
2. **Device access password moved off the server**, verified peer-to-peer.
3. **SDP signing + key pinning** — this is what makes privacy real.
4. **Self-hosted coturn** + rate limiting.
5. **SSO/OIDC**, admin console, audit log, RBAC.
6. **Signed installers** + auto-update.
7. **LAN-only mode** for air-gapped sites.

Steps 1–3 convert it from a prototype into something defensible; 4–6 are what
IT departments will demand before deployment.
