/*
 * RemoteLink — unified peer app.
 *
 * One page, two roles. Every machine runs this. You have a permanent ID (kept
 * in this browser's localStorage) and an access password. You can CALL another
 * ID to view/control it, or ACCEPT an incoming call and share your screen.
 * During a call either side can SWAP so the roles reverse.
 *
 * Role while in a call:
 *   sharer     — captures this screen, sends it, injects the peer's input via
 *                the local agent (ws://127.0.0.1:9091 → xdotool)
 *   controller — shows the remote screen, captures mouse/keyboard, sends it
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ---- Connect code: encode {server, id, access} as a decimal NUMBER --------
  // Lets the host share one numeric code instead of a URL. The tunnel wrapper
  // (https:// … .trycloudflare.com) is stripped to keep it as short as possible;
  // it's still long-ish (the random subdomain can't be compressed away), so use
  // Copy/share rather than hand-typing.
  function makeConnectCode(server, id, access) {
    server = String(server || '').replace(/\/+$/, '');
    let head = '0', body = server;
    const m = server.match(/^https:\/\/(.+)\.trycloudflare\.com$/);
    if (m) { head = '1'; body = m[1]; }              // '1' = trycloudflare, store subdomain only
    const payload = head + body + '\x00' + String(id).replace(/\s/g, '') + '\x00' + (access || '');
    let hex = '';
    for (let i = 0; i < payload.length; i++) hex += payload.charCodeAt(i).toString(16).padStart(2, '0');
    return BigInt('0x' + hex).toString(10);
  }
  function parseConnectCode(code) {
    try {
      const digits = String(code).replace(/\D/g, '');
      if (!digits) return null;
      let hex = BigInt(digits).toString(16); if (hex.length % 2) hex = '0' + hex;
      let payload = '';
      for (let i = 0; i < hex.length; i += 2) payload += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      const parts = payload.split('\x00'); if (parts.length < 2) return null;
      const head = parts[0][0], body = parts[0].slice(1);
      const server = head === '1' ? 'https://' + body + '.trycloudflare.com' : body;
      const id = parts[1].replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
      return { server, id, access: parts[2] || '' };
    } catch (e) { return null; }
  }

  // ---- Identity (permanent, per this install/browser) -----------------------
  function genId() {
    let s = '';
    for (let i = 0; i < 9; i++) s += Math.floor(Math.random() * 10);
    return s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
  }
  function genPw() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 6; i++) s += cs[Math.floor(Math.random() * cs.length)];
    return s;
  }
  // The device secret proves this install owns its ID. The ID itself is
  // ALLOCATED BY THE SERVER on first register (guaranteed unique) — we just
  // remember what it gives us.
  let myId = localStorage.getItem('rl_id') || '';
  let mySecret = localStorage.getItem('rl_secret');
  let myAccess = localStorage.getItem('rl_access');
  if (!mySecret) {
    mySecret = genPw() + genPw() + genPw() + genPw();   // 24 chars
    localStorage.setItem('rl_secret', mySecret);
  }
  if (!myAccess) { myAccess = genPw(); localStorage.setItem('rl_access', myAccess); }

  let token = localStorage.getItem('rl_token') || '';

  $('myId').textContent = myId || '— — —';
  $('myAccess').value = myAccess;

  // ---- UI helpers -----------------------------------------------------------
  const netDot = $('netDot'), netText = $('netText');
  function setNet(cls, text) { netDot.className = 'dot ' + cls; netText.textContent = text; }

  // ---- PWA install prompt (Android / desktop Chrome & Edge) -----------------
  let installEvent = null;
  const installBtn = $('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); installEvent = e; installBtn.style.display = 'inline-block';
  });
  installBtn.onclick = async () => {
    if (!installEvent) return;
    installBtn.style.display = 'none';
    installEvent.prompt();
    await installEvent.userChoice; installEvent = null;
  };
  window.addEventListener('appinstalled', () => { installBtn.style.display = 'none'; });
  function homeNote(t) { $('homeNote').textContent = t || ''; }
  const logLines = [];
  function log(...a) {
    logLines.unshift(a.join(' '));
    if (logLines.length > 120) logLines.length = 120;
    $('log').textContent = logLines.join('\n');
  }
  const ERR = {
    'unknown-id': 'No machine with that ID has ever connected.',
    'peer-offline': 'That machine is offline right now.',
    'peer-busy': 'That machine is already in a session.',
    'access-required': 'Enter the remote machine\'s access password.',
    'wrong-access-password': 'Wrong access password.',
    'cannot-call-self': 'That\'s your own ID.',
    'not-registered': 'Still connecting to the server — try again in a moment.'
  };

  // ---- Signaling socket -----------------------------------------------------
  // The signaling socket is ONLY for setup/renegotiation. Screen video and
  // control flow peer-to-peer and are independent of it — so if it drops we
  // reconnect quietly and KEEP the active session alive (tearing it down was
  // dropping calls whenever the tunnel idled the socket out).
  let ws, wsReady = false, pingTimer = null;
  function connectWS() {
    ws = new WebSocket(window.SIGNAL_URL);
    ws.onopen = () => { register(); startPing(); };
    ws.onclose = () => {
      wsReady = false; clearInterval(pingTimer);
      setNet(role ? 'wait' : 'err', role ? 'signaling reconnecting…' : 'offline — reconnecting');
      setTimeout(connectWS, 2000);   // do NOT end an in-progress session
    };
    ws.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
  }
  // Keepalive so proxies/tunnels don't close the socket for being idle.
  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sendWS({ type: 'ping' }), 25000);
  }
  function register() {
    ws.send(JSON.stringify({ type: 'register', token, id: myId, secret: mySecret, access: myAccess }));
  }
  function sendWS(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // ---- Call state -----------------------------------------------------------
  let role = null;              // 'sharer' | 'controller'
  let peerId = null;
  let pc = null, controlChannel = null, localStream = null;
  let agent = null;             // local input agent (sharer side)

  function handleSignal(msg) {
    switch (msg.type) {
      case 'registered':
        // The server hands us our permanent ID (allocating one if we had none).
        myId = msg.id; localStorage.setItem('rl_id', myId);
        $('myId').textContent = myId;
        wsReady = true; setNet('ok', 'online · ID ' + myId);
        log('Registered as ' + myId + (msg.user ? ' (' + msg.user + ')' : ''));
        maybeAutoConnect();   // if we arrived via a connect code, dial the target now
        break;
      case 'register-failed':
        if (msg.reason === 'auth-required') signOut('Session expired — sign in again.');
        else if (msg.reason === 'id-owned') {
          // This ID isn't ours — drop it and let the server allocate a fresh one.
          myId = ''; localStorage.removeItem('rl_id'); register();
        } else setNet('err', 'registration failed: ' + msg.reason);
        break;
      case 'displaced':
        // Another live connection registered our ID (e.g. two devices collided
        // on the same ID after the server's storage reset). Self-heal: drop the
        // ID so the reconnect gets a fresh unique one instead of getting stuck.
        // (If you deliberately opened the app in a second window, this simply
        // gives this window its own ID — both keep working.)
        log('ID was in use elsewhere — getting a fresh unique ID.');
        myId = ''; localStorage.removeItem('rl_id');
        setNet('wait', 'reassigning ID…');
        // The server closes this socket; our reconnect then registers with an
        // empty ID, so the server allocates a new unique one automatically.
        break;
      case 'ringing':
        homeNote('Ringing ' + msg.peer + '… waiting for them to accept.');
        break;
      case 'incoming':
        showIncoming(msg.peer);
        break;
      case 'declined':
        homeNote('They declined the connection.');
        break;
      case 'accepted':      // we are the caller → we control, they share
      case 'start': {       // we are the callee → we share, they control
        peerId = msg.peer;
        beginCall(msg.youShare ? 'sharer' : 'controller');
        break;
      }
      case 'signal':
        onPeerSignal(msg.payload);
        break;
      case 'swap':
        doSwap(false);
        break;
      case 'hangup':
        endSession(msg.reason || 'peer-left');
        break;
      case 'error':
        homeNote(ERR[msg.reason] || ('Error: ' + msg.reason));
        break;
    }
  }

  // After a connect-code login, dial the encoded target automatically.
  function maybeAutoConnect() {
    let t; try { t = JSON.parse(localStorage.getItem('rl_pending_target') || 'null'); } catch (e) {}
    localStorage.removeItem('rl_pending_target');
    if (!t || !t.id) return;
    $('targetId').value = t.id; $('targetAccess').value = t.access || '';
    homeNote('Connecting from code…');
    sendWS({ type: 'call', targetId: t.id.trim(), access: (t.access || '').trim() });
  }

  // ---- Home actions ---------------------------------------------------------
  $('copyId').onclick = () => {
    navigator.clipboard && navigator.clipboard.writeText(myId).then(
      () => { $('copyId').textContent = 'Copied'; setTimeout(() => $('copyId').textContent = 'Copy', 1200); },
      () => {}
    );
  };
  $('regenPw').onclick = () => {
    if (isFixed()) return;   // fixed = don't change it
    myAccess = genPw(); $('myAccess').value = myAccess;
    localStorage.setItem('rl_access', myAccess); sendWS({ type: 'set-access', access: myAccess });
  };

  // ---- Fixed toggle: keep ID + access password the same every launch --------
  function isFixed() { return localStorage.getItem('rl_fixed') === '1'; }
  const fixedChk = $('fixedChk');
  fixedChk.checked = isFixed();
  applyFixedUI();
  function applyFixedUI() {
    const on = fixedChk.checked;
    $('regenPw').disabled = on;
    $('myAccess').readOnly = on;
  }
  fixedChk.onchange = () => {
    localStorage.setItem('rl_fixed', fixedChk.checked ? '1' : '0');
    applyFixedUI();
  };
  // If the user edits the password manually (when not fixed), remember it.
  $('myAccess').addEventListener('change', () => {
    if (isFixed()) return;
    myAccess = $('myAccess').value.trim(); localStorage.setItem('rl_access', myAccess);
    sendWS({ type: 'set-access', access: myAccess });
  });

  // ---- "Make this device the server" (desktop app only) ---------------------
  // The tunnel needs a native process, so this only appears in the installed
  // app. It starts cloudflared and shows the public URL right here — no terminal.
  const desktop = window.RemoteLinkDesktop;
  if (desktop && desktop.startTunnel) {
    $('serverCard').style.display = 'block';
    let tunnelUrl = '', connectCode = '';
    desktop.onTunnel((data) => {
      if (data && data.url) {
        tunnelUrl = data.url;
        connectCode = makeConnectCode(tunnelUrl, myId, $('myAccess').value.trim());
        $('tunnelUrl').textContent = tunnelUrl;
        $('connectCode').textContent = connectCode;
        $('tunnelUrlBox').style.display = 'block';
        $('tunnelBtn').textContent = '🌐 Reachable — share the connect code below';
      } else {
        $('tunnelUrlBox').style.display = 'none';
        $('tunnelBtn').textContent = '🌐 Make this device reachable';
      }
    });
    $('tunnelBtn').onclick = async () => {
      $('tunnelBtn').textContent = 'Starting tunnel… (~15s)';
      const r = await desktop.startTunnel();
      if (r && r.error) $('tunnelBtn').textContent = '⚠ ' + r.error;
    };
    const copyTo = (btn, get) => { btn.onclick = () => {
      const v = get(); if (!v) return;
      navigator.clipboard && navigator.clipboard.writeText(v).then(() => {
        const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = t, 1200);
      }, () => {});
    }; };
    copyTo($('copyUrl'), () => tunnelUrl);
    copyTo($('copyCode'), () => connectCode);

    // Show this machine's LAN address so same-network clients can use it as the
    // server with no tunnel/internet at all.
    let lanUrl = '', lanCode = '';
    if (desktop.getLanUrls) desktop.getLanUrls().then((urls) => {
      if (urls && urls.length) {
        lanUrl = urls[0];
        lanCode = makeConnectCode(lanUrl, myId, $('myAccess').value.trim());
        $('lanUrl').textContent = lanUrl;
        $('lanCode').textContent = lanCode;
        $('lanBox').style.display = 'block';
      }
    });
    copyTo($('copyLan'), () => lanUrl);
    copyTo($('copyLanCode'), () => lanCode);
  }
  $('connectBtn').onclick = () => {
    const targetId = $('targetId').value.trim();
    if (!/^\d{3} \d{3} \d{3}$/.test(targetId)) return homeNote('Enter an ID like 123 456 789.');
    homeNote('Connecting…');
    sendWS({ type: 'call', targetId, access: $('targetAccess').value.trim() });
  };
  $('targetId').addEventListener('input', (e) => {
    // auto-format as 3-3-3
    let d = e.target.value.replace(/\D/g, '').slice(0, 9);
    e.target.value = d.replace(/(\d{3})(\d{0,3})(\d{0,3})/, (m, a, b, c) => [a, b, c].filter(Boolean).join(' '));
  });

  // ---- Incoming-call modal --------------------------------------------------
  function showIncoming(from) {
    $('callerId').textContent = from;
    $('incoming').style.display = 'grid';
  }
  $('acceptBtn').onclick = () => { $('incoming').style.display = 'none'; sendWS({ type: 'accept' }); };
  $('declineBtn').onclick = () => { $('incoming').style.display = 'none'; sendWS({ type: 'decline' }); };

  // ---- Session lifecycle ----------------------------------------------------
  function beginCall(asRole) {
    role = asRole;
    $('home').style.display = 'none';
    $('session').style.display = 'block';
    $('overlay').style.display = 'grid';
    $('overlay').textContent = 'Connecting…';
    connectAgentIfSharer();
    buildPeer();
  }

  let pendingCandidates = [];   // ICE candidates that arrive before remoteDescription
  let remoteReady = false;

  async function buildPeer() {
    teardownPeer();
    pendingCandidates = []; remoteReady = false;
    pc = new RTCPeerConnection(window.RTC_CONFIG);
    pc.onicecandidate = (e) => { if (e.candidate) sendWS({ type: 'signal', payload: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      log('connection: ' + st);
      if (st === 'connected') { updateRoleUI(); reportPath(); }
      else if (st === 'disconnected') {
        // A transient network blip — WebRTC often recovers on its own. Nudge it
        // with an ICE restart after a moment instead of tearing the call down.
        log('link wobbled — attempting to recover…', 'warn');
        if (role === 'sharer') setTimeout(() => { if (pc && pc.connectionState !== 'connected') restartIce(); }, 2500);
      }
      else if (st === 'failed') {
        $('overlay').style.display = 'grid';
        $('overlay').textContent = 'Reconnecting…';
        log('ICE failed — restarting.', 'err');
        if (role === 'sharer') restartIce();
      }
    };
    pc.oniceconnectionstatechange = () => log('ICE: ' + pc.iceConnectionState);

    if (role === 'sharer') {
      try {
        const dpr = window.devicePixelRatio || 1;
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 },
                   width: { ideal: Math.round(screen.width * dpr) },
                   height: { ideal: Math.round(screen.height * dpr) } },
          audio: false
        });
      } catch (e) { log('Screen capture denied.'); endSession('capture-denied'); return; }
      localStream.getVideoTracks()[0].contentHint = 'text';
      localStream.getVideoTracks()[0].addEventListener('ended', () => endSession('stopped-sharing'));
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      tuneSender();
      // preview our own shared screen
      const pv = $('preview'); pv.style.display = 'block'; $('remote').style.display = 'none';
      pv.srcObject = localStream; pv.play().catch(() => {});

      controlChannel = pc.createDataChannel('control', { ordered: true });
      wireSharerChannel();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({ type: 'signal', payload: { sdp: pc.localDescription } });
    } else {
      // controller: show remote, receive control channel
      $('preview').style.display = 'none';
      const rv = $('remote'); rv.style.display = 'block';
      pc.ontrack = (e) => {
        rv.srcObject = e.streams[0];
        $('overlay').style.display = 'none';
        if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
        if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
      };
      pc.ondatachannel = (e) => { controlChannel = e.channel; wireControllerChannel(); };
    }
    updateRoleUI();
  }

  function tuneSender() {
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (!s) return;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 5000000;          // 5 Mbps — headroom without overshoot
    p.encodings[0].maxFramerate = 30;
    // 'balanced' lets the encoder trade a little sharpness to keep the cursor
    // responsive under load, instead of holding full resolution and lagging.
    p.degradationPreference = 'balanced';
    s.setParameters(p).catch(() => {});
  }

  async function onPeerSignal(payload) {
    if (!pc) return;
    if (payload.sdp) {
      await pc.setRemoteDescription(payload.sdp);
      remoteReady = true;
      // Flush any candidates that arrived before we had the remote description
      // — dropping these was silently killing the connection.
      for (const c of pendingCandidates) { try { await pc.addIceCandidate(c); } catch (e) {} }
      pendingCandidates = [];
      if (payload.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sendWS({ type: 'signal', payload: { sdp: pc.localDescription } });
      }
    } else if (payload.candidate) {
      if (remoteReady) { try { await pc.addIceCandidate(payload.candidate); } catch (e) {} }
      else pendingCandidates.push(payload.candidate);   // buffer until remote is set
    }
  }

  // Log whether we connected directly or via a TURN relay — the key diagnostic.
  async function reportPath() {
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          const local = stats.get(r.localCandidateId);
          if (local) log('Path: ' + local.candidateType +
            (local.candidateType === 'relay' ? ' (via TURN relay)' : ' (direct P2P)'), 'ok');
        }
      });
    } catch (e) {}
  }

  async function restartIce() {
    if (!pc || role !== 'sharer') return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      sendWS({ type: 'signal', payload: { sdp: pc.localDescription } });
    } catch (e) {}
  }

  function teardownPeer() {
    if (controlChannel) { try { controlChannel.close(); } catch (e) {} controlChannel = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    releaseAllKeys();
    $('remote').srcObject = null; $('preview').srcObject = null;
  }

  function endSession(reason) {
    if (!role && $('session').style.display !== 'block') return;
    teardownPeer();
    if (agent) { try { agent.close(); } catch (e) {} agent = null; }
    role = null; peerId = null;
    $('session').style.display = 'none';
    $('home').style.display = 'block';
    $('incoming').style.display = 'none';
    homeNote(reason && reason !== 'peer-left' ? '' : 'Session ended.');
    if (reason === 'peer-left') homeNote('The other machine disconnected.');
    if (reason === 'stopped-sharing') homeNote('Sharing stopped.');
    kbBtn.disabled = true; fsBtn.disabled = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  $('hangupBtn').onclick = () => { sendWS({ type: 'hangup' }); endSession('you-hung-up'); };

  // ---- Role swap (button removed; kept as a no-op so peer 'swap' messages
  //      from an older build don't break anything) ------------------------------
  function doSwap() { /* disabled */ }

  function updateRoleUI() {
    const controlling = role === 'controller';
    $('roleText').textContent = controlling
      ? '🎮 Controlling ' + (peerId || 'peer')
      : '📡 Sharing your screen with ' + (peerId || 'peer');
    $('screenBox').classList.toggle('controlling', controlling);
    $('modKeys').classList.toggle('show', controlling);
    if (!controlling) releaseArmedMods();
    kbBtn.disabled = !controlling; fsBtn.disabled = !controlling;
    if (role === 'sharer') { $('preview').style.display = 'block'; $('remote').style.display = 'none'; }
    else {
      $('remote').style.display = 'block'; $('preview').style.display = 'none';
      // Keyboard events only fire on the focused element — focus the video so
      // typing works right away (especially important after a role swap).
      setTimeout(() => { try { remote.focus(); } catch (e) {} }, 0);
    }
  }

  // ---- Sharer side: inject peer input via local agent -----------------------
  // The agent (native process on THIS machine) is what actually moves the mouse
  // and types. A browser tab has no agent, so it can share its screen but can't
  // be controlled — we detect that and tell both sides clearly.
  function tellControllerAgentStatus() {
    if (role === 'sharer' && controlChannel && controlChannel.readyState === 'open') {
      const active = !!(agent && agent.readyState === WebSocket.OPEN);
      controlChannel.send(JSON.stringify({ t: 'agent', active }));
      $('roleText').textContent = active
        ? '📡 Sharing your screen — remote control ENABLED'
        : '📡 Sharing your screen — control DISABLED (run the desktop app to allow control)';
    }
  }
  function connectAgentIfSharer() {
    if (role !== 'sharer') { if (agent) { try { agent.close(); } catch (e) {} agent = null; } return; }
    if (agent && agent.readyState === WebSocket.OPEN) return;
    try { agent = new WebSocket('ws://127.0.0.1:9091'); } catch (e) { agent = null; tellControllerAgentStatus(); return; }
    agent.onopen = () => { log('Input agent connected — real control active.', 'ok'); tellControllerAgentStatus(); };
    agent.onclose = agent.onerror = () => { agent = null; tellControllerAgentStatus(); };
    // If it hasn't connected shortly, assume none (browser tab) and report that.
    setTimeout(() => { if (!agent || agent.readyState !== WebSocket.OPEN) tellControllerAgentStatus(); }, 1500);
  }
  function wireSharerChannel() {
    controlChannel.onopen = () => {
      $('overlay').style.display = 'none';
      const s = localStream.getVideoTracks()[0].getSettings();
      if (s.width && s.height) controlChannel.send(JSON.stringify({ t: 'screen', w: s.width, h: s.height }));
      log('Control channel open.');
      tellControllerAgentStatus();
    };
    controlChannel.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (agent && agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify(ev));
      if (ev.t === 'down') log('click @' + ev.x + ',' + ev.y);
      else if (ev.t === 'key' && ev.down) log('key ' + ev.k);
    };
  }

  // ---- Controller side: capture + send input --------------------------------
  const remote = $('remote'), screenBox = $('screenBox'), kb = $('kb');
  const kbBtn = $('kbBtn'), fsBtn = $('fsBtn');
  let hostW = 0, hostH = 0;

  function wireControllerChannel() {
    controlChannel.onopen = () => log('Control channel open — you have control.');
    controlChannel.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.t === 'screen') { hostW = d.w; hostH = d.h; }
        else if (d.t === 'agent') {
          if (d.active) {
            $('roleText').textContent = '🎮 Controlling ' + (peerId || 'peer');
            log('Remote input control is ACTIVE.', 'ok');
          } else {
            $('roleText').textContent = '👁 Viewing ' + (peerId || 'peer') + ' — control unavailable';
            log('⚠ The other device has NO input agent — you can see its screen but cannot control it. It must run the RemoteLink DESKTOP APP (a browser tab cannot be controlled).', 'err');
            $('overlay').style.display = 'grid';
            $('overlay').style.background = 'rgba(7,11,18,.55)';
            $('overlay').innerHTML = '<div style="max-width:420px">👁 View-only<br><span style="font-size:13px;color:#93a6bd">' +
              'The other device opened RemoteLink in a browser, which can\'t receive control. ' +
              'To control it, that machine must run the desktop app (AppImage/.exe) — the browser can only view.</span></div>';
            setTimeout(() => { overlay_clear(); }, 6000);
          }
        }
      } catch (e) {}
    };
    wireInput();
  }
  function overlay_clear() {
    // Let the video show through again after the notice; keep control view.
    if (role === 'controller' && remote.srcObject) $('overlay').style.display = 'none';
  }
  function ctlSend(ev) { if (controlChannel && controlChannel.readyState === 'open') controlChannel.send(JSON.stringify(ev)); }
  function toHostCoords(e) {
    const r = remote.getBoundingClientRect();
    const vw = remote.videoWidth || r.width, vh = remote.videoHeight || r.height;
    const scale = Math.min(r.width / vw, r.height / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offX = (r.width - dispW) / 2, offY = (r.height - dispH) / 2;
    let fx = (e.clientX - r.left - offX) / dispW, fy = (e.clientY - r.top - offY) / dispH;
    fx = Math.min(1, Math.max(0, fx)); fy = Math.min(1, Math.max(0, fy));
    return { x: Math.round(fx * (hostW || vw)), y: Math.round(fy * (hostH || vh)) };
  }
  function tapKey(k) {
    ctlSend({ t: 'key', k, down: true }); ctlSend({ t: 'key', k, down: false });
    releaseArmedMods();   // sticky modifiers apply to just this key, then clear
  }

  let inputWired = false;
  function wireInput() {
    if (inputWired) return; inputWired = true;   // listeners persist across swaps; guard against doubling
    let lastMove = 0, moveTimer = null;
    remote.addEventListener('mousemove', (e) => {
      if (role !== 'controller') return;
      const p = toHostCoords(e), now = Date.now();
      if (now - lastMove >= 33) { lastMove = now; ctlSend({ t: 'move', x: p.x, y: p.y }); }
      else { clearTimeout(moveTimer); moveTimer = setTimeout(() => { lastMove = Date.now(); ctlSend({ t: 'move', x: p.x, y: p.y }); }, 33); }
    });
    remote.addEventListener('mousedown', (e) => { if (role !== 'controller') return; try { remote.focus(); } catch (err) {} const p = toHostCoords(e); ctlSend({ t: 'down', b: e.button, x: p.x, y: p.y }); e.preventDefault(); });
    remote.addEventListener('mouseup',   (e) => { if (role !== 'controller') return; ctlSend({ t: 'up', b: e.button }); e.preventDefault(); });
    remote.addEventListener('contextmenu', (e) => e.preventDefault());
    remote.addEventListener('wheel', (e) => { if (role !== 'controller') return; ctlSend({ t: 'wheel', dy: Math.sign(e.deltaY) }); e.preventDefault(); }, { passive: false });
    // Send the PHYSICAL key code (e.code) so the host replays the exact key and
    // applies its own Shift/Ctrl/Alt — this is what makes modifiers work.
    remote.addEventListener('keydown', (e) => { if (role !== 'controller') return; pressed.add(e.code || e.key); ctlSend({ t: 'key', code: e.code, k: e.key, down: true }); e.preventDefault(); });
    remote.addEventListener('keyup',   (e) => { if (role !== 'controller') return; pressed.delete(e.code || e.key); ctlSend({ t: 'key', code: e.code, k: e.key, down: false }); e.preventDefault(); });
  }

  const pressed = new Set();   // holds e.code values currently down on the controller
  function releaseAllKeys() { for (const c of pressed) ctlSend({ t: 'key', code: c, down: false }); pressed.clear(); }
  window.addEventListener('blur', releaseAllKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllKeys(); });

  // ---- On-screen modifier keys (touch devices with no physical Ctrl/Shift) ---
  // Ctrl/Shift/Alt/Win arm a held modifier on the host; it auto-releases after
  // the next key (so "tap Ctrl, tap A" = Ctrl+A). Esc/Tab/Del/arrows are one-shot.
  const armedMods = new Set();
  function releaseArmedMods() {
    if (!armedMods.size) return;
    for (const code of armedMods) ctlSend({ t: 'key', code, down: false });
    armedMods.clear();
    document.querySelectorAll('#modKeys .mod.armed').forEach((b) => b.classList.remove('armed'));
  }
  document.querySelectorAll('#modKeys .mod').forEach((btn) => {
    // pointerdown preventDefault keeps the on-screen keyboard from closing.
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.onclick = () => {
      const code = btn.dataset.code;
      if (armedMods.has(code)) { armedMods.delete(code); ctlSend({ t: 'key', code, down: false }); btn.classList.remove('armed'); }
      else { armedMods.add(code); ctlSend({ t: 'key', code, down: true }); btn.classList.add('armed'); }
    };
  });
  document.querySelectorAll('#modKeys .key[data-tap]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.onclick = () => tapKey(btn.dataset.tap);   // tapKey releases armed mods after
  });
  // One-shot PHYSICAL-code keys (e.g. Win/Super): single tap = full press+release,
  // combined with any armed modifiers, then releases them.
  document.querySelectorAll('#modKeys .key[data-tapcode]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.onclick = () => {
      const c = btn.dataset.tapcode;
      ctlSend({ t: 'key', code: c, down: true });
      ctlSend({ t: 'key', code: c, down: false });
      releaseArmedMods();
    };
  });

  // On-screen keyboard (tablets)
  const SENTINEL = ' ';
  kb.value = SENTINEL;
  kbBtn.onclick = $('fsKb').onclick = () => { kb.value = SENTINEL; kb.focus(); };
  kb.addEventListener('input', () => {
    const v = kb.value;
    if (v.length < SENTINEL.length) tapKey('Backspace');
    else for (const ch of v.slice(SENTINEL.length)) { if (ch === '\n') tapKey('Enter'); else tapKey(ch); }
    kb.value = SENTINEL;
  });
  kb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Escape') { tapKey(e.key); e.preventDefault(); }
  });

  // Fullscreen
  function exitFs() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  fsBtn.onclick = () => { if (document.fullscreenElement) exitFs(); else screenBox.requestFullscreen().catch(() => {}); };
  // Visible in-fullscreen exit button (keyboard-lock can trap Esc, so a tap/click
  // is the reliable way out).
  $('fsExit').onclick = exitFs;
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    fsBtn.textContent = fs ? '⛶ Exit full screen' : '⛶ Full screen';
    if (fs) { remote.focus(); if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {}); }
    else { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); releaseAllKeys(); }
  });

  // ---- Login gate ------------------------------------------------------------
  // The server rejects every action without a valid token, so this isn't just
  // a UI curtain — a patched client gains nothing.
  const AUTH_ERR = {
    'wrong-credentials': 'Wrong username or password.',
    'too-many-attempts': 'Too many attempts — wait 5 minutes.'
  };
  function authNote(t) { $('authNote').textContent = t || ''; }

  // Two login modes:
  //   'full'  — first time / no saved login: username + password REQUIRED (no Cancel).
  //   'light' — returning user (saved token): only a connect code, and Cancel to
  //             just use the app. Cannot unlock without a prior full login.
  function showAuth(mode) {
    if (!mode) { $('auth').style.display = 'none'; return; }
    $('auth').style.display = 'grid';
    const light = mode === 'light';
    $('credRows').style.display = light ? 'none' : 'block';
    $('cancelBtn').style.display = light ? 'block' : 'none';
    $('loginBtn').textContent = light ? 'Connect' : 'Sign in';
    $('authTitle').textContent = light
      ? 'Signed in as ' + (localStorage.getItem('rl_user') || 'you') + ' — enter a code, or Cancel'
      : 'Sign in to continue';
    authNote('');
  }

  function signOut(reason) {
    token = ''; localStorage.removeItem('rl_token');
    if (ws) { try { ws.close(); } catch (e) {} }
    wsReady = false;
    showAuth('full'); authNote(reason || '');
    setNet('', 'signed out');
  }

  // Cancel (light mode only): dismiss the prompt and use the app — we're already
  // authenticated via the saved token.
  $('cancelBtn').onclick = () => { showAuth(false); };

  // Prefill the saved shared-server URL.
  try { $('aServer').value = localStorage.getItem('rl_server') || ''; } catch (e) {}

  // ---- Connect code: paste one code to fill server + target ID + password ----
  $('applyCode').onclick = () => {
    const parsed = parseConnectCode($('aCode').value);
    if (!parsed) return authNote('That connect code is not valid.');
    $('aServer').value = parsed.server;
    // Stash the target so we auto-connect after login.
    localStorage.setItem('rl_pending_target', JSON.stringify({ id: parsed.id, access: parsed.access }));
    authNote('Code applied — server set. Now sign in.'); $('authNote').style.color = 'var(--ok)';
  };
  $('aCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('applyCode').click(); });

  // Apply a pasted connect code (both modes): stash the target and switch server
  // if the code carries a different one. Returns true if a reload was triggered.
  function applyCodeIfAny() {
    const codeVal = $('aCode').value.trim();
    if (!codeVal) return false;
    const parsed = parseConnectCode(codeVal);
    if (!parsed) { authNote('That connect code is not valid.'); return 'invalid'; }
    localStorage.setItem('rl_pending_target', JSON.stringify({ id: parsed.id, access: parsed.access }));
    const server = (parsed.server || '').replace(/\/+$/, '');
    const cur = (window.SERVER_BASE || '').replace(/\/+$/, '');
    if (server && server !== cur) {
      localStorage.setItem('rl_server', server);
      authNote('Applying server… reloading.');
      setTimeout(() => location.reload(), 300);
      return true;   // reloading
    }
    return false;
  }

  $('loginBtn').onclick = async () => {
    const light = $('credRows').style.display === 'none';

    // LIGHT mode: already signed in — just apply any code and connect.
    if (light) {
      const r = applyCodeIfAny();
      if (r === 'invalid') return;
      if (r === true) return;            // reloading with new server
      showAuth(false);
      if (wsReady) maybeAutoConnect();   // dial the stashed target now (else fires on register)
      return;
    }

    // FULL mode (first time): username + password REQUIRED.
    const username = $('aUser').value.trim(), password = $('aPw').value;
    if (!username || !password) return authNote('Enter your username and password.');

    // Optional server override + optional code.
    if (applyCodeIfAny() === 'invalid') return;
    const server = $('aServer').value.trim().replace(/\/+$/, '');
    const prevServer = (localStorage.getItem('rl_server') || '').replace(/\/+$/, '');
    if (server && server !== prevServer) {
      localStorage.setItem('rl_server', server);
      authNote('Applying server… reloading.');
      return setTimeout(() => location.reload(), 300);
    }

    authNote('Signing in…');
    // The free hosted server sleeps when idle; the first request can take ~50s
    // to wake it. Reassure the user instead of looking frozen, and don't give up.
    const slow = setTimeout(() => authNote('Waking the server… first connect can take up to a minute.'), 4000);
    try {
      const base = window.SERVER_BASE || '';
      const r = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      clearTimeout(slow);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return authNote(AUTH_ERR[data.error] || data.error || 'Sign-in failed.');
      token = data.token;
      localStorage.setItem('rl_token', token);
      localStorage.setItem('rl_user', data.username);
      showAuth(false); authNote('');
      setNet('wait', 'connecting…');
      connectWS();
    } catch (e) { clearTimeout(slow); authNote('Cannot reach the server — check your internet, then retry.'); }
  };
  $('aServer').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
  $('aPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
  $('aUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('aPw').focus(); });

  // Pre-warm the hosted server on launch so it's awake by the time the user
  // logs in (free tier sleeps after ~15 min idle; cold start ~30-50s).
  if (window.SERVER_BASE) { try { fetch(window.SERVER_BASE + '/app.html', { method: 'HEAD', mode: 'no-cors' }).catch(() => {}); } catch (e) {} }

  // ---- Boot ------------------------------------------------------------------
  // First time (no saved login): FULL login, username+password required, cannot
  // be bypassed. Returning user (saved token): connect in the background and show
  // the LIGHT prompt (code only, Cancel to just use the app).
  if (token) {
    setNet('wait', 'connecting…');
    connectWS();          // uses the saved token; if it's rejected we fall to full login
    showAuth('light');
  } else {
    showAuth('full');
    setNet('', 'signed out');
  }
})();
