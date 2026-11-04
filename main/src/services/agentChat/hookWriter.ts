import { recordNativeHook } from './nativeHookJournal';

// Invoked by the native CLI's documented command-hook interface. Never import
// the Electron service graph here or log the provider's hook payload.
const file = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (input.length <= 2 * 1024 * 1024) input += chunk;
});
process.stdin.on('end', () => {
  if (!file) return;
  try { recordNativeHook(file, JSON.parse(input)); }
  catch { try { recordNativeHook(file, { invalid: true }); } catch { /* native operation remains available */ } }
});
