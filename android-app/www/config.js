/*
 * Shared RTC configuration for host + viewer.
 *
 * STUN lets each peer discover its public IP:port so the two sides can try a
 * DIRECT peer-to-peer connection across different networks — this is what
 * makes "any network, any distance" work for ~85% of connections.
 *
 * For the other ~15% (symmetric NAT / strict firewalls) you MUST add a TURN
 * server, which relays the encrypted stream when direct fails. Stand one up
 * with coturn, then uncomment and fill in the block below. Without TURN, some
 * network pairs simply won't connect.
 */
window.RTC_CONFIG = {
  iceServers: [
    // STUN — helps most connections go direct.
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },

    // TURN relay — used when a direct link can't be punched (strict/mobile NAT).
    // NOTE: the old "openrelay.metered.ca" host became IPv6-only and failed on
    // IPv4 networks; "staticauth.openrelay.metered.ca" is the IPv4 endpoint.
    // These are shared free relays for TESTING. For production/industry, run
    // your OWN coturn and replace these (see docs/PRODUCTION_DESIGN.md §6).
    {
      urls: [
        'turn:staticauth.openrelay.metered.ca:80',
        'turn:staticauth.openrelay.metered.ca:443',
        'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
        'turns:staticauth.openrelay.metered.ca:443'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 4
};

// Force every connection through the TURN relay — set to true to TEST that your
// relay works (if it connects with this on, TURN is fine and the problem is NAT;
// if it fails with this on, your TURN server is the problem).
window.FORCE_RELAY = false;
if (window.FORCE_RELAY) window.RTC_CONFIG.iceTransportPolicy = 'relay';

// ---- Shared signaling server -----------------------------------------------
// For two installed apps on DIFFERENT machines to find each other, they must
// both talk to ONE shared server. Set that server's URL once (in the app's
// login screen → "Server") and it's saved here. If unset, the app uses its own
// built-in server — fine for same-machine testing, but two devices then never
// share a rendezvous and see "no machine with that id".
//
// SERVER_BASE is the HTTP(S) origin used for login (/api/*); SIGNAL_URL is the
// matching ws(s):// endpoint for signaling. The input agent always stays local
// (ws://127.0.0.1:9091), so control still works on each machine.
(function () {
  var saved = '';
  try { saved = localStorage.getItem('rl_server') || ''; } catch (e) {}
  saved = saved.replace(/\/+$/, '');   // strip trailing slash

  if (saved) {
    window.SERVER_BASE = saved;                                   // e.g. https://my-server.onrender.com
    window.SIGNAL_URL = saved.replace(/^http/, 'ws');            // -> wss://my-server.onrender.com
  } else {
    window.SERVER_BASE = '';                                      // same origin (built-in server)
    window.SIGNAL_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }
})();
