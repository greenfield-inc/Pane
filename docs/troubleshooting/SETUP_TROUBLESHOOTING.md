# Setup Troubleshooting Guide

## Python distutils Error

If you encounter this error during `pnpm run setup`:
```
ModuleNotFoundError: No module named 'distutils'
```

This happens because Python 3.12+ removed the `distutils` module that `node-gyp` depends on.

### Quick Fix:
```bash
brew install python-setuptools
```

### Alternative: Use Python 3.11 with pyenv

```bash
brew install pyenv
pyenv install 3.11.9
pyenv global 3.11.9
```

Then run `pnpm run setup` again.

## Other Common Issues

### Modified terminal keys appear as escape-sequence text on Windows/WSL

If Alt+Up inserts `[1;3A`, Shift+Left inserts `[1;2D`, or F6 inserts `[17~`,
check whether the application launched from WSL is actually a Windows executable.
A Windows npm launcher can select `node.exe` even when invoked from a Linux shell.

Pane must honor ConPTY's `CSI ? 9001 h` request using xterm's
`vtExtensions.win32InputMode`. Without it, a Windows console application reached
through WSL can receive a complete VT sequence as individual character key
records. A Linux raw-stdin reader can still receive the exact bytes correctly;
this symptom alone does not demonstrate split IPC messages or PTY writes.
The negotiated mode must also survive terminal snapshot restoration. The `@`
interceptor interprets Win32 key records locally and forwards unconsumed records
unchanged. This handling applies to all terminal applications.

The browser regression suite is `tests/terminal-keyboard-input.spec.ts`; it checks
whole input messages for Alt+Up, Shift+Left, Shift+Up, and F6 with and without
negotiated Windows input mode. For transport diagnosis, compare a Linux raw-stdin
reader with a Windows `ReadConsoleInputW` reader launched through WSL: compare
bytes for the former and virtual keys/modifiers for the latter.

See Microsoft's [Win32 input protocol specification](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md).

### electron-rebuild failures
- Ensure Xcode Command Line Tools are installed: `xcode-select --install`
- Clear node_modules and reinstall: `rm -rf node_modules && pnpm install`

### pnpm permission errors
- Never use `sudo` with pnpm
- Fix npm permissions: `npm config set prefix ~/.npm-global`

## Windows Build Requirements

### Spectre-mitigated Libraries Error

If you encounter this error during `pnpm run setup` on Windows:
```
LINK : fatal error LNK1181: cannot open input file 'MSVCRT.lib'
```

Or similar errors mentioning missing `.lib` files, this means you need to install the Spectre-mitigated libraries in Visual Studio.

### Solution:

1. **Install Visual Studio 2022** (Community Edition is free):
   - Download from [https://visualstudio.microsoft.com/](https://visualstudio.microsoft.com/)
   
2. **Install Required Components**:
   - Open **Visual Studio Installer**
   - Click **Modify** on your Visual Studio 2022 installation
   - Go to the **Individual components** tab
   - Search for "Spectre" in the search box
   - Check the following components:
     - `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`
     - `MSVC v143 - VS 2022 C++ ARM64/ARM64EC Spectre-mitigated libs (Latest)` (if building for ARM64)
   - Click **Modify** to install

3. **Restart your terminal** and run `pnpm run setup` again

### Why is this needed?

Node.js native modules on Windows are built with Visual Studio's C++ compiler. Recent security updates require Spectre-mitigated libraries to be installed separately. These libraries provide protection against Spectre vulnerability exploits.

### Alternative: Use Pre-built Binaries

If you only need to run Pane, download the Windows installer from [GitHub Releases](https://github.com/greenfield-inc/Pane/releases/latest) instead of building from source.
