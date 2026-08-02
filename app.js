// 生日礼物 v5 —— 零依赖 Node 后端（短链 + 图片存储）
// 运行：node server.js  （端口取环境变量 PORT，默认 3000）
// 同时承担：静态文件托管 + /api/store + /api/get + /img + /g/:id 短链
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(os.tmpdir(), 'gift_v5_data'); // SCF 函数目录只读，数据存系统临时目录（本地即 temp，云端即 /tmp）
const IMG_DIR = path.join(DATA_DIR, 'images');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SHARE_FILE = path.join(DATA_DIR, 'share.json');
const SUBS_FILE = path.join(DATA_DIR, 'subs.json');

fs.mkdirSync(IMG_DIR, { recursive: true });
let store = {};
let shareStore = {};
let subsStore = {};
try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { store = {}; }
try { shareStore = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch (e) { shareStore = {}; }
try { subsStore = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { subsStore = {}; }
function saveStore() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); } catch (e) {}
}
function saveShare() {
  try { fs.writeFileSync(SHARE_FILE, JSON.stringify(shareStore)); } catch (e) {}
}
function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subsStore)); } catch (e) {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 把 base64 图片存成文件，返回 /img/xxx 相对路径（朋友可直接访问）
function saveImage(dataUrl) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/gif' ? 'gif' : 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return null; // 单图上限 8MB
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  try { fs.writeFileSync(path.join(IMG_DIR, name), buf); } catch (e) { return null; }
  return '/img/' + name;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;
  // 兼容腾讯云 API 网关的 stage 前缀（release/test/prepub）
  const STAGES = ['release', 'test', 'prepub'];
  let stage = '';
  const seg = p.split('/')[1];
  if (STAGES.includes(seg)) { stage = '/' + seg; p = p.slice(stage.length) || '/'; }

  // CORS 预检（前端部署在 CloudStudio，后端在 Render，跨域 POST 需此处理）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // 1) 保存礼物数据（含图片），返回短 ID
  if (p === '/api/store' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw);
      const friendName = (data.friendName || '').toString().slice(0, 40);
      const gifts = Array.isArray(data.gifts)
        ? data.gifts.slice(0, 12).map(g => ({
            id: g.id,
            name: (g.name || '').toString().slice(0, 80),
            imageUrl: (g.imageUrl && g.imageUrl.startsWith('data:image/'))
              ? (saveImage(g.imageUrl) || '')
              : (g.imageUrl || ''),
          }))
        : [];
      if (!gifts.length) return sendJSON(res, 400, { error: 'no gifts' });
      const id = crypto.randomBytes(4).toString('hex'); // 8 字符短 ID
      store[id] = { friendName, gifts, createdAt: Date.now() };
      saveStore();
      return sendJSON(res, 200, { id, url: '/g/' + id });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // 2) 读取礼物数据
  if (p === '/api/get' && req.method === 'GET') {
    const id = u.searchParams.get('id');
    const rec = id && store[id];
    if (!rec) return sendJSON(res, 404, { error: 'not found' });
    // 给图片路径拼上 stage 前缀，确保经 API 网关 stage 访问时浏览器能正确加载
    const out = {
      ...rec,
      gifts: rec.gifts.map(g => ({
        ...g,
        imageUrl: (g.imageUrl && g.imageUrl.startsWith('/img/')) ? stage + g.imageUrl : g.imageUrl,
      })),
    };
    return sendJSON(res, 200, out);
  }

  // 2.5) 登记分享（管理员生成链接时写入 sid + 礼物，供提交关联）
  if (p === '/api/share' && req.method === 'POST') {
    try {
      const data = JSON.parse(await readBody(req));
      const sid = (data.sid || '').toString().slice(0, 32);
      if (!sid) return sendJSON(res, 400, { error: 'no sid' });
      shareStore[sid] = {
        friendName: (data.friendName || '').toString().slice(0, 40),
        gifts: Array.isArray(data.gifts) ? data.gifts.slice(0, 12).map(g => ({
          id: g.id,
          n: (g.n || '').toString().slice(0, 80),
          img: (g.img || '').toString().slice(0, 2000)
        })) : [],
        createdAt: Date.now()
      };
      saveShare();
      return sendJSON(res, 200, { ok: true, sid });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // 2.6) 朋友提交选择 + 收货地址（管理员可在后台实时看到）
  if (p === '/api/submit' && req.method === 'POST') {
    try {
      const data = JSON.parse(await readBody(req));
      const sid = (data.sid || '').toString().slice(0, 32);
      if (!sid) return sendJSON(res, 400, { error: 'no sid' });
      const rec = {
        giftId: data.giftId,
        giftName: (data.giftName || '').toString().slice(0, 80),
        name: (data.name || '').toString().slice(0, 40),
        phone: (data.phone || '').toString().slice(0, 20),
        region: (data.region || '').toString().slice(0, 60),
        address: (data.address || '').toString().slice(0, 200),
        timestamp: data.timestamp || new Date().toISOString()
      };
      if (!subsStore[sid]) subsStore[sid] = [];
      subsStore[sid].push(rec);
      saveSubs();
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // 2.7) 管理员拉取某分享的所有提交记录
  if (p === '/api/submissions' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || '';
    return sendJSON(res, 200, (sid && subsStore[sid]) ? subsStore[sid] : []);
  }

  // 2.8) 清空某分享的提交记录（管理员点“清空记录”时调用）
  if (p === '/api/clear' && req.method === 'POST') {
    try {
      const data = JSON.parse(await readBody(req));
      const sid = (data.sid || u.searchParams.get('sid') || '').toString().slice(0, 32);
      if (sid && subsStore[sid]) { delete subsStore[sid]; saveSubs(); }
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // 3) 图片文件
  if (p.startsWith('/img/')) {
    const name = path.basename(p);
    const fp = path.join(IMG_DIR, name);
    if (fp.startsWith(IMG_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(name);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found'); return;
  }

  // 4) SPA：/g/:id 短链 或 未知路径 -> 返回 index.html
  if (p.startsWith('/g/') || p === '/' || !MIME[path.extname(p)]) {
    const fp = path.join(ROOT, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // 5) 静态资源（react/react-dom/babel/lz-string/styles 等）
  const sp = path.join(ROOT, path.normalize(p));
  if (sp.startsWith(ROOT) && fs.existsSync(sp) && fs.statSync(sp).isFile()) {
    const ext = path.extname(sp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(sp).pipe(res);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log('Gift v5 server running on http://0.0.0.0:' + PORT));
