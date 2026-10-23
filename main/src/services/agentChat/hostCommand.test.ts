import { describe, expect, it } from 'vitest';
import { hostCommand, nativeCommand } from './hostCommand';

describe('workspace host command invocation', () => {
  it('runs Windows npm shims through cmd with literal arguments and no shell interpolation', () => {
    expect(hostCommand('C:\\Program Files\\nodejs\\npm.cmd', ['install', '--prefix', 'C:\\Users\\A B\\adapters'], 'win32')).toEqual({
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" "install" "--prefix" "C:\\Users\\A B\\adapters""'],
      windowsVerbatimArguments: true,
    });
    expect(() => hostCommand('npm.cmd', ['%USERPROFILE%'], 'win32')).toThrow(/literal/i);
  });
});

it('invokes a quoted native executable in PowerShell and refuses arguments cmd would silently discard', () => {
  expect(nativeCommand('C:\\Program Files\\Codex\\codex.exe', ['resume', 'fork-id'], 'pwsh.exe')).toBe("& 'C:\\Program Files\\Codex\\codex.exe' 'resume' 'fork-id'");
  expect(() => nativeCommand('codex.exe', ['--config', 'model="chosen"'], 'cmd')).toThrow(/literally/i);
});

it('resolves only the npm shim’s own provider script and preserves literal configuration argv', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const path = await import('path');
  const { providerCommand, providerScript } = await import('./hostCommand');
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-provider-shim-'));
  try {
    const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(path.dirname(script), { recursive: true }); writeFileSync(script, '// provider-owned script');
    const shim = path.join(directory, 'codex.cmd');
    writeFileSync(shim, '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    expect(providerCommand(shim, ['--config', 'model="chosen"'], 'codex')).toEqual({ executable: process.execPath, args: [script, '--config', 'model="chosen"'] });
    expect(providerScript(shim, 'claude')).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
