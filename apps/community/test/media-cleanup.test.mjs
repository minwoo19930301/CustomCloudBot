import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanupOrphans} from '../media.mjs';

async function fixture(t) {
  const mediaDir=await mkdtemp(join(tmpdir(),'community-shared-media-'));
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE attachments(id TEXT PRIMARY KEY,room_id TEXT,path TEXT,created_at INTEGER,bound_at INTEGER)');
  t.after(async()=>{db.close();await rm(mediaDir,{recursive:true,force:true});});
  const old=Date.now()-3*86400000;
  async function file(id) {
    const path=join(mediaDir,id);
    await writeFile(path,'retained fork image');
    await utimes(path,old/1000,old/1000);
    return path;
  }
  const add=(id,room,path,boundAt=old)=>db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(id,room,path,old,boundAt);
  return {db,mediaDir,file,add};
}

test('cleanup keeps fork bytes after the attachment with the original filename is deleted',async t=>{
  const f=await fixture(t),original=randomUUID(),fork=randomUUID();
  const path=await f.file(original);
  f.add(original,'alice-room',path);
  f.add(fork,'bob-fork',path);
  f.db.prepare('DELETE FROM attachments WHERE room_id=?').run('alice-room');

  await cleanupOrphans(f.db,f.mediaDir);
  assert.equal(await readFile(path,'utf8'),'retained fork image');
  assert.equal(f.db.prepare('SELECT room_id FROM attachments WHERE id=?').get(fork).room_id,'bob-fork');

  f.db.prepare('DELETE FROM attachments WHERE room_id=?').run('bob-fork');
  await cleanupOrphans(f.db,f.mediaDir);
  await assert.rejects(readFile(path),error=>error.code==='ENOENT');
});

test('expiring an unbound attachment never unlinks a path still used by a bound fork',async t=>{
  const f=await fixture(t),original=randomUUID(),fork=randomUUID(),orphan=randomUUID();
  const sharedPath=await f.file(original),orphanPath=await f.file(orphan);
  f.add(original,'alice-room',sharedPath,null);
  f.add(fork,'bob-fork',sharedPath);
  f.add(orphan,'alice-room',orphanPath,null);

  await cleanupOrphans(f.db,f.mediaDir);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM attachments').get().count,1);
  assert.equal(await readFile(sharedPath,'utf8'),'retained fork image');
  await assert.rejects(readFile(orphanPath),error=>error.code==='ENOENT');
});
