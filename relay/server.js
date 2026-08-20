// relay/server.js
// 极简「仅内存转发」中继 + 公开视频 feed 代理 + 可选视频代转
//   - 中继：只转发密文，不落盘、不持久化、看不到明文
//   - 静态：把 relay/videos/ 下的文件以 /v/文件名 对外提供（自托管私有视频）
//   - feed：/feed?page=N 调用 Pexels 免费竖屏视频 API（密钥在服务端，不暴露给小程序）
//   - vproxy：/vproxy?url=... 把第三方视频流代理成本域名，省去微信后台加大量 CDN 域名
//
// 环境变量：
//   PORT            监听端口（Railway 自动注入）
//   PEXELS_API_KEY  Pexels 免费密钥（https://www.pexels.com/api/ 申请，填入 Railway 变量）
//   FEED_PROXY      设为 '0' 关闭视频代转（改走 Pexels 直链，更快，但需在微信后台加 Pexels CDN 域名）
//
// 运行：cd relay && npm install && npm start
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const VIDEO_DIR = path.join(__dirname, 'videos');
// 文件消息（图片/视频/语音）暂存目录：存的是「端到端加密后的密文」，服务器看不到明文
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// 默认开启视频代转：只暴露本Railway域名，微信后台只需白名单这一个域名即可无限刷
const PROXY = process.env.FEED_PROXY !== '0';
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';

const MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// 无密钥时的兜底视频（公开测试视频，开箱即用）
const FALLBACK = [
  { src: 'https://media.w3.org/2010/05/sintel/trailer.mp4', poster: '', author: '环球影视', title: '今天的天空像被调过色一样 🌤️' },
  { src: 'https://www.w3schools.com/html/mov_bbb.mp4', poster: '', author: '深夜放映', title: '一碗面治愈所有疲惫 🍜' },
  { src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', poster: '', author: '城市漫步', title: '周末的街角总有惊喜 🌿' },
  { src: 'https://media.w3.org/2010/05/bunny/trailer.mp4', poster: '', author: '旅行日记', title: '把烦恼丢进风里 🍃' },
  { src: 'https://media.w3.org/2010/05/video/movie_300.mp4', poster: '', author: '生活研究所', title: '认真生活的人最可爱 ✨' },
];

// 社交感文案，让竖屏流看起来像普通短视频 App（也满足 Pexels 署名要求）
const CAPTIONS = [
  '今天的天空像被调过色一样 🌤️', '周末的街角总有惊喜 🌿', '把烦恼丢进风里 🍃',
  '认真生活的人最可爱 ✨', '一碗面治愈所有疲惫 🍜', '海风一吹什么都不重要了 🌊',
  '光影刚刚好 ☀️', '这只小家伙太治愈了 🐾', '城市的夜比白天温柔 🌃',
  '慢下来才看得见美 🍃', '随拍，记录平凡日子 📷', '今天也要开心呀 🌸',
];

const FEED_MIX = Math.min(6, Math.max(1, parseInt(process.env.FEED_MIX || '3', 10))); // 每页混合几个主题

// 竖屏短视频主题池（越多越丰富，单页随机抽几个混合）
const QUERIES = ['nature', 'city', 'travel', 'pet', 'ocean', 'sunset', 'rain', 'coffee',
  'sky', 'flowers', 'dog', 'cat', 'dance', 'street', 'forest', 'sport', 'mountain', 'beach',
  'snow', 'night', 'party', 'art', 'music', 'car', 'food', 'baby', 'child', 'cloud', 'river', 'sunrise'];

const POPULAR = '__popular__'; // 特殊标记：拉 Pexels 热门流

// 单次调用 Pexels（search 或 popular），返回归一化后的视频数组（失败返回 []）
function fetchPexels(query, page) {
  return new Promise((resolve) => {
    let url;
    if (query === POPULAR) {
      url = 'https://api.pexels.com/v1/videos/popular?orientation=portrait&per_page=6&page=' + page;
    } else {
      url = 'https://api.pexels.com/v1/videos/search?orientation=portrait&per_page=6&page=' +
        page + '&query=' + encodeURIComponent(query);
    }
    const r = https.get(url, { headers: { Authorization: PEXELS_KEY } }, (pres) => {
      let body = '';
      pres.on('data', (d) => (body += d));
      pres.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve((data.videos || []).map(normalize).filter(Boolean));
        } catch (e) { resolve([]); }
      });
    });
    r.on('error', () => resolve([]));
    r.setTimeout(8000, () => { r.destroy(); resolve([]); });
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// 从 Pexels 视频对象里挑一个「竖屏 + 较小分辨率」的 mp4
function pickFile(v) {
  const files = (v.video_files || []).filter((f) => f.link && f.file_type && f.file_type.indexOf('mp4') >= 0);
  if (!files.length) return null;
  const vert = files.filter((f) => f.height && f.width && f.height >= f.width * 1.05);
  const pool = vert.length ? vert : files;
  pool.sort((a, b) => (a.width || 9999) - (b.width || 9999)); // 优先窄屏，省流量
  return pool[0];
}

function normalize(v) {
  const f = pickFile(v);
  if (!f) return null;
  const src = PROXY ? '/vproxy?url=' + encodeURIComponent(f.link) : f.link;
  return {
    id: 'p' + v.id,
    src,
    poster: v.image || '',
    author: (v.user && v.user.name) || 'Pexels',
    title: CAPTIONS[(v.id || 0) % CAPTIONS.length],
  };
}

function feedHandler(req, res) {
  if (!PEXELS_KEY) {
    const videos = FALLBACK.map((x) => ({ ...x, id: 'f' + Math.random().toString(36).slice(2, 9) }));
    sendJSON(res, 200, { source: 'fallback', videos });
    return;
  }
  const queryParams = (req.url.split('?')[1] || '');
  const pm = queryParams.match(/page=(\d+)/);
  const page = Math.max(1, parseInt(pm ? pm[1] : '1', 10));
  const userQ = (queryParams.match(/[?&]q=([^&]+)/) || [])[1];

  let queries;
  if (userQ) {
    // 指定单一主题（未来可让前端做主题搜索）
    queries = [decodeURIComponent(userQ)];
  } else {
    // 每页随机混合多个主题 + 偶尔混入热门，制造「刷不完、各不相同」的观感
    const pool = QUERIES.slice ? QUERIES.slice() : QUERIES;
    const picks = pool.sort(() => Math.random() - 0.5).slice(0, FEED_MIX);
    if (Math.random() < 0.3) picks.push(POPULAR);
    queries = picks;
  }

  Promise.all(queries.map((q) => fetchPexels(q, page))).then((lists) => {
    const seen = new Set();
    let merged = [];
    lists.forEach((list) => list.forEach((v) => {
      if (v && !seen.has(v.id)) { seen.add(v.id); merged.push(v); }
    }));
    // 再次打乱，避免同一主题扎堆相邻
    merged = merged.sort(() => Math.random() - 0.5);
    if (!merged.length) { sendJSON(res, 200, { source: 'pexels', videos: [], empty: true }); return; }
    sendJSON(res, 200, { source: 'pexels', videos: merged });
  });
}

// 把第三方视频流代理成本域名（支持 Range，便于 <video> 拖动进度）
function proxyVideo(req, res) {
  let target;
  try {
    target = new URL(decodeURIComponent((req.url.split('?')[1] || '').replace(/^url=/, '')));
  } catch (e) {
    res.writeHead(400); res.end('bad url'); return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.writeHead(400); res.end('bad protocol'); return;
  }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (req.headers['range']) headers['Range'] = req.headers['range'];

  const preq = lib.request({
    method: req.method || 'GET',
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    headers,
  }, (pres) => {
    const out = { 'Content-Type': pres.headers['content-type'] || 'video/mp4' };
    if (pres.headers['accept-ranges']) out['Accept-Ranges'] = pres.headers['accept-ranges'];
    if (pres.headers['content-range']) out['Content-Range'] = pres.headers['content-range'];
    if (pres.headers['content-length']) out['Content-Length'] = pres.headers['content-length'];
    res.writeHead(pres.statusCode, out);
    pres.pipe(res);
  });
  preq.on('error', () => { res.writeHead(502); res.end('proxy error'); });
  req.on('close', () => preq.destroy());
  preq.end();
}

// ---------- 文件消息：端到端加密后的密文暂存（服务器不可读明文）----------
const UPLOAD_TTL = 24 * 60 * 60 * 1000; // 密文最多保留 24 小时
const MAX_UPLOAD = 30 * 1024 * 1024;     // 单文件上限 30MB

function uploadHandler(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      req.destroy();
      try { res.writeHead(413); res.end('too large'); } catch (e) {}
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) { res.writeHead(400); res.end('empty'); return; }
    const fileId = crypto.randomBytes(16).toString('hex');
    fs.writeFile(path.join(UPLOAD_DIR, fileId), buf, (err) => {
      if (err) { res.writeHead(500); res.end('write error'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fileId }));
    });
  });
  req.on('error', () => { try { res.writeHead(500); res.end('err'); } catch (e) {} });
}

function fileHandler(req, res) {
  const id = (req.url.split('?')[0].slice('/file/'.length) || '').replace(/[^a-f0-9]/gi, '');
  if (!id) { res.writeHead(400); res.end('bad id'); return; }
  const file = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// 周期性清理过期密文，避免磁盘无限增长
setInterval(() => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach((f) => {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => { if (!e && now - st.mtimeMs > UPLOAD_TTL) fs.unlink(p, () => {}); });
    });
  });
}, 30 * 60 * 1000);

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url.startsWith('/v/')) {
    const rel = decodeURIComponent(url.slice(3)).replace(/^\/+/, '');
    const file = path.normalize(path.join(VIDEO_DIR, rel));
    if (file.startsWith(VIDEO_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found'); return;
  }
  if (url === '/feed' || url.startsWith('/feed?')) { feedHandler(req, res); return; }
  if (url === '/vproxy' || url.startsWith('/vproxy?')) { proxyVideo(req, res); return; }
  if (url === '/upload') { uploadHandler(req, res); return; }
  if (url.startsWith('/file/')) { fileHandler(req, res); return; }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocket.Server({ server });

const TTL = 10 * 60 * 1000; // 缓冲消息最多保留 10 分钟（仍在内存）
const MAX_BUF = 50;         // 每个房间最多保留最近 50 条（仍在内存）

const rooms = new Map();    // room -> Set<WebSocket>
const buffers = new Map();  // room -> [envelope, ...]  （仅内存，周期性清理）

function cleanup() {
  const now = Date.now();
  buffers.forEach((arr, room) => {
    const kept = arr.filter((m) => now - m.ts < TTL).slice(-MAX_BUF);
    if (kept.length) buffers.set(room, kept);
    else buffers.delete(room);
  });
}
setInterval(cleanup, 60 * 1000);

wss.on('connection', (ws) => {
  ws.room = null;
  ws.uid = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 加入房间：登记连接 + 补发离线期间缓冲的消息
    if (msg.type === 'join') {
      ws.room = String(msg.room || '');
      ws.uid = String(msg.uid || '');
      if (!ws.room) return;
      if (!rooms.has(ws.room)) rooms.set(ws.room, new Set());
      rooms.get(ws.room).add(ws);

      const buf = buffers.get(ws.room) || [];
      const since = Number(msg.since) || 0;
      buf
        .filter((m) => m.ts > since && m.from !== ws.uid)
        .forEach((m) => { try { ws.send(JSON.stringify(m)); } catch (e) {} });
      return;
    }

    // 转发消息：先仅内存缓冲，再实时广播给同房间的其他连接
    if (msg.type === 'msg') {
      if (!ws.room) return;
      const envelope = {
        type: 'msg',
        from: ws.uid,
        room: ws.room,
        payload: String(msg.payload || ''), // 整段密文（nonce|cipher 合并后的 base64）
        ts: Date.now(),
      };
      const buf = buffers.get(ws.room) || [];
      buf.push(envelope);
      buffers.set(ws.room, buf);

      const peers = rooms.get(ws.room);
      if (peers) {
        peers.forEach((p) => {
          if (p !== ws) { try { p.send(JSON.stringify(envelope)); } catch (e) {} }
        });
      }
      try { ws.send(JSON.stringify({ type: 'ack', ts: envelope.ts })); } catch (e) {}
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms.has(ws.room)) rooms.get(ws.room).delete(ws);
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
  console.log(`[relay] in-memory relay: ciphertext only, no disk persistence`);
  console.log(`[relay] static videos served at /v/ from ${VIDEO_DIR}`);
  console.log(`[relay] feed: ${PEXELS_KEY ? 'Pexels enabled' : 'Pexels DISABLED (fallback list only)'}`);
  console.log(`[relay] video proxy: ${PROXY ? 'ON (only this domain needs whitelisting)' : 'OFF (use Pexels CDN direct)'}`);
  console.log(`[relay] file messages (E2EE ciphertext): stored at ${UPLOAD_DIR}, TTL 24h, max 30MB`);
});
