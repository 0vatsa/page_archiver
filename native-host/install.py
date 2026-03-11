#!/usr/bin/env python3
"""
install.py — Page Archiver native messaging host installer

Supports:
  Browsers : Chrome, Brave
  OS       : Linux, macOS, Windows

Usage:
  python3 install.py                  # auto-detects browser, prompts for extension ID
  python3 install.py --uninstall      # removes the registered host manifest

The extension ID is the 32-character string shown under the extension name
on chrome://extensions or brave://extensions.
"""

import sys
import os
import json
import shutil
import argparse
import platform
import subprocess
import textwrap

# ── Constants ─────────────────────────────────────────────────────────────────

HOST_NAME    = "com.page_archiver.host"
HOST_SCRIPT  = "page_archiver_host.py"
CONFIG_FILE  = "page_archiver_host.conf"
DESCRIPTION  = "Page Archiver native host — writes to SQLite"

DEFAULT_DB_PATH = os.path.join(
    os.path.expanduser("~"), "Downloads",
    "page-archiver", "_sqlitedb", "page_archiver.db"
)

DEFAULT_GITHUB_REPOS_DIR = os.path.join(
    os.path.expanduser("~"), "Downloads",
    "page-archiver", "github_repos"
)

# Native messaging host manifest directories per OS per browser
# https://developer.chrome.com/docs/apps/nativeMessaging/#native-messaging-host-location
NM_DIRS = {
    "Linux": {
        "chrome": [
            "~/.config/google-chrome/NativeMessagingHosts",
        ],
        "brave": [
            "~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
        ],
    },
    "Darwin": {
        "chrome": [
            "~/Library/Application Support/Google/Chrome/NativeMessagingHosts",
        ],
        "brave": [
            "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
        ],
    },
    "Windows": {
        # On Windows the manifest path is written to the registry, not a folder.
        # We write the file to AppData and then set the registry key.
        "chrome": [
            r"%APPDATA%\Google\Chrome\User Data\NativeMessagingHosts",
        ],
        "brave": [
            r"%APPDATA%\BraveSoftware\Brave-Browser\User Data\NativeMessagingHosts",
        ],
    },
}

REGISTRY_KEYS = {
    "chrome": r"SOFTWARE\Google\Chrome\NativeMessagingHosts",
    "brave":  r"SOFTWARE\BraveSoftware\Brave-Browser\NativeMessagingHosts",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def detect_os():
    s = platform.system()
    if s not in ("Linux", "Darwin", "Windows"):
        raise SystemExit(f"Unsupported OS: {s}")
    return s

def detect_browsers(os_name):
    """Return list of installed browsers we can find."""
    found = []
    if os_name == "Linux":
        for cmd, name in [("google-chrome", "chrome"), ("brave-browser", "brave"), ("brave", "brave")]:
            if shutil.which(cmd):
                if name not in found:
                    found.append(name)
        # Also check profile directories even if binary isn't in PATH
        for path, name in [
            ("~/.config/google-chrome", "chrome"),
            ("~/.config/BraveSoftware", "brave"),
        ]:
            if os.path.isdir(os.path.expanduser(path)) and name not in found:
                found.append(name)
    elif os_name == "Darwin":
        for app, name in [
            ("/Applications/Google Chrome.app", "chrome"),
            ("/Applications/Brave Browser.app", "brave"),
        ]:
            if os.path.isdir(app) and name not in found:
                found.append(name)
    elif os_name == "Windows":
        import winreg
        for key_path, name in [
            (r"SOFTWARE\Google\Chrome", "chrome"),
            (r"SOFTWARE\BraveSoftware\Brave-Browser", "brave"),
        ]:
            try:
                winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path)
                found.append(name)
            except FileNotFoundError:
                pass
    return found or ["chrome"]  # default fallback

def pick_browser(browsers):
    if len(browsers) == 1:
        return browsers[0]
    print("\nDetected browsers:")
    for i, b in enumerate(browsers, 1):
        print(f"  {i}. {b.capitalize()}")
    while True:
        choice = input("Select browser [1]: ").strip() or "1"
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(browsers):
                return browsers[idx]
        except ValueError:
            pass
        print("  Invalid choice, try again.")

def prompt_extension_id():
    print()
    print("Enter your extension ID.")
    print("Find it at:  brave://extensions  or  chrome://extensions")
    print("It looks like: abcdefghijklmnopqrstuvwxyzabcdef  (32 characters)")
    print()
    while True:
        eid = input("Extension ID: ").strip()
        if len(eid) == 32 and eid.isalpha() and eid.islower():
            return eid
        print("  That doesn't look right — should be 32 lowercase letters. Try again.")

def get_host_script_path():
    """Absolute path to page_archiver_host.py, next to this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, HOST_SCRIPT)
    if not os.path.isfile(path):
        raise SystemExit(f"ERROR: Host script not found at {path}")
    return path

def build_manifest(host_script_path, extension_id):
    return {
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": host_script_path,
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{extension_id}/"
        ],
    }

# ── Linux / macOS install ─────────────────────────────────────────────────────

def install_posix(os_name, browser, extension_id):
    host_script = get_host_script_path()

    # Make host executable
    os.chmod(host_script, 0o755)

    manifest = build_manifest(host_script, extension_id)
    manifest_filename = f"{HOST_NAME}.json"

    dirs = [os.path.expanduser(d) for d in NM_DIRS[os_name][browser]]
    nm_dir = dirs[0]
    os.makedirs(nm_dir, exist_ok=True)
    manifest_path = os.path.join(nm_dir, manifest_filename)

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print()
    print("Native host installed.")
    print(f"  Manifest : {manifest_path}")
    print(f"  Host     : {host_script}")
    print(f"  DB       : ~/page-archiver/archive.db  (created on first capture)")
    print()
    print("Restart the browser fully (quit and reopen) for changes to take effect.")
    print()
    print("To query your archive:")
    print("  sqlite3 ~/page-archiver/archive.db")
    print('  > SELECT url, captured_at, trigger FROM snapshots ORDER BY captured_at DESC LIMIT 20;')
    print()
    return manifest_path

# ── Windows install ───────────────────────────────────────────────────────────

def install_windows(browser, extension_id):
    import winreg

    host_script = get_host_script_path()

    # Resolve python executable — use pythonw.exe to avoid a console window popping up
    python_exe = shutil.which("pythonw") or shutil.which("python") or sys.executable
    if python_exe.endswith("python.exe"):
        python_exe = python_exe.replace("python.exe", "pythonw.exe")
        if not os.path.isfile(python_exe):
            python_exe = sys.executable

    # Write a tiny .bat wrapper — Chrome native messaging requires a single
    # executable path, so we wrap the Python script.
    here = os.path.dirname(os.path.abspath(__file__))
    bat_path = os.path.join(here, "page_archiver_host.bat")
    with open(bat_path, "w") as f:
        f.write(f'@echo off\n"{python_exe}" "{host_script}" %*\n')

    manifest = build_manifest(bat_path, extension_id)
    manifest_filename = f"{HOST_NAME}.json"

    nm_dir = os.path.expandvars(NM_DIRS["Windows"][browser][0])
    os.makedirs(nm_dir, exist_ok=True)
    manifest_path = os.path.join(nm_dir, manifest_filename)

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Write registry key
    reg_key_path = REGISTRY_KEYS[browser] + "\\" + HOST_NAME
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_key_path) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)
        print()
        print("Native host installed.")
        print(f"  Manifest  : {manifest_path}")
        print(f"  Wrapper   : {bat_path}")
        print(f"  Host      : {host_script}")
        print(f"  Registry  : HKCU\\{reg_key_path}")
        print()
        print("Restart the browser fully for changes to take effect.")
    except PermissionError:
        raise SystemExit("ERROR: Could not write to registry. Try running as Administrator.")

    return manifest_path

# ── Uninstall ─────────────────────────────────────────────────────────────────

def uninstall(os_name, browser):
    manifest_filename = f"{HOST_NAME}.json"
    removed = []

    if os_name == "Windows":
        import winreg
        reg_key_path = REGISTRY_KEYS[browser]
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, reg_key_path, 0, winreg.KEY_ALL_ACCESS) as key:
                winreg.DeleteKey(key, HOST_NAME)
            removed.append(f"Registry key: HKCU\\{reg_key_path}\\{HOST_NAME}")
        except FileNotFoundError:
            pass

    dirs = NM_DIRS[os_name][browser]
    for d in [os.path.expandvars(os.path.expanduser(d)) for d in dirs]:
        path = os.path.join(d, manifest_filename)
        if os.path.isfile(path):
            os.remove(path)
            removed.append(f"Manifest: {path}")

    if removed:
        print("\nUninstalled:")
        for r in removed:
            print(f"  {r}")
    else:
        print("\nNothing to uninstall — manifest not found.")
    print()

# ── Main ──────────────────────────────────────────────────────────────────────

def prompt_db_path():
    print()
    print(f"Database path (press Enter for default):")
    print(f"  Default: {DEFAULT_DB_PATH}")
    val = input("Path: ").strip()
    if not val:
        return DEFAULT_DB_PATH
    return os.path.expandvars(os.path.expanduser(val))

def prompt_github_dir():
    print()
    print("GitHub clone directory (press Enter for default):")
    print(f"  Default: {DEFAULT_GITHUB_REPOS_DIR}")
    val = input("Path: ").strip()
    if not val:
        return DEFAULT_GITHUB_REPOS_DIR
    return os.path.expandvars(os.path.expanduser(val))

def write_conf(db_path, github_dir):
    here = os.path.dirname(os.path.abspath(__file__))
    conf_path = os.path.join(here, CONFIG_FILE)
    with open(conf_path, "w") as f:
        f.write(f"# Page Archiver native host config\n")
        f.write(f"db_path = {db_path}\n")
        f.write(f"github_repos_dir = {github_dir}\n")
    return conf_path

def main():
    parser = argparse.ArgumentParser(
        description="Page Archiver native host installer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""
        Examples:
          python3 install.py                    # guided install
          python3 install.py --uninstall        # remove host registration
          python3 install.py --browser brave    # skip browser detection
        """),
    )
    parser.add_argument("--uninstall", action="store_true", help="Remove the native host registration")
    parser.add_argument("--browser",   choices=["chrome", "brave"], help="Target browser (skips auto-detect)")
    args = parser.parse_args()

    os_name  = detect_os()
    browsers = [args.browser] if args.browser else detect_browsers(os_name)
    browser  = pick_browser(browsers)

    print(f"\nPage Archiver — native host installer")
    print(f"OS: {os_name}   Browser: {browser.capitalize()}")

    if args.uninstall:
        uninstall(os_name, browser)
        return

    extension_id = prompt_extension_id()
    db_path      = prompt_db_path()
    github_dir   = prompt_github_dir()
    conf_path    = write_conf(db_path, github_dir)
    print(f"  Config written: {conf_path}")

    if os_name == "Windows":
        install_windows(browser, extension_id)
    else:
        install_posix(os_name, browser, extension_id)

if __name__ == "__main__":
    main()
