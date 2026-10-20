import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {unlink} from 'node:fs/promises';

const fail=(status,message)=>Object.assign(new Error(message),{status});
/** Permanently remove owned conversations; never other users' rooms or account settings. */
export function createConversationDeletion({db,mediaDir,excludedRoomIds=[],isBusy=()=>false,onDeleted=()=>{}}) {
  const excluded=new Set(excludedRoomIds);
  const hasTable=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  function snapshot(userId) {
    const rooms=db.prepare('SELECT id,name FROM rooms WHERE owner_id=? ORDER BY id').all(userId).filter(room=>!excluded.has(room.id));
    let messages=0,attachments=0,shared=0;
    const version=[];
    for(const room of rooms) {
      const messageRows=db.prepare('SELECT id,text FROM messages WHERE room_id=? ORDER BY id').all(room.id);
      const files=db.prepare('SELECT id FROM attachments WHERE room_id=? ORDER BY id').all(room.id);
      messages+=messageRows.length; attachments+=files.length;
      const members=db.prepare('SELECT user_id,role FROM room_members WHERE room_id=? ORDER BY user_id').all(room.id);
      shared+=Number(members.some(member=>member.user_id!==userId));
      version.push([room.id,room.name,members,messageRows,files]);
    }
    const fingerprint=createHash('sha256').update(userId+'\0'+JSON.stringify(version)).digest('hex');
    return {rooms,messages,attachments,shared,fingerprint};
  }
  function preview(userId) {const data=snapshot(userId);return {...data,count:data.rooms.length};}
  async function removeAll(userId,fingerprint) {
    if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))throw fail(400,'삭제할 대화 목록을 먼저 확인해 주세요.');
    let paths=[],deleted=[];
    db.exec('BEGIN IMMEDIATE');
    try {
      const data=snapshot(userId);
      if(data.fingerprint!==fingerprint)throw fail(409,'대화가 변경되었습니다. 삭제 목록을 다시 확인해 주세요.');
      deleted=data.rooms.map(room=>room.id);
      if(deleted.some(isBusy))throw fail(409,'진행 중인 작업이 끝난 뒤 삭제해 주세요.');
      const ids=new Set(deleted);
      for(const roomId of deleted) {
        if(hasTable('routine_runs')&&db.prepare("SELECT 1 FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id WHERE r.room_id=? AND rr.status='running'").get(roomId))throw fail(409,'실행 중인 루틴이 끝난 뒤 삭제해 주세요.');
        if(hasTable('mail_agent_jobs')&&db.prepare("SELECT 1 FROM mail_agent_jobs WHERE room_id=? AND status IN ('running','reply_pending','reply_sending')").get(roomId))throw fail(409,'메일 작업이 끝난 뒤 삭제해 주세요.');
      }
      for(const roomId of deleted) {
        paths.push(...db.prepare('SELECT path FROM attachments WHERE room_id=?').all(roomId).map(row=>row.path));
        // A fork can still refer to the same on-disk attachment: keep its file.
        db.prepare('DELETE FROM message_attachments WHERE attachment_id IN (SELECT id FROM attachments WHERE room_id=?)').run(roomId);
        db.prepare('DELETE FROM messages WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM attachments WHERE room_id=?').run(roomId);
        if(hasTable('routine_runs'))db.prepare('DELETE FROM routine_runs WHERE routine_id IN (SELECT id FROM routines WHERE room_id=?)').run(roomId);
        for(const table of ['routines','message_queue','notification_events','model_usage_totals','trial_grants']) {
          if(hasTable(table))db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(roomId);
        }
        // Keep received mail and delivery deduplication; detach the deleted chat.
        if(hasTable('mail_agent_jobs'))db.prepare('UPDATE mail_agent_jobs SET room_id=NULL,reply_text=NULL WHERE room_id=?').run(roomId);
        db.prepare('UPDATE push_subscriptions SET room_id=NULL WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM room_invites WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM room_members WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM rooms WHERE id=?').run(roomId);
      }
      for(const row of db.prepare('SELECT key,value FROM settings').all()) {
        const direct=['context:','manual-title:','pending-title:','lineage:','private-fork:','mail-room:','fork-readonly:'].some(prefix=>row.key.startsWith(prefix)&&ids.has(row.key.slice(prefix.length)));
        const perUser=/^(room-ui|fork-readonly):[^:]+:(.+)$/.exec(row.key);
        if(direct||(perUser&&ids.has(perUser[2]))) {db.prepare('DELETE FROM settings WHERE key=?').run(row.key);continue;}
        if(row.key.startsWith('lineage:')) {
          try {
            const lineage=JSON.parse(row.value);
            const original=[...(Array.isArray(lineage.parents)?lineage.parents:[]),lineage.parent,lineage.mergedFrom];
            if(!original.some(id=>ids.has(id)))continue;
            const parents=[...new Set(original.filter(id=>typeof id==='string'&&!ids.has(id)))];
            if(!parents.length)db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
            else db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({...lineage,parents,parent:parents[0],mergedFrom:parents[1]||null}),row.key);
          } catch {}
        } else if(row.key.startsWith('sidebar:')) {
          try {const value=JSON.parse(row.value);if(Array.isArray(value.roomOrder))db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({...value,roomOrder:value.roomOrder.filter(id=>!ids.has(id))}),row.key);}catch{}
        }
      }
      paths=[...new Set(paths)].filter(path=>!db.prepare('SELECT 1 FROM attachments WHERE path=?').get(path));
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    let pendingCleanup=0;
    for(const id of deleted){try{onDeleted(id);}catch{pendingCleanup++;}}
    let pendingFiles=0;
    for(const path of paths) {
      if(dirname(resolve(path))!==resolve(mediaDir)){pendingFiles++;continue;}
      try {await unlink(path);}catch(error){if(error.code!=='ENOENT')pendingFiles++;}
    }
    return {deleted:deleted.length,roomIds:deleted,pendingFiles,pendingCleanup};
  }
  return {preview,removeAll};
}
