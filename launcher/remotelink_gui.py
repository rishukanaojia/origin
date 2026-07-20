#!/usr/bin/env python3
"""
RemoteLink Launcher — a cross-platform GUI that starts the RemoteLink stack
and streams its terminal output into a window.

Why Tkinter: it ships with Python on Windows/macOS/Linux, so this runs
everywhere with zero third-party dependencies and compiles cleanly with
PyInstaller into a single executable.

Why it runs `node ...` directly instead of start-public.sh: shell scripts are
POSIX-only. Invoking node ourselves keeps this OS-independent.

Starts:
  * agent.js   -> injects real mouse/keyboard (127.0.0.1:9091)
  * server.js  -> signaling + serves the app (:8080)
  * cloudflared (optional) -> public HTTPS URL so other networks can connect

Closing the window (or Stop) kills the whole process tree — nothing is left
running in the background.

Build a single executable:  python3 build_exe.py
"""

import os
import re
import sys
import queue
import signal
import shutil
import subprocess
import threading
import webbrowser
import tkinter as tk
from tkinter import scrolledtext, messagebox

APP_NAME = "RemoteLink"
PORT = "8080"

# Palette matched to the web app.
BG0, CARD, STROKE = "#070b12", "#141e2c", "#33475c"
INK, MUTED = "#eef4fb", "#93a6bd"
ACCENT, ACCENT2 = "#3ba9ff", "#5ee0c0"
OK, WARN, DANGER = "#4ecb84", "#e6b153", "#ff6b6b"

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def resource(*parts):
    """Path to bundled data — works both from source and inside PyInstaller."""
    base = getattr(sys, "_MEIPASS", None)
    if base is None:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def find_node():
    """Locate a Node runtime. The pinned local install wins over an older
    system node (Ubuntu ships v10, which is long past end-of-life)."""
    candidates = [
        os.path.expanduser("~/.local/node-v20/bin/node"),
        shutil.which("node"),
        "/usr/local/bin/node",
        r"C:\Program Files\nodejs\node.exe",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


class Launcher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME + " Launcher")
        self.configure(bg=BG0)
        self.geometry("860x580")
        self.minsize(640, 440)

        self.procs = []                 # [(name, Popen)]
        self.q = queue.Queue()          # lines from reader threads -> UI
        self.public_url = None
        self.running = False

        self._set_icon()
        self._build_ui()

        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.after(80, self._drain_queue)

    # ---------- window icon (same logo as the web app) ----------
    def _set_icon(self):
        self.logo_img = None
        for name in ("icon-192.png", "icon-512.png"):
            p = resource("public", name)
            if os.path.exists(p):
                try:
                    img = tk.PhotoImage(file=p)
                    # Tk has no scaler for arbitrary sizes; subsample to ~48px for the header.
                    self.iconphoto(True, img)
                    factor = max(1, img.width() // 48)
                    self.logo_img = img.subsample(factor, factor)
                    return
                except Exception:
                    pass

    # ---------- UI ----------
    def _build_ui(self):
        header = tk.Frame(self, bg=BG0)
        header.pack(fill="x", padx=16, pady=(14, 6))

        if self.logo_img:
            tk.Label(header, image=self.logo_img, bg=BG0).pack(side="left", padx=(0, 12))

        titles = tk.Frame(header, bg=BG0)
        titles.pack(side="left")
        tk.Label(titles, text=APP_NAME, bg=BG0, fg=INK,
                 font=("Helvetica", 16, "bold")).pack(anchor="w")
        tk.Label(titles, text="Peer-to-peer remote desktop — launcher",
                 bg=BG0, fg=MUTED, font=("Helvetica", 9)).pack(anchor="w")

        self.status = tk.Label(header, text="● stopped", bg=BG0, fg=MUTED,
                               font=("Helvetica", 10, "bold"))
        self.status.pack(side="right")

        # controls
        bar = tk.Frame(self, bg=BG0)
        bar.pack(fill="x", padx=16, pady=6)

        self.start_btn = tk.Button(bar, text="▶  Start", command=self.start,
                                   bg=ACCENT, fg="#04121e", relief="flat",
                                   font=("Helvetica", 10, "bold"), padx=18, pady=7,
                                   activebackground=ACCENT2, cursor="hand2")
        self.start_btn.pack(side="left")

        self.stop_btn = tk.Button(bar, text="■  Stop", command=self.stop,
                                  bg=DANGER, fg="#2a0808", relief="flat",
                                  font=("Helvetica", 10, "bold"), padx=18, pady=7,
                                  state="disabled", cursor="hand2")
        self.stop_btn.pack(side="left", padx=(8, 0))

        self.tunnel_var = tk.BooleanVar(value=True)
        tk.Checkbutton(bar, text="Public URL (other networks)", variable=self.tunnel_var,
                       bg=BG0, fg=MUTED, selectcolor=CARD, activebackground=BG0,
                       activeforeground=INK, font=("Helvetica", 9),
                       highlightthickness=0, bd=0).pack(side="left", padx=(14, 0))

        self.open_btn = tk.Button(bar, text="Open app", command=self.open_app,
                                  bg=CARD, fg=INK, relief="flat",
                                  font=("Helvetica", 10), padx=14, pady=7,
                                  state="disabled", cursor="hand2")
        self.open_btn.pack(side="right")

        self.copy_btn = tk.Button(bar, text="Copy URL", command=self.copy_url,
                                  bg=CARD, fg=INK, relief="flat",
                                  font=("Helvetica", 10), padx=14, pady=7,
                                  state="disabled", cursor="hand2")
        self.copy_btn.pack(side="right", padx=(0, 8))

        # url strip
        self.url_lbl = tk.Label(self, text="Not running.", bg=CARD, fg=ACCENT2,
                                font=("Courier", 10), anchor="w", padx=12, pady=8)
        self.url_lbl.pack(fill="x", padx=16, pady=(4, 8))

        # output
        self.out = scrolledtext.ScrolledText(
            self, bg="#060b12", fg="#8fb4c9", insertbackground=INK,
            font=("Courier", 9), relief="flat", borderwidth=0, wrap="word")
        self.out.pack(fill="both", expand=True, padx=16, pady=(0, 14))
        self.out.configure(state="disabled")
        for tag, colour in (("err", DANGER), ("ok", OK), ("info", ACCENT), ("warn", WARN)):
            self.out.tag_config(tag, foreground=colour)

    # ---------- logging ----------
    def log(self, text, tag=None):
        self.out.configure(state="normal")
        self.out.insert("end", text + "\n", tag or ())
        self.out.see("end")
        # keep the buffer bounded so long sessions don't eat memory
        if int(self.out.index("end-1c").split(".")[0]) > 2000:
            self.out.delete("1.0", "500.0")
        self.out.configure(state="disabled")

    def set_status(self, text, colour):
        self.status.configure(text="● " + text, fg=colour)

    # ---------- process control ----------
    def _spawn(self, name, cmd, cwd, env=None):
        """Start a child in its own process group so we can kill its whole tree."""
        kw = dict(stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd,
                  bufsize=1, universal_newlines=True)
        if env:
            kw["env"] = env
        if os.name == "posix":
            kw["preexec_fn"] = os.setsid
        else:
            kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            si = subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW      # no console flash on Windows
            kw["startupinfo"] = si
        p = subprocess.Popen(cmd, **kw)
        self.procs.append((name, p))
        threading.Thread(target=self._reader, args=(name, p), daemon=True).start()
        return p

    def _reader(self, name, p):
        try:
            for line in iter(p.stdout.readline, ""):
                self.q.put((name, line.rstrip("\n")))
        except Exception:
            pass
        finally:
            self.q.put((name, "__EXIT__"))

    def _drain_queue(self):
        try:
            while True:
                name, line = self.q.get_nowait()
                if line == "__EXIT__":
                    if self.running:
                        self.log("[%s] exited." % name, "warn")
                    continue
                tag = None
                low = line.lower()
                if "error" in low or "failed" in low or line.startswith("!!"):
                    tag = "err"
                elif "listening" in low or "ready" in low or "using" in low:
                    tag = "ok"
                self.log("[%s] %s" % (name, line), tag)

                m = URL_RE.search(line)
                if m and not self.public_url:
                    self.public_url = m.group(0)
                    self._show_url()
        except queue.Empty:
            pass
        self.after(80, self._drain_queue)

    def _show_url(self):
        self.url_lbl.configure(
            text="Public:  %s/app.html      Local:  http://localhost:%s/app.html"
                 % (self.public_url, PORT))
        self.copy_btn.configure(state="normal")
        self.log("Public URL ready: " + self.public_url + "/app.html", "ok")
        self.log("Open that on your tab/phone. Local machine can use localhost.", "info")

    # ---------- actions ----------
    def start(self):
        if self.running:
            return
        node = find_node()
        if not node:
            messagebox.showerror(
                APP_NAME,
                "Node.js was not found.\n\nInstall Node 18+ from https://nodejs.org "
                "and start this launcher again.")
            return

        srv_dir = resource("signaling-server")
        if not os.path.isdir(srv_dir):
            messagebox.showerror(APP_NAME, "Could not find signaling-server/ next to this app.")
            return
        if not os.path.exists(os.path.join(srv_dir, "users.json")):
            self.log("No users.json — run 'node seed-users.js' or nobody can log in.", "warn")

        self.out.configure(state="normal"); self.out.delete("1.0", "end"); self.out.configure(state="disabled")
        self.public_url = None
        self.running = True
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.open_btn.configure(state="normal")
        self.set_status("running", OK)
        self.url_lbl.configure(text="Local:  http://localhost:%s/app.html" % PORT)
        self.log("Using Node: " + node, "info")

        env_port = dict(os.environ, PORT=PORT)
        try:
            self._spawn("agent", [node, os.path.join(srv_dir, "agent.js")], srv_dir)
            self._spawn("server", [node, os.path.join(srv_dir, "server.js")], srv_dir, env_port)
        except Exception as e:
            self.log("Failed to start: %s" % e, "err")
            self.stop()
            return

        if self.tunnel_var.get():
            self._start_tunnel()

    def _start_tunnel(self):
        cf = resource("cloudflared")
        if os.name == "nt":
            cf = cf + ".exe"
        if not os.path.exists(cf):
            cf = shutil.which("cloudflared")
        if not cf:
            self.log("cloudflared not found — local network only.", "warn")
            return
        self.log("Starting public tunnel (~15s)…", "info")
        try:
            self._spawn("tunnel", [cf, "tunnel", "--url", "http://localhost:" + PORT],
                        os.path.dirname(cf) or None)
        except Exception as e:
            self.log("Tunnel failed: %s" % e, "err")

    def stop(self):
        if not self.procs:
            self._reset_ui()
            return
        self.running = False
        self.log("Stopping…", "info")
        for name, p in self.procs:
            self._kill(p)
        for name, p in self.procs:
            try:
                p.wait(timeout=4)
            except Exception:
                self._kill(p, hard=True)
        self.procs = []
        self.public_url = None
        self.log("All processes stopped.", "ok")
        self._reset_ui()

    def _kill(self, p, hard=False):
        """Kill the process AND its children (node spawns helpers)."""
        if p.poll() is not None:
            return
        try:
            if os.name == "posix":
                sig = signal.SIGKILL if hard else signal.SIGTERM
                os.killpg(os.getpgid(p.pid), sig)
            else:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                               capture_output=True)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def _reset_ui(self):
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.copy_btn.configure(state="disabled")
        self.set_status("stopped", MUTED)
        self.url_lbl.configure(text="Not running.")

    def open_app(self):
        webbrowser.open("http://localhost:%s/app.html" % PORT)

    def copy_url(self):
        if self.public_url:
            self.clipboard_clear()
            self.clipboard_append(self.public_url + "/app.html")
            self.log("URL copied to clipboard.", "ok")

    def on_close(self):
        if self.running:
            self.stop()
        self.destroy()


if __name__ == "__main__":
    Launcher().mainloop()
