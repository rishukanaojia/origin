# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['/home/rishabh/Downloads/yantra-20260709T183841Z-2-001/remote-Desktop/launcher/remotelink_gui.py'],
    pathex=[],
    binaries=[('/home/rishabh/Downloads/yantra-20260709T183841Z-2-001/remote-Desktop/cloudflared', '.')],
    datas=[('/home/rishabh/Downloads/yantra-20260709T183841Z-2-001/remote-Desktop/signaling-server', 'signaling-server'), ('/home/rishabh/Downloads/yantra-20260709T183841Z-2-001/remote-Desktop/public', 'public')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='RemoteLink-Launcher',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['/home/rishabh/Downloads/yantra-20260709T183841Z-2-001/remote-Desktop/public/icon-512.png'],
)
