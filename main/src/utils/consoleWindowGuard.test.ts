import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Pane has no console of its own, so on Windows a console program it starts
// without `windowsHide: true` (CREATE_NO_WINDOW) opens a visible console
// window: a background poll that forgets it flashes one at the person every
// few seconds (#1621). This test reads the sources that run inside Pane and
// fails on any child_process call that starts one of these programs without
// saying `windowsHide`. A spawn meant to show a window says `windowsHide: false`.
const CONSOLE_PROGRAM = /^(?:powershell|pwsh|cmd|wmic|tasklist|taskkill|where|netstat|wsl|whoami|schtasks)(?:\.exe)?$/iu;
const CHILD_PROCESS_FUNCTIONS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
const ROOTS = ['main/src', 'packages/runpane/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', 'testing']);
const repoRoot = path.resolve(__dirname, '../../..');

interface Finding {
  line: number;
  call: string;
  program: string;
}

function isChildProcessModule(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) && /^(?:node:)?child_process$/u.test(node.text);
}

/** `x` in `promisify(x)` or `util.promisify(x)`, else undefined. */
function promisified(node: ts.Expression | undefined): ts.Expression | undefined {
  if (!node || !ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return name === 'promisify' ? node.arguments[0] : undefined;
}

/**
 * Every child_process call in `source` whose program is a console program and
 * whose options do not set `windowsHide`. A program is read from the string
 * literals of the first argument (`'powershell'`, a template's first word, or
 * the last part of a path built from literals), or from the calls to a local
 * helper that passes its parameter on as the program. A program held only in
 * a variable is not seen.
 */
function findUnhiddenConsoleSpawns(fileName: string, source: string): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  // Local name -> child_process function, and names bound to the module itself.
  const functions = new Map<string, string>();
  const modules = new Set<string>();
  const objectsByName = new Map<string, ts.Expression[]>();

  const bindNamed = (pattern: ts.ObjectBindingPattern) => {
    for (const element of pattern.elements) {
      const original = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.getText(file);
      if (CHILD_PROCESS_FUNCTIONS.has(original) && ts.isIdentifier(element.name)) functions.set(element.name.text, original);
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildProcessModule(node.moduleSpecifier) && node.importClause) {
      const { name, namedBindings } = node.importClause;
      if (name) modules.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) modules.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const original = (element.propertyName ?? element.name).text;
          if (CHILD_PROCESS_FUNCTIONS.has(original)) functions.set(element.name.text, original);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      // `require('child_process')` or `await import('child_process')`.
      let init: ts.Expression = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      const loadsModule = ts.isCallExpression(init) && init.arguments.length === 1 && isChildProcessModule(init.arguments[0])
        && (init.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(init.expression) && init.expression.text === 'require'));
      if (loadsModule && ts.isObjectBindingPattern(node.name)) bindNamed(node.name);
      if (loadsModule && ts.isIdentifier(node.name)) modules.add(node.name.text);
      if (ts.isIdentifier(node.name)) objectsByName.set(node.name.text, [...objectsByName.get(node.name.text) ?? [], node.initializer]);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  // `const execFileAsync = promisify(execFile)`, also as a class property.
  const collectPromisified = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)) {
      const inner = promisified(node.initializer);
      if (inner && ts.isIdentifier(inner) && functions.has(inner.text)) functions.set(node.name.text, functions.get(inner.text) ?? inner.text);
    }
    ts.forEachChild(node, collectPromisified);
  };
  collectPromisified(file);

  const calledFunction = (callee: ts.Expression): string | undefined => {
    if (ts.isIdentifier(callee)) return functions.get(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) return functions.get(callee.name.text);
    if (ts.isIdentifier(callee.expression) && modules.has(callee.expression.text) && CHILD_PROCESS_FUNCTIONS.has(callee.name.text)) return callee.name.text;
    return undefined;
  };

  const consoleProgram = (argument: ts.Expression): string | undefined => {
    const texts: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) texts.push(node.text);
      else if (ts.isTemplateExpression(node)) texts.push(node.head.text);
      ts.forEachChild(node, visit);
    };
    visit(argument);
    return texts.map(text => path.win32.basename(text.trim().split(/\s+/u)[0] ?? '')).find(word => CONSOLE_PROGRAM.test(word));
  };

  // Whether an options argument names windowsHide, following spreads,
  // identifiers bound to object literals in this file, and the arguments of a
  // helper that builds the options (`shellExecOpts({ windowsHide: true })`).
  const namesWindowsHide = (node: ts.Expression, seen = new Set<string>()): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return namesWindowsHide(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      seen.add(node.text);
      return (objectsByName.get(node.text) ?? []).some(value => namesWindowsHide(value, seen));
    }
    if (ts.isCallExpression(node)) return node.arguments.some(argument => namesWindowsHide(argument, seen));
    if (!ts.isObjectLiteralExpression(node)) return false;
    return node.properties.some(property => ts.isSpreadAssignment(property)
      ? namesWindowsHide(property.expression, seen)
      : property.name !== undefined && property.name.getText(file) === 'windowsHide');
  };

  // A local helper that hands one of its parameters to child_process as the
  // program (`function run(command, args) { execFile(command, ...) }`): calls
  // to it name the program instead, so they are checked against its options.
  const wrappers = new Map<string, { parameter: number; call: string; hidden: boolean }>();
  // The named function whose parameter `program` is, through any callbacks
  // nested inside it (`new Promise(resolve => execFile(command, ...))`).
  const owningFunction = (node: ts.Node, program: string): { name: string; parameter: number } | undefined => {
    for (let current = node.parent; current; current = current.parent) {
      if (!ts.isFunctionDeclaration(current) && !ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
      const parameter = current.parameters.findIndex(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === program);
      if (parameter < 0) continue;
      if (ts.isFunctionDeclaration(current)) return current.name ? { name: current.name.text, parameter } : undefined;
      return ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name) ? { name: current.parent.name.text, parameter } : undefined;
    }
    return undefined;
  };
  const collectWrappers = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isIdentifier(node.arguments[0])) {
      const call = calledFunction(node.expression);
      const owner = call ? owningFunction(node, node.arguments[0].text) : undefined;
      if (call && owner) {
        wrappers.set(owner.name, { parameter: owner.parameter, call, hidden: node.arguments.slice(1).some(argument => namesWindowsHide(argument)) });
      }
    }
    ts.forEachChild(node, collectWrappers);
  };
  collectWrappers(file);

  const findings: Finding[] = [];
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const call = calledFunction(node.expression);
      const program = call && consoleProgram(node.arguments[0]);
      if (call && program && !node.arguments.slice(1).some(argument => namesWindowsHide(argument))) {
        findings.push({ line: lineOf(node), call, program });
      }
      const wrapper = ts.isIdentifier(node.expression) ? wrappers.get(node.expression.text) : undefined;
      const wrapped = wrapper && node.arguments[wrapper.parameter] && consoleProgram(node.arguments[wrapper.parameter]);
      if (wrapper && wrapped && !wrapper.hidden) {
        findings.push({ line: lineOf(node), call: `${node.expression.getText(file)} (${wrapper.call})`, program: wrapped });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(relative);
    } else if (/\.[cm]?tsx?$/u.test(entry.name) && !/\.(?:test|spec)\.[cm]?tsx?$|\.d\.ts$/u.test(entry.name)) {
      yield relative;
    }
  }
}

describe('console windows on Windows', () => {
  it('every background spawn of a console program in Pane passes windowsHide', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of ROOTS.flatMap(root => [...sourceFiles(root)])) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      if (!source.includes('child_process')) continue;
      scanned += 1;
      for (const finding of findUnhiddenConsoleSpawns(file, source)) {
        offenders.push(`${file}:${finding.line} ${finding.call}('${finding.program}', ...)`);
      }
    }
    expect(scanned, 'the scan found no file that uses child_process; is the repo root right?').toBeGreaterThan(20);
    expect(offenders, 'These start a console program without windowsHide, so on Windows each one flashes a console window. '
      + 'Pass `windowsHide: true` in its options, or `windowsHide: false` where the window is wanted.').toEqual([]);
  });

  describe('the detector', () => {
    const find = (source: string) => findUnhiddenConsoleSpawns('sample.ts', source).map(({ call, program }) => `${call}:${program}`);

    it('flags console programs started without windowsHide, however the call is bound', () => {
      expect(find(`
        import { exec, execFile, execSync, spawn as start } from 'node:child_process';
        import * as childProcess from 'child_process';
        import { promisify } from 'util';
        const execFileAsync = promisify(execFile);
        class Manager { readonly execAsync = promisify(exec); stop() { return this.execAsync(\`taskkill /F /PID \${1}\`); } }
        execFileAsync('powershell', ['-Command', 'x'], { timeout: 1 });
        execFile(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [], () => {});
        execSync(\`wmic process where ProcessId=\${1} get Name\`, { encoding: 'utf8' });
        start('cmd.exe', ['/c', 'x']);
        childProcess.spawnSync('netstat', ['-ano']);
      `)).toEqual(['exec:taskkill', 'execFile:powershell', 'execFile:powershell.exe', 'execSync:wmic', 'spawn:cmd.exe', 'spawnSync:netstat']);
    });

    it('accepts windowsHide inline, through a spread or a named options object, and windowsHide: false', () => {
      expect(find(`
        import { execFile, spawn } from 'child_process';
        const options = { timeout: 1, windowsHide: true };
        execFile('powershell', [], { windowsHide: true }, () => {});
        execFile('pwsh', [], options, () => {});
        execFile('taskkill', [], { ...options, env: {} }, () => {});
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k'], { detached: true, windowsHide: false });
      `)).toEqual([]);
    });

    it('checks calls to a local helper that passes its program on, against the options of that helper', () => {
      expect(find(`
        import { execFile, spawnSync } from 'child_process';
        function run(command: string, args: string[]) {
          return new Promise(resolve => execFile(command, args, { encoding: 'utf8' }, (error, stdout) => resolve(stdout)));
        }
        const lookUp = (command: string) => spawnSync(command, [], { windowsHide: true });
        run('netstat', ['-ano']);
        run('lsof', ['-i']);
        lookUp('where');
      `)).toEqual(['run (execFile):netstat']);
    });

    it('ignores other programs, shell names that are not spawned, and calls that are not child_process', () => {
      expect(find(`
        import { execFile } from 'child_process';
        const shells = ['powershell', 'pwsh', 'cmd'];
        quoteShellWord(word, 'cmd');
        if (shell === 'powershell') run('powershell', []);
        execFile('git', ['status'], () => {});
        execFile('ps', ['-Ao', 'pid='], () => {});
      `)).toEqual([]);
    });
  });
});
