#!/usr/bin/env python3
"""
Compile the RemoteLink launcher into ONE executable, using the app's own icon.

    python3 build_exe.py

Output (in launcher/dist/):
    Linux   -> RemoteLink-Launcher          (single binary, chmod +x and run)
    Windows -> RemoteLink-Launcher.exe      (double-click)
    macOS   -> RemoteLink-Launcher.app/     (plus a single-file binary)

Run this ON the OS you want the executable for — PyInstaller freezes the local
Python, so it cannot cross-compile (same rule as every native toolchain).

The server code (signaling-server/, public/) is bundled INSIDE the executable,
so the launcher is self-contained. Node.js still has to be present on the
machine at runtime; the launcher finds it and says so clearly if it's missing.
"""

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEP = ";" if os.name == "nt" else ":"      # PyInstaller --add-data separator differs per OS


def make_icon():
    """PyInstaller wants .ico on Windows and .icns on macOS; PNG works on Linux."""
    png = os.path.join(ROOT, "public", "icon-512.png")
    if not os.path.exists(png):
        return None
    if os.name == "nt":
        ico = os.path.join(HERE, "icon.ico")
        if not os.path.exists(ico) and shutil.which("magick" if os.name == "nt" else "convert"):
            subprocess.run([shutil.which("magick") or "convert", png,
                            "-define", "icon:auto-resize=256,128,64,48,32,16", ico], check=False)
        return ico if os.path.exists(ico) else None
    if sys.platform == "darwin":
        icns = os.path.join(HERE, "icon.icns")
        if not os.path.exists(icns) and shutil.which("sips"):
            subprocess.run(["sips", "-s", "format", "icns", png, "--out", icns], check=False)
        return icns if os.path.exists(icns) else None
    return png


def main():
    icon = make_icon()
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onefile",                 # ONE self-contained file
        "--windowed",                # GUI app: no console window
        "--name", "RemoteLink-Launcher",
        "--distpath", os.path.join(HERE, "dist"),
        "--workpath", os.path.join(HERE, "build"),
        "--specpath", HERE,
        # bundle the app itself so the launcher is self-contained
        "--add-data", os.path.join(ROOT, "signaling-server") + SEP + "signaling-server",
        "--add-data", os.path.join(ROOT, "public") + SEP + "public",
    ]
    cf = os.path.join(ROOT, "cloudflared")
    if os.path.exists(cf):
        cmd += ["--add-binary", cf + SEP + "."]
    if icon:
        cmd += ["--icon", icon]
    cmd.append(os.path.join(HERE, "remotelink_gui.py"))

    print("Building… (this takes a minute)")
    r = subprocess.run(cmd)
    if r.returncode == 0:
        out = os.path.join(HERE, "dist")
        print("\nDone. Executable is in: " + out)
        for f in sorted(os.listdir(out)):
            print("   " + f)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
