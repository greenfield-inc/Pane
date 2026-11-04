import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { RunpaneError } from './errors';

export function identifyPythonCli(python: string, expected: string) {
  const script = `import json,sys,site,os,runpane.cli,importlib.metadata as m
p=os.path.realpath(runpane.cli.__file__)
u=site.getusersitepackages()
print(json.dumps(dict(entrypoint=p,version=m.version('runpane'),prefix=os.path.dirname(os.path.dirname(p)),user=os.path.commonpath([p,u])==os.path.realpath(u),python=sys.executable)))`;
  const result = decodeBoundary(JSON.parse(execFileSync(python, ['-c', script], { encoding: 'utf8', timeout: 15_000 })), boundary.object({ entrypoint: boundary.string, version: boundary.string, prefix: boundary.string, user: boundary.boolean, python: boundary.string }));
  if (fs.realpathSync(result.entrypoint) !== fs.realpathSync(expected)) throw new RunpaneError('ERR_UPDATE_PIP_OWNER', 'The Python runtime resolved a different runpane package. Nothing was changed.', 'Invoke runpane from the Python environment that owns it.');
  fs.accessSync(result.prefix, fs.constants.W_OK);
  execFileSync(result.python, ['-m', 'pip', '--version'], { timeout: 15_000 });
  return { owner: 'pip' as const, entrypoint: result.entrypoint, prefix: result.prefix, version: result.version, packageManager: result.python, pipUser: result.user };
}

export interface StagedPythonCli { version: string; archive: string; packageRoot: string }
export function stagePythonCli(python: string, requested: string, directory: string): StagedPythonCli {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  execFileSync(python, ['-m', 'pip', 'download', '--disable-pip-version-check', '--no-deps', '--only-binary=:all:', '--dest', directory, requested === 'latest' ? 'runpane' : `runpane==${requested.replace(/^v/, '')}`], { timeout: 180_000, stdio: 'pipe' });
  const wheels = fs.readdirSync(directory).filter(file => file.endsWith('.whl'));
  if (wheels.length !== 1) throw new Error('pip did not stage exactly one wheel.');
  const archive = path.join(directory, wheels[0]);
  const script = `import sys,zipfile,email,json
with zipfile.ZipFile(sys.argv[1]) as z:
 names=[n for n in z.namelist() if n.endswith('.dist-info/METADATA')]
 if len(names)!=1: raise ValueError('Invalid wheel metadata')
 m=email.message_from_bytes(z.read(names[0]))
 if m['Name']!='runpane': raise ValueError('Wrong wheel package')
 print(json.dumps(dict(version=m['Version'])))`;
  const metadata = decodeBoundary(JSON.parse(execFileSync(python, ['-c', script, archive], { encoding: 'utf8', timeout: 15_000 })), boundary.object({ version: boundary.nonEmptyString }));
  return { version: metadata.version, archive, packageRoot: directory };
}

export function installPythonCli(python: string, archive: string, user: boolean): void {
  execFileSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--no-deps', '--upgrade', ...(user ? ['--user'] : []), archive], { timeout: 180_000, stdio: 'pipe' });
}
