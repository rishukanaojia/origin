/*
 * Preload — the safe bridge between the page and the Electron main process.
 * Exposes a marker (so the page knows it's the desktop app) and the tunnel
 * controls, so the app can make THIS device reachable and show the public URL
 * to type into another device.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('RemoteLinkDesktop', {
  isDesktop: true,
  platform: process.platform,
  startTunnel: () => ipcRenderer.invoke('start-tunnel'),
  stopTunnel: () => ipcRenderer.invoke('stop-tunnel'),
  // callback receives { url } when the public URL is ready, or { error }
  onTunnel: (cb) => ipcRenderer.on('tunnel', (_e, data) => cb(data)),
  // this machine's LAN address(es) so same-network clients can use it as server
  getLanUrls: () => ipcRenderer.invoke('lan-urls')
});
