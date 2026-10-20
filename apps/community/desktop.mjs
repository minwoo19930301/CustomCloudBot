import { randomBytes, createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { readCdpVersion } from './cdp.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), {status});
const roomPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseDesktops(value = '{}', {sharedRoomId = '', multiView = false} = {}) {
  let source;
  try { source = JSON.parse(value); } catch { throw new Error('Invalid COMMUNITY_DESKTOP_MAP'); }
  if (!source || Array.isArray(source) || typeof source !== 'object' || Object.keys(source).length > 20) throw new Error('Invalid desktop map');
  const desktops = new Map(), targets = new Set();
  for (const [roomId, config] of Object.entries(source)) {
    if (!roomPattern.test(roomId) || !config || typeof config !== 'object') throw new Error('Invalid desktop room');
    const wsUrl = new URL(config.wsUrl), cdpUrl = new URL(config.cdpUrl);
    for (const [url, protocol] of [[wsUrl,'ws:'],[cdpUrl,'http:']]) {
      if (url.protocol !== protocol || !(['127.0.0.1','[::1]'].includes(url.hostname) || /^desktop-[a-f0-9-]{36}$/.test(url.hostname)) || url.username || url.password || url.search || url.hash) throw new Error('Desktop endpoints must be dedicated loopback or desktop container services');
      // A desktop and its browser may never be assigned to two rooms.
      const key = url.protocol + url.host;
      if (targets.has(key)) throw new Error('Desktop endpoints cannot be shared between rooms');
      targets.add(key);
    }
    const workspaceUrl = config.workspaceUrl;
    if(workspaceUrl) {
      const endpoint=new URL(workspaceUrl);
      if(endpoint.protocol!=="http:"||endpoint.hostname!==cdpUrl.hostname||endpoint.username||endpoint.password||endpoint.pathname!=="/"||endpoint.search||endpoint.hash)throw new Error("Invalid workspace bridge endpoint");
    }
    desktops.set(roomId,{wsUrl:wsUrl.href,cdpUrl:cdpUrl.href,...(workspaceUrl?{workspaceUrl}: {})});
  }
  if(sharedRoomId) {
    if(!roomPattern.test(sharedRoomId) || !desktops.has(sharedRoomId))throw new Error('Shared desktop must reference an existing configured desktop');
    const shared=desktops.get(sharedRoomId);
    if(multiView && new URL(shared.wsUrl).port!=='6080')throw new Error('Desktop views require the standard internal websocket port');
    shared.views=multiView ? ['browser','files','terminal'] : ['browser'];
    desktops.sharedRoomId=sharedRoomId;
    const originalGet=desktops.get.bind(desktops);
    desktops.get=()=>originalGet(sharedRoomId);
    desktops.has=()=>true;
  }
  return desktops;
}

export function createDesktopHub({server, desktops, userFor, roomFor, originFor, touch = () => {}}) {
  const tickets = new Map(), connections = new Set();
  const wss = new WebSocketServer({noServer:true, perMessageDeflate:false, maxPayload:1024*1024});
  function issueTicket(user, roomId, view = "browser") {
    if (!(desktops.get(roomId)?.views || ["browser"]).includes(view)) throw fail(400,"지원하지 않는 데스크톱 화면입니다.");
    if (!desktops.has(roomId)) throw fail(503,'이 대화에 연결된 OCI 컴퓨터가 없습니다.');
    const now = Date.now();
    for (const [key,value] of tickets) if(value.expiresAt<=now) tickets.delete(key);
    if(tickets.size>=200) throw fail(429,'컴퓨터 연결 요청이 많습니다. 잠시 후 다시 시도하세요.');
    const raw = randomBytes(32).toString('base64url'), expiresAt=now+60000;
    tickets.set(hash(raw),{userId:user.id,sessionHash:user.sessionHash,roomId,view,expiresAt});
    return {websocketPath:`/api/rooms/${roomId}/desktop/ws?ticket=${raw}`,expiresAt};
  }
  const reject = (socket,status) => {socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
  server.on('upgrade',(req,socket,head)=>{
    let url,roomId,user,config;
    try {
      url=new URL(req.url,'http://local');
      if(/^\/api\/rooms\/[a-f0-9-]{36}\/workspace\/terminal\/ws$/.test(url.pathname))return;
      if(/^\/api\/rooms\/[a-f0-9-]{36}\/workspace\/media\/microphone\/ws$/.test(url.pathname))return;
      const match=url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})\/desktop\/ws$/);
      if(!match) return reject(socket,404);
      if(!originFor(req)||req.headers.origin!==originFor(req)) return reject(socket,403);
      user=userFor(req); if(!user) return reject(socket,401);
      roomId=match[1]; roomFor(roomId,user);
      config=desktops.get(roomId); if(!config) return reject(socket,503);
      const raw=url.searchParams.get('ticket')||'';
      if(raw.length>100) return reject(socket,403);
      const key=hash(raw), ticket=tickets.get(key);
      if(!ticket || ticket.expiresAt<=Date.now() || ticket.roomId!==roomId || ticket.userId!==user.id || ticket.sessionHash!==user.sessionHash) return reject(socket,403);
      const view=ticket.view || 'browser';
      if (!(config.views || ['browser']).includes(view)) return reject(socket,403);
      const wsUrl=new URL(config.wsUrl);
      if(view!=='browser')wsUrl.port=String({files:6081,terminal:6082}[view]);
      config={...config,wsUrl:wsUrl.href};
      tickets.delete(key);
      if(connections.size>=8 || [...connections].filter(c=>c.roomId===roomId).length>=3) return reject(socket,429);
    } catch {return reject(socket,403);}
    wss.handleUpgrade(req,socket,head,client=>{
      const upstream=new WebSocket(config.wsUrl,{perMessageDeflate:false,maxPayload:16*1024*1024,handshakeTimeout:5000});
      const entry={client,upstream,roomId}; connections.add(entry);
      const cleanup=()=>{connections.delete(entry); client.terminate(); upstream.terminate();};
      const send=(dest,data,isBinary)=>{
        if(dest.readyState!==WebSocket.OPEN || dest.bufferedAmount>8*1024*1024) return cleanup();
        dest.send(data,{binary:isBinary},error=>{if(error)cleanup();});
      };
      upstream.on('message',(data,binary)=>send(client,data,binary));
      client.on('message',(data,binary)=>send(upstream,data,binary));
      upstream.on('error',()=>{client.close(1011,'OCI desktop unavailable');});
      client.on('error',cleanup); client.on('close',cleanup); upstream.on('close',()=>client.close());
      const monitor=setInterval(()=>{
        try {const current=userFor(req); if(!current || current.sessionHash!==user.sessionHash) return cleanup(); roomFor(roomId,current); touch(roomId); } catch {cleanup();}
      },10000); monitor.unref();
      const lifetime=setTimeout(()=>client.close(1000,'Reconnect desktop'),60*60*1000); lifetime.unref();
      client.once('close',()=>{clearInterval(monitor);clearTimeout(lifetime);});
    });
  });
  return {
    issueTicket,
    async status(roomId) {
      const config=desktops.get(roomId);
      if(!config)return {configured:false,available:false,browserEnabled:false};
      let available=false;
      try {await readCdpVersion(new URL('/json/version',config.cdpUrl),{timeoutMs:2000});available=true;} catch {}
      return {configured:true,available,browserEnabled:available,shared:!!desktops.sharedRoomId,views:config.views || ['browser']};
    },
    close(){tickets.clear(); for(const {client,upstream}of connections){client.terminate();upstream.terminate();} connections.clear();wss.close();},
  };
}
