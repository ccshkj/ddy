// utils/feed.js
// 小程序端：向自己的中继请求「公开视频 feed」（中继再代理 Pexels，密钥不在这里）
// 只请求与 wss 同域的 https 地址，因此微信后台只需白名单这一个域名。
const relay = require('./relay.js');

function fetchFeed(page) {
  const base = relay.getApiBase();
  if (!base) return Promise.reject(new Error('no relay url'));
  return new Promise((resolve, reject) => {
    wx.request({
      url: base + '/feed?page=' + (page || 1),
      method: 'GET',
      timeout: 10000,
      success: (res) => {
        if (res.statusCode === 200 && res.data && Array.isArray(res.data.videos)) {
          resolve(res.data.videos);
        } else {
          reject(new Error('bad feed response ' + res.statusCode));
        }
      },
      fail: (e) => reject(e),
    });
  });
}

module.exports = { fetchFeed };
