# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the all-in-one launcher (web UI + desktop GUI).
# Build from the repo root:  pyinstaller --distpath . TradingAgentsLauncher.spec

a = Analysis(
    ['launcher.py'],
    pathex=[],
    binaries=[],
    datas=[],
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
    name='TradingAgentsLauncher',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX-packed onefile exes are frequently flagged/blocked by Windows
    # Defender and other AVs — keep the launcher unpacked.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['assets/app_icon.ico'],
)
