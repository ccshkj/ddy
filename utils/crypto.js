// utils/crypto.js
// 端到端加密（E2EE）：基于 TweetNaCl
//   - X25519 密钥交换 + XSalsa20-Poly1305 认证加密
//   - 私钥只存在本机（wx.storage），明文绝不离开手机
//   - 加密结果是一段 base64 密文，可放心通过微信分享卡片发给对方
//
// 依赖：直接使用本地 utils/tweetnacl.js（已从 tweetnacl 提取的纯 JS 版，
// 不依赖 Node 的 crypto 模块，无需「构建 npm」，微信小程序可原生加载）。
const nacl = require('./tweetnacl');

// ---------- base64（小程序无 btoa，手写 Uint8Array 版）----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    s += B64[b0 >> 2];
    s += B64[((b0 & 3) << 4) | (b1 >> 4)];
    s += (b1 === undefined) ? '=' : B64[((b1 & 15) << 2) | (b2 >> 6)];
    s += (b2 === undefined) ? '=' : B64[b2 & 63];
  }
  return s;
}
function b64ToBytes(s) {
  const lookup = (c) => B64.indexOf(c);
  const clean = s.replace(/=+$/, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = lookup(clean[i]);
    const c1 = lookup(clean[i + 1]);
    const c2 = lookup(clean[i + 2]);
    const c3 = lookup(clean[i + 3]);
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 !== -1) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 !== -1) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}

// ---------- UTF-8（避免依赖 TextEncoder）----------
function strToUtf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}
function utf8ToStr(bytes) {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const c2 = bytes[i++], c3 = bytes[i++], c4 = bytes[i++];
      let cp = ((c & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + ((cp >> 10) & 0x3ff), 0xdc00 + (cp & 0x3ff));
    }
  }
  return s;
}

// ---------- 密钥管理（私钥仅存本机）----------
const SECRET_TAG = 'e2ee_secret_key';
const PEER_TAG = 'e2ee_peer_public';

function ensureKeys() {
  let kp;
  const sk = wx.getStorageSync(SECRET_TAG);
  if (!sk) {
    kp = nacl.box.keyPair();
    wx.setStorageSync(SECRET_TAG, bytesToB64(kp.secretKey));
  } else {
    kp = nacl.box.keyPair.fromSecretKey(b64ToBytes(sk));
  }
  return kp;
}

function getMyPublicKeyB64() {
  return bytesToB64(ensureKeys().publicKey);
}
function getPeerPublicKeyB64() {
  return wx.getStorageSync(PEER_TAG) || '';
}
function setPeerPublicKeyB64(b64) {
  wx.setStorageSync(PEER_TAG, b64);
}

// 加密：用「对方公钥」+「自己私钥」（自带来源认证），输出 base64(nonce|cipher)
function encrypt(plaintext) {
  const peer = getPeerPublicKeyB64();
  if (!peer) throw new Error('尚未设置对方公钥');
  const kp = ensureKeys();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const cipher = nacl.box(strToUtf8(plaintext), nonce, b64ToBytes(peer), kp.secretKey);
  const merged = new Uint8Array(nonce.length + cipher.length);
  merged.set(nonce, 0);
  merged.set(cipher, nonce.length);
  return bytesToB64(merged);
}

// 解密：用「对方公钥」+「自己私钥」
function decrypt(payloadB64) {
  const peer = getPeerPublicKeyB64();
  if (!peer) throw new Error('尚未设置对方公钥');
  const kp = ensureKeys();
  const data = b64ToBytes(payloadB64);
  const nonce = data.slice(0, nacl.box.nonceLength);
  const cipher = data.slice(nacl.box.nonceLength);
  const plain = nacl.box.open(cipher, nonce, b64ToBytes(peer), kp.secretKey);
  if (!plain) throw new Error('解密失败（密钥不匹配）');
  return utf8ToStr(plain);
}

// ---------- 文件消息：每个文件独立随机对称密钥 + secretbox ----------
function randomKeyB64() {
  return bytesToB64(nacl.randomBytes(nacl.secretbox.keyLength));
}

// 用对称密钥加密文件字节（nonce 写入头部），返回 Uint8Array (nonce|cipher)
function fileSeal(bytes, keyB64) {
  const key = b64ToBytes(keyB64);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const cipher = nacl.secretbox(new Uint8Array(bytes), nonce, key);
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return out;
}

// 解密文件字节，返回 Uint8Array 明文
function fileOpen(merged, keyB64) {
  const key = b64ToBytes(keyB64);
  const nonce = merged.slice(0, nacl.secretbox.nonceLength);
  const cipher = merged.slice(nacl.secretbox.nonceLength);
  const plain = nacl.secretbox.open(cipher, nonce, key);
  if (!plain) throw new Error('文件解密失败（密钥不匹配）');
  return plain;
}

module.exports = {
  getMyPublicKeyB64,
  getPeerPublicKeyB64,
  setPeerPublicKeyB64,
  encrypt,
  decrypt,
  randomKeyB64,
  fileSeal,
  fileOpen,
};
