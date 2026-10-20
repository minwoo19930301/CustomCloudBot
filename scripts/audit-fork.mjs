#!/usr/bin/env node
/** Guard the portable source tree; never print credential values or personal file contents. */
import {execFileSync} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const EXAMPLE=/(?:^|[/. _-])(?:example|sample|template)(?:[/. _-]|$)/i;
const FIXTURE=/(?:^|\/)(?:fixtures?|__fixtures__)(?:\/|$)/i;
const PRIVATE_DIR=/(?:^|\/)(?:\.openclaw-private|\.oci|\.ssh|secrets|vault)(?:\/|$)/i;
const PRIVATE_NAME=/^(?:private-integrations|integrations|credentials|deployment|setup-vault|browser-login-vault)\.json(?:\.[a-f0-9-]+\.tmp)?$|^(?:BUSINESS_CONTEXT|agent-context)\.md$/i;
const PRIVATE_KEY=/\.(?:pem|key|p12|pfx)$/i;
const PRIVATE_ENV=/^\.env(?:\.|$)/;
const PEM=/-----BEGIN (?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{20,}/;

export function credentialField(key) {
  const normalized=String(key).replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[-.]/g,'_').toUpperCase();
  return /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|PUBLIC_KEY|CLIENT_ID|CLIENT_SECRET|USERNAME|EMAIL|TENANCY|FINGERPRINT|USER_OCID|CLOUD_NAME|APP_ID|KEY)(?:_\d+)?$/.test(normalized);
}
function blank(value) {return value===''||value===null||value===undefined;}
function envValue(raw) {
  const value=raw.trim();if(value.startsWith('#'))return '';
  if(value[0]==='"'||value[0]==="'"){const end=value.indexOf(value[0],1);return end<0?value:value.slice(1,end);}
  return value.replace(/\s+#.*$/,'').trim();
}
function exampleIssues(file,text) {
  const findings=[];
  if(file.toLowerCase().endsWith('.json')) {
    let object;try{object=JSON.parse(text);}catch{return [{file,rule:'Example JSON cannot be checked'}];}
    const walk=value=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){
      if(credentialField(key)&&!blank(item))findings.push({file,rule:'Example credential must be empty'});
      else if(item&&typeof item==='object')walk(item);
    }};
    walk(object);
  } else if(PRIVATE_ENV.test(basename(file))||/\.(?:env|ya?ml)(?:\.|$)/i.test(basename(file))) {
    for(const [index,line] of text.split(/\r?\n/).entries()) {
      const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:)\s*(.*)$/);
      if(match&&credentialField(match[1])&&!blank(envValue(match[2])))findings.push({file,line:index+1,rule:'Example credential must be empty'});
    }
  }
  return findings;
}

export async function auditFiles(root,files) {
  const findings=[];
  for(const file of files) {
    let info;try{info=await lstat(resolve(root,file));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    // Test fixtures deliberately contain synthetic private data; production examples do not.
    if(FIXTURE.test(file))continue;
    const example=EXAMPLE.test(file),name=basename(file);
    if(!example&&(PRIVATE_DIR.test(file)||PRIVATE_NAME.test(name)||PRIVATE_KEY.test(name)||PRIVATE_ENV.test(name))){findings.push({file,rule:'Operator private file must not be tracked'});continue;}
    if(info.isSymbolicLink()){findings.push({file,rule:'Tracked symlink needs an explicit fixture location'});continue;}
    if(!info.isFile())continue;
    if(info.size>2*1024*1024){if(example&&(/\.json$/i.test(file)||PRIVATE_ENV.test(name)))findings.push({file,rule:'Example configuration is too large to check'});continue;}
    const bytes=await readFile(resolve(root,file));if(bytes.includes(0))continue;
    const text=bytes.toString('utf8');
    if(PEM.test(text))findings.push({file,rule:'Private key material must not be tracked'});
    if(example)findings.push(...exampleIssues(file,text));
  }
  return findings;
}
export async function auditRepository(cwd=process.cwd()) {
  const root=execFileSync('git',['rev-parse','--show-toplevel'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);
  return auditFiles(root,files);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const findings=await auditRepository();
    for(const finding of findings)console.error(`${finding.file}${finding.line?':'+finding.line:''}: ${finding.rule}`);
    if(findings.length){console.error(`Fork audit failed: ${findings.length} finding(s). Values were not printed.`);process.exitCode=1;}
    else console.log('Fork audit passed: tracked operator files absent; example credentials are empty.');
  }catch{console.error('Fork audit could not inspect the tracked source tree.');process.exitCode=2;}
}
