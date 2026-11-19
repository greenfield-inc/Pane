// runpane ask and models: reading each agent's real output (fixtures captured from real runs), through the built package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('./runpane-test-shard');

const { extractAnswer, parseModelList, describeSignIn } = require(path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'ask.js'));
const fixture = (...parts) => fs.readFileSync(path.join(__dirname, 'fixtures', ...parts), 'utf8');

test('reads the answer and cost from each agent\'s headless output', () => {
  const claude = extractAnswer('result-json', fixture('ask', 'claude.json'));
  assert.equal(claude.answer, 'pong');
  assert.ok(claude.costUsd > 0);
  assert.deepEqual(extractAnswer('result-json', fixture('ask', 'cursor.json')), { answer: 'pong', costUsd: undefined });
  // Codex says what it will do before the tool call; the answer is its last message.
  assert.deepEqual(extractAnswer('codex-jsonl', fixture('ask', 'codex.jsonl')), { answer: 'pong' });
  // OpenCode read README.md first; the answer is the last step's text, not the file's contents.
  assert.equal(extractAnswer('opencode-jsonl', fixture('ask', 'opencode.jsonl')).answer, 'pong');
});

test('returns the agent\'s own error when it did not answer', () => {
  assert.deepEqual(extractAnswer('codex-jsonl', fixture('ask', 'codex-signed-out.jsonl')), {
    error: 'Your access token could not be refreshed. Please log out and sign in again.',
  });
  const opencode = '{"type":"error","timestamp":1,"sessionID":"s","error":{"name":"APIError","data":{"message":"User not found.","statusCode":401}}}\n';
  assert.deepEqual(extractAnswer('opencode-jsonl', opencode), { error: 'User not found.' });
  assert.deepEqual(extractAnswer('result-json', '{"type":"result","subtype":"success","is_error":true,"result":"There\'s an issue with the selected model (nosuch)."}'), {
    error: 'There\'s an issue with the selected model (nosuch).', costUsd: undefined,
  });
});

test('lists models in each agent\'s format, skipping hidden ones', () => {
  assert.deepEqual(parseModelList('json-models', fixture('models', 'codex.json')),
    ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  assert.deepEqual(parseModelList('dash-lines', fixture('models', 'cursor.txt')), ['auto', 'gpt-5.3-codex-low', 'gpt-5.3-codex-low-fast', 'gpt-5.3-codex']);
  assert.deepEqual(parseModelList('lines', fixture('models', 'opencode.txt')).slice(0, 3), ['opencode/beam-free', 'opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free']);
  assert.equal(parseModelList('json-models', 'error: unknown command debug'), undefined);
});

test('says sign-in in the agent\'s own words', () => {
  assert.equal(describeSignIn('json-logged-in', '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n', ''), 'signed in (claude.ai)');
  assert.equal(describeSignIn('text', '', 'Logged in using ChatGPT\n'), 'Logged in using ChatGPT');
});

test('passes a prompt with quotes, %, ! and line breaks to the agent unchanged, Windows .cmd shims included', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-ask-'));
  // A stand-in Codex that answers with the prompt it was given, installed the way npm installs it.
  const agent = 'const prompt = require("node:fs").readFileSync(0, "utf8") || process.argv.at(-1);\n'
    + 'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: prompt } }));\n';
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.js'), agent);
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@node "%~dp0codex.js" %*\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n${agent}`, { mode: 0o755 });
  }
  const prompt = 'Why does "npm test" print 100% then stop!?\nSecond line: %PATH% and !VAR!';
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'packages', 'runpane', 'dist', 'cli.js'), 'ask', '--agent', 'codex', '--prompt', prompt, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  fs.rmSync(bin, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).answer, prompt);
});
