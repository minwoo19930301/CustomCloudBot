export const INACTIVE_CONVERSATION_MS = 14 * 24 * 60 * 60 * 1000;

// Explicit UI actions call touch. Polling messages, progress, and room lists must
// not count as activity, or a background tab would keep every room alive forever.
export function createConversationActivity({ db, now = Date.now, isBusy = () => false, excludedRoomIds = [] }) {
  const excluded = new Set(excludedRoomIds);
  const preference = db.prepare('SELECT value FROM settings WHERE key=?');
  const put = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const membership = db.prepare('SELECT 1 FROM room_members WHERE user_id=? AND room_id=?');
  const rooms = db.prepare(`SELECT r.id,r.created_at,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.room_id=r.id) latest_message_at
    FROM rooms r JOIN room_members member ON member.room_id=r.id WHERE member.user_id=?`);
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  const key = (userId, roomId) => `room-ui:${userId}:${roomId}`;
  const timeValue = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  function timestamp() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('Invalid conversation activity clock');
    return time;
  }
  function read(userId, roomId) {
    try {
      const value = JSON.parse(preference.get(key(userId, roomId))?.value || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }
  function transaction(fn) {
    db.exec('SAVEPOINT conversation_activity');
    try {
      const result = fn();
      db.exec('RELEASE conversation_activity');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO conversation_activity; RELEASE conversation_activity');
      throw error;
    }
  }
  function routineRooms(userId) {
    if (!tableExists.get('routines')) return new Set();
    const pending = tableExists.get('routine_runs')
      ? "OR EXISTS (SELECT 1 FROM routine_runs run WHERE run.routine_id=r.id AND run.status IN ('queued','running'))"
      : '';
    return new Set(db.prepare(`SELECT DISTINCT r.room_id FROM routines r WHERE r.owner_id=?
      AND ((r.enabled=1 AND r.deleted_at IS NULL) ${pending})`).all(userId).map(row => row.room_id));
  }
  return {
    touch(userId, roomId) {
      const time = timestamp();
      return transaction(() => {
        if (!membership.get(userId, roomId)) return false;
        const prior = read(userId, roomId);
        // Do not erase a malformed preference record just to record activity.
        if (!prior) return false;
        const next = { ...prior, lastTouchedAt: Math.max(timeValue(prior.lastTouchedAt), time) };
        if (next.archived !== true) {
          delete next.archivedAt;
          delete next.archiveReason;
        }
        put.run(key(userId, roomId), JSON.stringify(next));
        return true;
      });
    },
    archiveInactive(userId, { roomIds } = {}) {
      // Callers with additional access rules (for example expiring invitations)
      // can restrict the scan to rooms they have already authorized.
      if (roomIds !== undefined && !Array.isArray(roomIds)) throw new TypeError('Invalid conversation room IDs');
      const allowed = roomIds === undefined ? null : new Set(roomIds);
      const time = timestamp();
      return transaction(() => {
        const scheduled = routineRooms(userId), archived = [];
        for (const room of rooms.all(userId)) {
          if ((allowed && !allowed.has(room.id)) || excluded.has(room.id) || scheduled.has(room.id) || isBusy(room.id, userId)) continue;
          const prior = read(userId, room.id);
          if (!prior || prior.archived === true || prior.pinned === true) continue;
          const lastActivity = Math.max(timeValue(room.created_at), timeValue(room.latest_message_at), timeValue(prior.lastTouchedAt));
          if (time - lastActivity < INACTIVE_CONVERSATION_MS) continue;
          put.run(key(userId, room.id), JSON.stringify({ ...prior, archived: true, archivedAt: time, archiveReason: 'inactive' }));
          archived.push(room.id);
        }
        return archived;
      });
    },
  };
}
