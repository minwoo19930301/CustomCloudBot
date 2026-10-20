import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, chmod, unlink, stat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_DEFAULT = 12 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "video/mp4"]);

export const attachmentKind = (mime) => IMAGE_TYPES.has(mime) ? "image" : AUDIO_TYPES.has(mime) ? "audio" : null;
export const cleanFilename = (value) => {
  const base = String(value || "upload").replace(/[\\/\0\r\n]+/g, "_").replace(/[^\p{L}\p{N}._ ()-]/gu, "_").trim().slice(0, 180);
  return base || "upload";
};
const signature = (buf, mime) => {
  if (mime === "image/jpeg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/png") return buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/gif") return buf.subarray(0, 6).toString() === "GIF87a" || buf.subarray(0, 6).toString() === "GIF89a";
  if (mime === "image/webp") return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (mime === "audio/webm") return buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "audio/ogg") return buf.subarray(0, 4).toString() === "OggS";
  if (mime === "audio/wav" || mime === "audio/x-wav") return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WAVE";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || buf.subarray(0, 3).toString() === "ID3";
  if (mime === "audio/mp4" || mime === "video/mp4") return buf.subarray(4, 8).toString() === "ftyp";
  return false;
};

// EXIF orientations 5-8 turn the picture a quarter turn when the browser draws it.
function jpegOrientation(buf, start, end) {
  if (start + 14 > end || buf.toString("latin1", start, start + 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const order = buf.toString("latin1", tiff, tiff + 2);
  if (!["II", "MM"].includes(order)) return 1;
  const little = order === "II";
  const u16 = (at) => at + 2 <= end ? (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at)) : 0;
  const u32 = (at) => at + 4 <= end ? (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at)) : 0;
  if (u16(tiff + 2) !== 42) return 1;
  const offset = u32(tiff + 4);
  if (offset < 8) return 1;
  const ifd = tiff + offset;
  const count = u16(ifd);
  for (let i = 0; i < count && i < 256; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const orientation = u16(entry + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

/** Pixel size of a PNG, GIF, WebP or JPEG header, as the browser will show it. */
export function imageDimensions(buf, mime) {
  if (!Buffer.isBuffer(buf) || !signature(buf, mime)) return null;
  const valid = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 65535 && height <= 65535 ? { width, height } : null;
  try {
    if (mime === "image/png" && buf.length >= 24 && buf.toString("latin1", 12, 16) === "IHDR") return valid(buf.readUInt32BE(16), buf.readUInt32BE(20));
    if (mime === "image/gif" && buf.length >= 10) return valid(buf.readUInt16LE(6), buf.readUInt16LE(8));
    if (mime === "image/webp" && buf.length >= 25) {
      const chunk = buf.toString("latin1", 12, 16);
      if (chunk === "VP8 " && buf.length >= 30) return valid(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
      if (chunk === "VP8L") { const b = buf.subarray(21, 25); return valid(1 + (((b[1] & 0x3f) << 8) | b[0]), 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6))); }
      if (chunk === "VP8X" && buf.length >= 30) return valid(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
      return null;
    }
    if (mime === "image/jpeg" && buf[0] === 0xff && buf[1] === 0xd8) {
      let at = 2, orientation = 1;
      while (at + 4 <= buf.length) {
        if (buf[at] !== 0xff) return null;
        const marker = buf[at + 1];
        if (marker === 0xff) { at++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) return null;
        const length = buf.readUInt16BE(at + 2);
        if (length < 2 || at + 2 + length > buf.length) return null;
        if (marker === 0xe1) orientation = jpegOrientation(buf, at + 4, at + 2 + length);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          if (length < 8) return null;
          const height = buf.readUInt16BE(at + 5), width = buf.readUInt16BE(at + 7);
          return orientation >= 5 && orientation <= 8 ? valid(height, width) : valid(width, height);
        }
        at += 2 + length;
      }
    }
  } catch { return null; }
  return null;
}

/** Bound header I/O across all requests, coalescing files shared by forked rooms. */
export function createImageDimensionReader({openFile=open}={}) {
  const cache=new Map(),pending=new Map(),waiting=[];
  let active=0;
  async function read(path,mime){
    let file;
    try {
      file=await openFile(path,"r");
      const head=Buffer.alloc(mime==="image/jpeg"?512*1024:64);
      const {bytesRead}=await file.read(head,0,head.length,0);
      return imageDimensions(head.subarray(0,bytesRead),mime);
    }catch{return null;}
    finally{if(file)await file.close().catch(()=>{});}
  }
  return function storedDimensions(path,mime){
    if(!IMAGE_TYPES.has(mime))return Promise.resolve(null);
    if(cache.has(path))return Promise.resolve(cache.get(path));
    if(pending.has(path))return pending.get(path);
    const result=new Promise(resolve=>{
      const run=async()=>{
        active++;
        try{resolve(await read(path,mime));}
        finally{active--;waiting.shift()?.();}
      };
      if(active<8)void run();else waiting.push(run);
    }).then(value=>{
      pending.delete(path);
      if(cache.size>=2000)cache.delete(cache.keys().next().value);
      cache.set(path,value);
      return value;
    });
    pending.set(path,result);
    return result;
  };
}
export const storedImageDimensions=createImageDimensionReader();

export async function prepareMediaDir(dataDir) {
  const dir = join(dataDir, "media");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

export async function cleanupOrphans(db, mediaDir, ttlMs = 24 * 3600000) {
  const cutoff = Date.now() - ttlMs;
  const rows = db.prepare("SELECT id,path FROM attachments WHERE bound_at IS NULL AND created_at<?").all(cutoff);
  // Remove expired, unbound records synchronously before yielding, so a
  // concurrent message cannot bind an attachment whose file is being removed.
  const remove = db.prepare("DELETE FROM attachments WHERE id=? AND bound_at IS NULL AND created_at<?");
  const expired = rows.filter(row => remove.run(row.id,cutoff).changes === 1);
  // Forks have their own attachment IDs but keep the original file path.
  // Check every remaining reference before removing either expired or orphaned bytes.
  const referenced = db.prepare("SELECT 1 FROM attachments WHERE path=? LIMIT 1");
  for (const path of new Set(expired.map(row => row.path))) {
    if (!referenced.get(path)) await unlink(path).catch(() => {});
  }
  for (const name of await readdir(mediaDir).catch(() => [])) {
    if (!name.startsWith(".upload-") && !/^[a-f0-9-]{36}$/.test(name)) continue;
    const path = join(mediaDir, name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    if (name.startsWith(".upload-") || !referenced.get(path)) await unlink(path).catch(() => {});
  }
}

export function createUploadLimiter({ global = 4, perUser = 2 } = {}) {
  let total = 0;
  const users = new Map();
  return {
    async acquire(userId = "anonymous") {
      const current = users.get(userId) ?? 0;
      if (total >= global || current >= perUser) { const e = new Error("업로드 요청이 많습니다. 잠시 후 다시 시도해 주세요."); e.status = 429; throw e; }
      total++; users.set(userId, current + 1);
      let released = false;
      return () => { if (released) return; released = true; total--; const next = (users.get(userId) ?? 1) - 1; if (next) users.set(userId, next); else users.delete(userId); };
    },
  };
}

export async function receiveAttachment(req, { mediaDir, maxBytes = MAX_DEFAULT, userId = "anonymous", limiter = defaultLimiter }) {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
    const e = new Error("multipart/form-data 요청이 필요합니다."); e.status = 415; throw e;
  }
  const tempPath = join(mediaDir, `.upload-${randomUUID()}`);
  const release = await limiter.acquire(userId);
  if (req.destroyed || req.aborted || req.complete) {
    release();
    await unlink(tempPath).catch(() => {});
    const e = new Error("업로드 연결이 중단되었습니다."); e.status = 400; throw e;
  }
  let write;
  let streamRef;
  let busboy;
  let abortHandler;
  let requestErrorHandler;
  let writeDone = Promise.resolve();
  let fileSeen = false;
  let fileName = "upload";
  let declaredMime = "";
  let bytes = 0;
  let tooLarge = false;
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => { if (settled) return; settled = true; err ? reject(err) : resolve(value); };
      let bb;
      try { bb = Busboy({ headers: req.headers, defParamCharset: "utf8", limits: { files: 1, fields: 2, parts: 3, fileSize: maxBytes } }); busboy = bb; }
      catch { const e = new Error("multipart 요청 형식을 확인해 주세요."); e.status = 400; return finish(e); }
      bb.on("file", (field, stream, info) => {
        if (field !== "file" || fileSeen) { stream.resume(); return; }
        fileSeen = true; fileName = cleanFilename(info.filename); declaredMime = String(info.mimeType || "").toLowerCase().split(";", 1)[0];
        streamRef = stream;
        write = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
        writeDone = new Promise((resolveWrite, rejectWrite) => {
          write.once("close", resolveWrite);
          write.once("error", rejectWrite);
        });
        writeDone.catch(() => {});
        stream.on("data", (chunk) => { bytes += chunk.length; });
        stream.on("limit", () => { tooLarge = true; });
        stream.on("error", (e) => finish(e));
        write.on("error", (e) => finish(e));
        stream.pipe(write);
      });
      bb.on("error", (e) => finish(e));
      abortHandler = () => { if (req.complete) return; const e = new Error("업로드 연결이 중단되었습니다."); e.status = 400; req.unpipe(bb); streamRef?.destroy(); write?.destroy(); bb.destroy(e); finish(e); };
      requestErrorHandler = abortHandler;
      req.once("aborted", abortHandler);
      req.once("close", abortHandler);
      req.once("error", requestErrorHandler);
      if (req.destroyed || req.aborted || req.complete) { abortHandler(); return; }
      bb.on("partsLimit", () => { const e = new Error("multipart 요청이 너무 큽니다."); e.status = 413; finish(e); });
      bb.on("filesLimit", () => { const e = new Error("파일은 하나만 업로드할 수 있습니다."); e.status = 400; finish(e); });
      bb.on("finish", async () => {
        try { await writeDone; } catch (e) { return finish(e); }
        if (!fileSeen) { const e = new Error("file 필드가 필요합니다."); e.status = 400; return finish(e); }
        if (tooLarge || bytes > maxBytes) { const e = new Error("파일 크기 제한을 초과했습니다."); e.status = 413; return finish(e); }
        const kind = attachmentKind(declaredMime);
        if (!kind) { const e = new Error("지원하지 않는 이미지 또는 오디오 형식입니다."); e.status = 415; return finish(e); }
        try {
          const handle = await open(tempPath, "r");
          const head = Buffer.alloc(4100);
          let read;
          try { read = await handle.read(head, 0, head.length, 0); }
          finally { await handle.close(); }
          const sample = head.subarray(0, read.bytesRead);
          if (!signature(sample, declaredMime)) { const e = new Error("파일 내용과 MIME 형식이 일치하지 않습니다."); e.status = 415; return finish(e); }
        } catch (e) { return finish(e); }
        finish(null, { tempPath, fileName, declaredMime, kind, size: bytes });
      });
      req.pipe(bb);
    });
    await chmod(tempPath, 0o600);
    return result;
  } catch (e) {
    req.unpipe(busboy);
    busboy?.destroy();
    req.resume();
    streamRef?.destroy();
    write?.destroy();
    await writeDone.catch(() => {});
    await unlink(tempPath).catch(() => {});
    if (e.status) throw e;
    const err = new Error("업로드를 처리하지 못했습니다."); err.status = 400; throw err;
  } finally {
    if (abortHandler) req.removeListener("aborted", abortHandler);
    if (abortHandler) req.removeListener("close", abortHandler);
    if (requestErrorHandler) req.removeListener("error", requestErrorHandler);
    release();
  }
}

export async function finalizeAttachment(upload, mediaDir, id) {
  const path = join(mediaDir, id);
  await import("node:fs/promises").then(({ rename }) => rename(upload.tempPath, path));
  await chmod(path, 0o600);
  return path;
}

export { MAX_DEFAULT };

const defaultLimiter = createUploadLimiter();
