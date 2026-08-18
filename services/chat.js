// services/chat.js
// 纯本地存储层：消息只保存在各自手机，不调用任何服务器 / 云数据库。
const MSG_TAG = 'privacy_msgs';

function loadLocal() {
  return wx.getStorageSync(MSG_TAG) || [];
}

function saveLocal(messages) {
  wx.setStorageSync(MSG_TAG, messages);
}

function clearLocal() {
  wx.removeStorageSync(MSG_TAG);
}

module.exports = { loadLocal, saveLocal, clearLocal };
