import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {auditFiles,auditRepository} from './audit-fork.mjs';

async function fixture(t,files) {
  const root=await mkdtemp(join(tmpdir(),'fork-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,content] of Object.entries(files)){const path=join(root,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content);}
  return root;
}
test('private files are rejected while synthetic fixtures and empty examples are allowed',async t=>{
  const files={'ops/key.pem':'material','ops/credentials.json':'{}','.env.production':'X=1',
    'ops/browser-login-vault.json':'encrypted-data','ops/browser-login-vault.json.1234.tmp':'encrypted-data',
    'BUSINESS_CONTEXT.md':'private details','agent-context.md':'operator context','.openclaw-private/state.json':'{}',
    'tests/fixtures/key.pem':'synthetic fixture','apps/.env.example':'API_KEY=\nTOKEN=""\nPORT=8787\n',
    'integrations.example.json':JSON.stringify({NAVER_MAIL_USERNAME:'',NAVER_MAIL_PASSWORD:'',FAL_KEY:''})};
  const root=await fixture(t,files),findings=await auditFiles(root,Object.keys(files));
  assert.equal(findings.length,8);assert.ok(findings.every(finding=>finding.rule==='Operator private file must not be tracked'));
});
test('nonempty example credentials are detected without leaking their values',async t=>{
  const secret='synthetic-sensitive-value';
  const files={'.env.example':`API_KEY=${secret}\nPUBLIC_KEY='${secret}' # comment\nPORT=8787\n`,
    'settings.example.json':JSON.stringify({nested:{apiKey:secret},NAVER_MAIL_USERNAME:'private-account',FAL_KEY:secret}),
    'deploy.env.example':'TOKEN= # disabled\nPASSWORD="" # fill locally\n',
    'docs/README.md':'A token is configured at runtime.'};
  const root=await fixture(t,files),findings=await auditFiles(root,Object.keys(files));
  assert.equal(findings.length,5);assert.ok(findings.every(finding=>finding.rule==='Example credential must be empty'));
  assert.doesNotMatch(JSON.stringify(findings),/synthetic-sensitive-value|private-account/);
});
test('embedded PEM private key material is rejected outside fixture paths',async t=>{
  const marker='-----BEGIN '+'PRIVATE KEY-----\n'+'A'.repeat(64)+'\n-----END PRIVATE KEY-----';
  const files={'docs/setup.txt':marker,'fixtures/private-key.txt':marker,'docs/template.txt':'-----BEGIN PRIVATE KEY-----\nfill locally'};
  const root=await fixture(t,files),findings=await auditFiles(root,Object.keys(files));
  assert.deepEqual(findings,[{file:'docs/setup.txt',rule:'Private key material must not be tracked'}]);
});
test('repository audit considers tracked files and skips pending deletions',async t=>{
  const files={'BUSINESS_CONTEXT.md':'private original','apps/.env.example':'API_KEY=\n'};
  const root=await fixture(t,files);execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  await rm(join(root,'BUSINESS_CONTEXT.md'));await writeFile(join(root,'untracked.key'),'never tracked');
  assert.deepEqual(await auditRepository(root),[]);
  const result=spawnSync(process.execPath,[resolve('scripts/audit-fork.mjs')],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0);assert.match(result.stdout,/Fork audit passed/);
});
test('CLI reports only safe finding metadata',async t=>{
  const secret='never-print-this-private-value';const root=await fixture(t,{'.env.example':`SECRET=${secret}\n`});
  execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  const result=spawnSync(process.execPath,[resolve('scripts/audit-fork.mjs')],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/Example credential must be empty/);assert.ok(!result.stderr.includes(secret));
});
