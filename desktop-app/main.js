/*
 * RemoteLink Desktop — Electron main process.
 *
 * Turns the peer app into real installable software: one window, nothing to
 * start in a terminal. On launch it boots the signaling server and the input
 * agent IN-PROCESS, then loads the same app.html the browser version uses.
 *
 * Because it always loads from http://localhost:<port>, the origin never
 * changes, so the permanent ID stored in localStorage really is permanent.
 */
'use strict';

const { app, BrowserWindow, session, desktopCapturer, Menu, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const fs = require('fs');

// The embedded server's port is chosen at runtime. We prefer 8080 but fall
// back to a random free port if it's taken (e.g. another RemoteLink instance
// or start-public.sh is already using it) — otherwise the app would boot with
// no reachable server and sit there showing "offline". The window loads
// whatever port we pick, and the page derives its WebSocket URL from that, so
// everything stays consistent automatically.
let PORT = 8080;

// Try a FIXED sequence of ports (not random) so the page origin — and thus the
// saved identity in localStorage — stays stable across launches.
function pickPort(cb, list) {
  list = list || [8080, 8081, 8082, 8083, 8090];
  if (!list.length) {   // all busy → last resort random
    const any = net.createServer();
    any.listen(0, '127.0.0.1', () => { const p = any.address().port; any.close(() => cb(p)); });
    return;
  }
  const port = list[0];
  const probe = net.createServer();
  probe.once('error', () => pickPort(cb, list.slice(1)));
  probe.once('listening', () => probe.close(() => cb(port)));
  probe.listen(port, '127.0.0.1');
}

// Locate the backend. In dev it's the sibling signaling-server/ folder; when
// packaged, electron-builder copies public/ and signaling-server/ into the
// app's resources/ dir (see extraResources in package.json).
const backendDir = app.isPackaged
  ? path.join(process.resourcesPath, 'signaling-server')
  : path.join(__dirname, '..', 'signaling-server');

function startBackend() {
  process.env.PORT = String(PORT);
  // The installed app dir is read-only, so tell the server to persist its
  // state (login sessions + device IDs) in a writable per-user folder.
  // Without this, tokens live only in memory and every relaunch forces re-login.
  process.env.RL_DATA_DIR = app.getPath('userData');
  try {
    require(path.join(backendDir, 'server.js'));   // signaling + static files on :PORT
    require(path.join(backendDir, 'agent.js'));    // input injection on 127.0.0.1:9091
  } catch (e) {
    console.error('Embedded backend failed to start:', e.message);
  }
}

function waitForServer(cb, tries) {
  http.get('http://localhost:' + PORT + '/app.html', (res) => { res.destroy(); cb(); })
    .on('error', () => {
      if ((tries || 0) > 50) return cb();               // give up waiting, load anyway
      setTimeout(() => waitForServer(cb, (tries || 0) + 1), 100);
    });
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0b1420',
    title: 'RemoteLink',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  waitForServer(() => win.loadURL('http://localhost:' + PORT + '/app.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // getDisplayMedia() in Electron needs the app to choose a source. We capture
  // the whole primary screen (that's what a remote-desktop share means).
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback(sources.length ? { video: sources[0], audio: false } : {});
    }).catch(() => callback({}));
  });

  // Choose a free port, THEN start the backend on it and open the window.
  pickPort((port) => {
    PORT = port;
    console.log('RemoteLink using port ' + PORT);
    startBackend();
    createWindow();
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// ---- Tunnel: make THIS device reachable, show the URL in the app -----------
// Runs the bundled cloudflared against the local server and reports the public
// https URL back to the page, so the user reads it here (no terminal) and types
// it into the other device's "Server" field.
let tunnelProc = null;

function cloudflaredPath() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', name);
  return fs.existsSync(bundled) ? bundled : name;   // fall back to PATH
}

ipcMain.handle('start-tunnel', () => {
  if (tunnelProc) return { ok: true, pending: true };
  const bin = cloudflaredPath();
  try {
    tunnelProc = spawn(bin, ['tunnel', '--url', 'http://localhost:' + PORT], { windowsHide: true });
  } catch (e) {
    return { ok: false, error: 'cloudflared not found' };
  }
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && win) win.webContents.send('tunnel', { url: m[0] });
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);        // cloudflared prints the URL on stderr
  tunnelProc.on('exit', () => {
    tunnelProc = null;
    if (win) win.webContents.send('tunnel', { url: null });
  });
  return { ok: true };
});

ipcMain.handle('stop-tunnel', () => {
  if (tunnelProc) { try { tunnelProc.kill(); } catch (e) {} tunnelProc = null; }
  return { ok: true };
});

// This machine's LAN address(es) — so other devices on the SAME network can
// use this machine as the server with no tunnel and no internet.
ipcMain.handle('lan-urls', () => {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name in ifs) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push('http://' + i.address + ':' + PORT);
    }
  }
  return out;
});

function killTunnel() { if (tunnelProc) { try { tunnelProc.kill(); } catch (e) {} tunnelProc = null; } }
app.on('before-quit', killTunnel);
app.on('window-all-closed', () => { killTunnel(); app.quit(); });
