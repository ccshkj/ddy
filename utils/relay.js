// utils/relay.js
// 小程序端「仅内存转发」中继客户端：通过 WebSocket 收发【密文】。
//   - 不处理任何明文，明文加解密都在 crypto.js 里本机完成
//   - 不落盘、不做任何持久化
//   - 中继地址可在小程序内 🔑 菜单「设置中继地址」里填写，无需改代码
//
// 本地测试：ws://电脑局域网IP:3000
// 真机：必须 wss://你的域名（并在小程序后台配置 socket 合法域名）
// 默认中继地址（生产环境）。用户仍可在 🔑 -> 设置中继地址 里覆盖。
const DEFAULT_URL = 'wss://ddy-production.up.railway.app';

function getRelayUrl() {
  try { return wx.getStorageSync('relay_url') || DEFAULT_URL; } catch (e) { return DEFAULT_URL; }
}
function setRelayUrl(u) {
  try { wx.setStorageSync('relay_url', u); } catch (e) {}
}

// 由中继地址推导「普通 https 接口基地址」：wss://a  ->  https://a
// 小程序用这个地址请求 /feed（与 wss 同域，只需白名单这一个域名）
function getApiBase() {
  const u = getRelayUrl();
  if (!u) return '';
  return u
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/+$/, '');
}

let task = null;
let connecting = false;
let connected = false;
let onMsg = null;
let _room = '';
let _uid = '';

// 连接中继并加入房间。handler(msg) 收到对方发来的密文消息
function connect(room, uid, handler) {
  const url = getRelayUrl();
  if (!url) return Promise.reject(new Error('no relay url'));
  _room = room;
  _uid = uid;
  onMsg = handler;

  return new Promise((resolve, reject) => {
    if (connected && task && task.readyState === 1) { resolve(true); return; }
    if (connecting) { resolve(false); return; }
    connecting = true;

    task = wx.connectSocket({ url });

    task.onOpen(() => {
      connecting = false;
      connected = true;
      task.send({
        data: JSON.stringify({ type: 'join', room: _room, uid: _uid, since: Date.now() - 10 * 60 * 1000 }),
      });
      resolve(true);
    });

    task.onMessage((res) => {
      let m;
      try { m = JSON.parse(res.data); } catch (e) { return; }
      if (m.type === 'msg' && onMsg) onMsg(m);
    });

    task.onClose(() => {
      connecting = false;
      connected = false;
      task = null;
    });

    task.onError((e) => {
      connecting = false;
      connected = false;
      task = null;
      reject(e);
    });
  });
}

// 发送一条密文（payload = 加密模块输出的整段 base64）
function send(payload) {
  if (!task || task.readyState !== 1) return false;
  task.send({
    data: JSON.stringify({ type: 'msg', room: _room, uid: _uid, payload }),
  });
  return true;
}

function isConnected() {
  return connected && task && task.readyState === 1;
}

// 上传「端到端加密后的文件密文」到中继，返回 fileId
function uploadFile(arrayBuffer, meta) {
  return new Promise((resolve, reject) => {
    const base = getApiBase();
    if (!base) return reject(new Error('no relay url'));
    const qs = Object.keys(meta || {}).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(meta[k])).join('&');
    wx.request({
      url: base + '/upload' + (qs ? '?' + qs : ''),
      method: 'POST',
      data: arrayBuffer, // 二进制密文
      header: { 'Content-Type': 'application/octet-stream' },
      success: (res) => {
        if (res.statusCode === 200 && res.data && res.data.fileId) resolve(res.data.fileId);
        else reject(new Error('upload failed ' + res.statusCode));
      },
      fail: (e) => reject(e),
    });
  });
}

// 下载文件密文（ArrayBuffer），由前端 fileOpen 解密
function downloadFileArrayBuffer(fileId) {
  return new Promise((resolve, reject) => {
    const base = getApiBase();
    if (!base) return reject(new Error('no relay url'));
    wx.request({
      url: base + '/file/' + encodeURIComponent(fileId),
      method: 'GET',
      responseType: 'arraybuffer',
      success: (res) => {
        if (res.statusCode === 200 && res.data) resolve(res.data);
        else reject(new Error('download failed ' + res.statusCode));
      },
      fail: (e) => reject(e),
    });
  });
}

module.exports = { connect, send, isConnected, getRelayUrl, setRelayUrl, getApiBase, uploadFile, downloadFileArrayBuffer };
