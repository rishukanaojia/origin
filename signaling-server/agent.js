/*
 * RemoteLink — Native input agent (cross-platform)
 * ------------------------------------------------
 * Runs ON the machine being controlled. The app can stream the screen but is
 * sandboxed from OS input, so it forwards the controller's mouse/keyboard
 * events to this agent over a localhost-only WebSocket, and the agent injects
 * them into the real desktop.
 *
 *   controller --WebRTC--> app --ws://127.0.0.1:9091--> agent --> OS input
 *
 * Primary injector is nut.js (@nut-tree-fork/nut-js), which ships prebuilt
 * binaries for Windows, macOS and Linux — so this is OS-independent. If nut.js
 * can't load, we fall back to `xdotool` on Linux/X11.
 */

'use strict';

const WebSocket = require('ws');
const PORT = 9091;

// ---------------------------------------------------------------------------
// Injector abstraction: exposes move/down/up/wheel/keydown/keyup/typeChar and
// releaseAll. Two implementations; nut.js preferred, xdotool as fallback.
// ---------------------------------------------------------------------------
let injector = null;

// A serialized async queue so injections happen in order and never overlap.
// Mouse moves coalesce: a queued move is replaced by the newest position so
// injection can't fall behind a fast-moving cursor.
function makeQueue() {
  const q = [];
  let busy = false;
  async function drain() {
    if (busy) return; busy = true;
    while (q.length) { const item = q.shift(); try { await item.fn(); } catch (e) {} }
    busy = false;
  }
  return {
    push(fn, isMove) {
      if (isMove && q.length && q[q.length - 1].isMove) q[q.length - 1].fn = fn;
      else q.push({ fn, isMove });
      drain();
    }
  };
}

// ---- nut.js injector (Windows / macOS / Linux) ----------------------------
function tryNut() {
  let nut;
  try { nut = require('@nut-tree-fork/nut-js'); } catch (e) { return null; }
  const { mouse, keyboard, Button, Key, Point } = nut;
  keyboard.config.autoDelayMs = 0;
  mouse.config.autoDelayMs = 0;

  const NBTN = { 0: Button.LEFT, 1: Button.MIDDLE, 2: Button.RIGHT };

  // browser KeyboardEvent.key -> nut Key for non-text keys
  const NKEY = {
    Enter: Key.Enter, Backspace: Key.Backspace, Tab: Key.Tab, Escape: Key.Escape,
    Delete: Key.Delete, Insert: Key.Insert, Home: Key.Home, End: Key.End,
    PageUp: Key.PageUp, PageDown: Key.PageDown,
    ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
    Shift: Key.LeftShift, Control: Key.LeftControl, Alt: Key.LeftAlt, Meta: Key.LeftSuper,
    CapsLock: Key.CapsLock, ' ': Key.Space,
    F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
    F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12
  };
  // printable char -> nut Key (for shortcuts, where we must press the key with
  // modifiers held rather than type text)
  const PUNCT = {
    '-': Key.Minus, '=': Key.Equal, '[': Key.LeftBracket, ']': Key.RightBracket,
    '\\': Key.Backslash, ';': Key.Semicolon, "'": Key.Quote, ',': Key.Comma,
    '.': Key.Period, '/': Key.Slash, '`': Key.Grave, ' ': Key.Space
  };
  function charKey(ch) {
    if (/^[a-zA-Z]$/.test(ch)) return Key[ch.toUpperCase()];
    if (/^[0-9]$/.test(ch)) return Key['Num' + ch];
    return PUNCT[ch] || null;
  }

  // Physical key (KeyboardEvent.code) -> nut Key. This is the CORRECT path for
  // a real keyboard: we press/release the exact physical keys and let the OS
  // apply Shift/Ctrl/Alt itself, so Ctrl+C, Shift+letter, Shift+symbols, etc.
  // all work. (The old char-based path fought nut's own modifier handling.)
  const CODE = {
    KeyA: Key.A, KeyB: Key.B, KeyC: Key.C, KeyD: Key.D, KeyE: Key.E, KeyF: Key.F,
    KeyG: Key.G, KeyH: Key.H, KeyI: Key.I, KeyJ: Key.J, KeyK: Key.K, KeyL: Key.L,
    KeyM: Key.M, KeyN: Key.N, KeyO: Key.O, KeyP: Key.P, KeyQ: Key.Q, KeyR: Key.R,
    KeyS: Key.S, KeyT: Key.T, KeyU: Key.U, KeyV: Key.V, KeyW: Key.W, KeyX: Key.X,
    KeyY: Key.Y, KeyZ: Key.Z,
    Digit0: Key.Num0, Digit1: Key.Num1, Digit2: Key.Num2, Digit3: Key.Num3,
    Digit4: Key.Num4, Digit5: Key.Num5, Digit6: Key.Num6, Digit7: Key.Num7,
    Digit8: Key.Num8, Digit9: Key.Num9,
    ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
    ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
    AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
    MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
    Enter: Key.Enter, NumpadEnter: Key.Enter, Backspace: Key.Backspace, Tab: Key.Tab,
    Escape: Key.Escape, Space: Key.Space, CapsLock: Key.CapsLock,
    Delete: Key.Delete, Insert: Key.Insert, Home: Key.Home, End: Key.End,
    PageUp: Key.PageUp, PageDown: Key.PageDown,
    ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
    Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket,
    BracketRight: Key.RightBracket, Backslash: Key.Backslash, Semicolon: Key.Semicolon,
    Quote: Key.Quote, Backquote: Key.Grave, Comma: Key.Comma, Period: Key.Period, Slash: Key.Slash,
    F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
    F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12
  };

  const heldKeys = new Set();       // nut Key values currently down
  const heldButtons = new Set();    // nut Button values currently down
  const MODS = [Key.LeftControl, Key.LeftAlt, Key.LeftSuper];

  return {
    name: 'nut.js',
    q: makeQueue(),
    hasCode: true,
    keyByCode(code, down) {
      const key = CODE[code];
      if (key === undefined) return false;
      if (down) { this.q.push(() => keyboard.pressKey(key)); heldKeys.add(key); }
      else { this.q.push(() => keyboard.releaseKey(key)); heldKeys.delete(key); }
      return true;
    },
    move(x, y) { this.q.push(() => mouse.setPosition(new Point(x, y)), true); },
    down(b, x, y) {
      const btn = NBTN[b] || Button.LEFT;
      this.q.push(async () => { await mouse.setPosition(new Point(x, y)); await mouse.pressButton(btn); });
      heldButtons.add(btn);
    },
    up(b) {
      const btn = NBTN[b] || Button.LEFT;
      this.q.push(() => mouse.releaseButton(btn));
      heldButtons.delete(btn);
    },
    wheel(dy) { this.q.push(() => (dy > 0 ? mouse.scrollDown(3) : mouse.scrollUp(3))); },
    keydown(k) {
      const key = NKEY[k];
      if (key === undefined) return;
      this.q.push(() => keyboard.pressKey(key));
      heldKeys.add(key);
    },
    keyup(k) {
      const key = NKEY[k];
      if (key === undefined) return;
      this.q.push(() => keyboard.releaseKey(key));
      heldKeys.delete(key);
    },
    typeChar(ch) {
      const shortcut = MODS.some((m) => heldKeys.has(m));
      if (shortcut) {
        const key = charKey(ch);
        if (key !== null && key !== undefined) this.q.push(async () => { await keyboard.pressKey(key); await keyboard.releaseKey(key); });
      } else {
        this.q.push(() => keyboard.type(ch));   // types the literal character
      }
    },
    releaseAll() {
      for (const key of heldKeys) this.q.push(() => keyboard.releaseKey(key));
      for (const btn of heldButtons) this.q.push(() => mouse.releaseButton(btn));
      heldKeys.clear(); heldButtons.clear();
    }
  };
}

// ---- xdotool injector (Linux/X11 fallback) --------------------------------
function tryXdotool() {
  const { execFile } = require('child_process');
  // Confirm xdotool exists; if not, this injector is unusable.
  try { require('child_process').execFileSync('xdotool', ['getdisplaygeometry']); }
  catch (e) { return null; }

  const BTN = { 0: 1, 1: 2, 2: 3 };
  const KEYS = {
    Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'Page_Up', PageDown: 'Page_Down', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right', Shift: 'Shift_L', Control: 'Control_L',
    Alt: 'Alt_L', Meta: 'Super_L', CapsLock: 'Caps_Lock', ' ': 'space',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12'
  };
  const CHAR_SYMS = {
    ' ': 'space', '-': 'minus', '=': 'equal', '/': 'slash', '\\': 'backslash',
    '.': 'period', ',': 'comma', ';': 'semicolon', "'": 'apostrophe',
    '[': 'bracketleft', ']': 'bracketright', '`': 'grave'
  };
  const charSym = (ch) => (/^[a-zA-Z0-9]$/.test(ch) ? ch.toLowerCase() : (CHAR_SYMS[ch] || null));
  const run = (args) => new Promise((res) => execFile('xdotool', args, () => res()));
  const heldKeys = new Set(), heldButtons = new Set();
  const MODS = ['Control_L', 'Alt_L', 'Super_L'];

  // Physical key (KeyboardEvent.code) -> X keysym. Base keys only; the OS
  // applies held Shift/Ctrl so 'Digit1' + Shift = '!', 'KeyA' + Shift = 'A'.
  const l = 'abcdefghijklmnopqrstuvwxyz';
  const CODE = {
    ShiftLeft: 'Shift_L', ShiftRight: 'Shift_R', ControlLeft: 'Control_L', ControlRight: 'Control_R',
    AltLeft: 'Alt_L', AltRight: 'Alt_R', MetaLeft: 'Super_L', MetaRight: 'Super_R',
    Enter: 'Return', NumpadEnter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape',
    Space: 'space', CapsLock: 'Caps_Lock', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright',
    Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe', Backquote: 'grave',
    Comma: 'comma', Period: 'period', Slash: 'slash',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12'
  };
  for (const c of l) CODE['Key' + c.toUpperCase()] = c;        // KeyA -> a
  for (let i = 0; i < 10; i++) CODE['Digit' + i] = String(i);  // Digit1 -> 1

  return {
    name: 'xdotool',
    q: makeQueue(),
    hasCode: true,
    keyByCode(code, down) {
      const s = CODE[code];
      if (!s) return false;
      if (down) { this.q.push(() => run(['keydown', s])); heldKeys.add(s); }
      else { this.q.push(() => run(['keyup', s])); heldKeys.delete(s); }
      return true;
    },
    move(x, y) { this.q.push(() => run(['mousemove', String(x), String(y)]), true); },
    down(b, x, y) { const btn = BTN[b] || 1; this.q.push(() => run(['mousemove', String(x), String(y), 'mousedown', String(btn)])); heldButtons.add(btn); },
    up(b) { const btn = BTN[b] || 1; this.q.push(() => run(['mouseup', String(btn)])); heldButtons.delete(btn); },
    wheel(dy) { this.q.push(() => run(['click', dy > 0 ? '5' : '4'])); },
    keydown(k) { const s = KEYS[k]; if (!s) return; this.q.push(() => run(['keydown', s])); heldKeys.add(s); },
    keyup(k) { const s = KEYS[k]; if (!s) return; this.q.push(() => run(['keyup', s])); heldKeys.delete(s); },
    typeChar(ch) {
      const shortcut = MODS.some((m) => heldKeys.has(m));
      if (shortcut) { const s = charSym(ch); if (s) this.q.push(() => run(['key', s])); }
      else this.q.push(() => run(['type', '--clearmodifiers', '--', ch]));
    },
    releaseAll() {
      for (const s of heldKeys) this.q.push(() => run(['keyup', s]));
      for (const b of heldButtons) this.q.push(() => run(['mouseup', String(b)]));
      heldKeys.clear(); heldButtons.clear();
    }
  };
}

injector = tryNut() || tryXdotool();
if (injector) console.log('Input agent using ' + injector.name + ' (OS: ' + process.platform + ')');
else console.log('!! No input backend available. Install nut.js, or xdotool on Linux/X11.');

// ---- Translate control events into injector calls --------------------------
function handle(ev) {
  if (!injector) return;
  switch (ev.t) {
    case 'move':  injector.move(ev.x, ev.y); break;
    case 'down':  injector.down(ev.b, ev.x, ev.y); break;
    case 'up':    injector.up(ev.b); break;
    case 'wheel': injector.wheel(ev.dy); break;
    case 'key':
      // Preferred: a physical key code from a real keyboard — replay the exact
      // key so the OS applies modifiers (Ctrl/Shift/Alt) correctly.
      if (ev.code && injector.hasCode && injector.keyByCode(ev.code, ev.down)) break;
      // Fallback: on-screen keyboard sends characters (no code).
      if (KEY_IS_TEXT(ev)) injector.typeChar(ev.k);
      else if (ev.down)    injector.keydown(ev.k);
      else                 injector.keyup(ev.k);
      break;
  }
}
// A single printable character on keydown is "text"; named keys are press/release.
function KEY_IS_TEXT(ev) {
  return ev.t === 'key' && ev.down && typeof ev.k === 'string' && ev.k.length === 1;
}

// ---- Localhost-only WebSocket server ---------------------------------------
const wss = new WebSocket.Server({ host: '127.0.0.1', port: PORT });
wss.on('connection', (ws) => {
  console.log('Controller connected — native control ACTIVE.');
  ws.on('message', (raw) => { try { handle(JSON.parse(raw)); } catch (e) {} });
  ws.on('close', () => {
    if (injector) injector.releaseAll();   // never leave keys/buttons stuck
    console.log('Controller disconnected — released held keys/buttons.');
  });
});

console.log('RemoteLink input agent listening on ws://127.0.0.1:' + PORT);
