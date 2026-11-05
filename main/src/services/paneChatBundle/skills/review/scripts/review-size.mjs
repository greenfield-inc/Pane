#!/usr/bin/env node
// Sizes a review (small, standard or large) from a diff, so every review states its size the same
// way. Uses only node: builtins.
//
//   node review-size.mjs <base>...<head> [--repo <dir>] [--json]
//
// Counts hand-written files and changed lines (lockfiles, generated and vendored files excluded) and
// looks for path-based risk triggers. The rule is the review skill's size table: small is at most
// 10 files and 300 lines with no trigger; large is over 1,000 lines or 30 files, or any trigger;
// standard otherwise. The reviewer may raise the result, never lower it.
// Exit 0 with the size, 2 on bad usage or a git failure.
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const SIZES=['small','standard','large'];
export const LIMITS={small:{files:10,lines:300},large:{files:30,lines:1000}};
const EXCLUDED=[
 /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|flake\.lock)$/,
 /(^|\/)(dist|build|out|coverage|__generated__|generated)\//,
 /\.(min\.(js|css)|generated\.[a-z]+|pb\.go|snap)$/,
 /(^|\/)(vendor|third_party|node_modules)\//,
];
// Path-based, so they can miss a risky change: the reviewer may always raise the size.
const TRIGGERS=[
 {kind:'schema',test:/(^|\/)(migrations?|alembic|db\/schema)\/|\.sql$|(^|\/)schema\.(prisma|rb)$/i},
 {kind:'auth',test:/(^|[\/._-])(auth|authn|authz|oauth|permissions?|rbac|acl|secrets?|credentials?|keychain)([\/._-]|$)|(^|\/)\.env(\.|$)/i},
 {kind:'contract',test:/(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.(proto|graphql|gql)$|\.schema\.json$/i},
 {kind:'irreversible',test:/\.(tf|tfvars)$|(^|\/)(terraform|pulumi|deploy)\/|(^|\/)\.github\/workflows\/[^/]*(release|deploy|publish)[^/]*$/i},
];

export const excluded=file=>EXCLUDED.some(re=>re.test(file));

// git diff --numstat -z output → [{path, added, deleted}]. -z keeps paths verbatim (git would otherwise quote and
// escape unusual ones, hiding them from the triggers); binary files count as 0 lines; a rename keeps its new path.
export function parseNumstat(text){
 const fields=text.split('\0'),out=[];
 for(let i=0;i<fields.length;i++){
  if(!fields[i])continue;
  // Only the first two tabs separate fields; a path may itself contain tabs.
  const [added,deleted,...rest]=fields[i].split('\t'),file=rest.join('\t');
  const path=file===''?(i+=2,fields[i]):file;
  out.push({path,added:added==='-'?0:Number(added),deleted:deleted==='-'?0:Number(deleted)});
 }
 return out;
}

export function sizeReview(changes){
 const counted=changes.filter(c=>!excluded(c.path));
 const files=counted.length,lines=counted.reduce((sum,c)=>sum+c.added+c.deleted,0);
 const triggers=[];
 for(const c of changes)for(const t of TRIGGERS)if(t.test.test(c.path)&&!triggers.some(x=>x.kind===t.kind))triggers.push({kind:t.kind,path:c.path});
 const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`,why=[`${plural(files,'file')}, ${plural(lines,'line')}`];
 let size=files<=LIMITS.small.files&&lines<=LIMITS.small.lines?'small':'standard';
 if(files>LIMITS.large.files)why.push(`over ${LIMITS.large.files} files`);
 if(lines>LIMITS.large.lines)why.push(`over ${LIMITS.large.lines.toLocaleString('en-US')} lines`);
 for(const t of triggers)why.push(`risk trigger ${t.kind} (${t.path})`);
 if(why.length>1)size='large';
 return {size,reason:why.join('; '),files,lines,excluded:changes.length-files,triggers};
}

function main(argv){
 const args=[...argv],flag=name=>{const i=args.indexOf(name);if(i<0)return undefined;const value=args[i+1];args.splice(i,2);return value;};
 const json=args.includes('--json');if(json)args.splice(args.indexOf('--json'),1);
 const repo=flag('--repo')??'.';
 if(args.length!==1){process.stderr.write('Usage: review-size.mjs <base>...<head> [--repo <dir>] [--json]\n');return 2;}
 let numstat;
 try{numstat=execFileSync('git',['diff','--numstat','-z','-M',args[0]],{cwd:repo,maxBuffer:64*1024*1024}).toString();}
 catch(error){process.stderr.write(`git diff failed: ${error.message}\n`);return 2;}
 const result=sizeReview(parseNumstat(numstat));
 process.stdout.write(json?JSON.stringify(result,null,2)+'\n':`Size: ${result.size} because ${result.reason}\n`);
 return 0;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
