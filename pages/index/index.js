// pages/index/index.js
// 隐私聊天小程序 · 首页（伪装成「竖屏短视频 App」+ 聊天浮层 + 端到端加密 + 仅内存转发中继）
//
// 隐私设计：
//  - 消息只存本机；发送前用对方公钥在本机加密；中继只搬运密文
//  - 中继纯内存转发、不落盘
// 浏览页是真能刷、能看的短视频流（<video> 竖屏滑动切换）
//
// 手势：
//  - 屏幕「左上 1/3」长按 500ms -> 临时聊天；按住下滑到下半屏 -> 固定
//  - 聊天中点「上方 1/3」或右上「返回」-> 退出
//  - 浏览页「单击视频」-> 播放/暂停；「双击视频」-> 假报错（视频加载失败）
//  - 浏览页「长按视频（非触发区）」-> 假崩溃（假退出）
//  - onShow 永远回浏览页（切后台/锁屏再进入）

const crypto = require('../../utils/crypto.js');
const chat = require('../../services/chat.js');
const relay = require('../../utils/relay.js');
const feed = require('../../utils/feed.js');

// 默认视频列表（公开测试视频，无 Pexels 密钥时兜底）。可在 🔑 -> 设置视频列表 中替换。
// 想完全私有：把视频放进 relay/videos/，填 https://你的域名/v/文件名.mp4
const DEFAULT_VIDEOS = [
  { id: 'd1', src: 'https://media.w3.org/2010/05/sintel/trailer.mp4', poster: '', author: '环球影视', title: '今天的天空像被调过色一样 🌤️' },
  { id: 'd2', src: 'https://www.w3schools.com/html/mov_bbb.mp4', poster: '', author: '深夜放映', title: '一碗面治愈所有疲惫 🍜' },
  { id: 'd3', src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', poster: '', author: '城市漫步', title: '周末的街角总有惊喜 🌿' },
  { id: 'd4', src: 'https://media.w3.org/2010/05/bunny/trailer.mp4', poster: '', author: '旅行日记', title: '把烦恼丢进风里 🍃' },
  { id: 'd5', src: 'https://media.w3.org/2010/05/video/movie_300.mp4', poster: '', author: '生活研究所', title: '认真生活的人最可爱 ✨' },
];

Page({
  data: {
    statusBarHeight: 20,
    screenW: 375,
    screenH: 600,
    videos: DEFAULT_VIDEOS,
    currentIndex: 0,
    playing: false,

    usingFeed: false,           // true=用公开 feed（无限刷）；false=用本地固定列表
    feedPage: 0,
    loadingFeed: false,
    hasMore: true,

    chatMode: false,
    chatPinned: false,
    messages: [],                 // [{ role:'me'|'peer', text, ts }]
    draft: '',
    showHint: false,

    relayStatus: 'disconnected',  // 英文类名：connected / connecting / disconnected / no-room / no-relay
    relayLabel: '未连接',          // 中文显示文案
    fakeError: false,             // 假报错（视频加载失败）
    fakeCrash: false,             // 假崩溃（页面出错，假退出）
  },

  onLoad(options) {
    const info = this._winInfo();
    const customList = wx.getStorageSync('video_list');
    this.setData({
      statusBarHeight: info.statusBarHeight || 20,
      screenW: info.windowWidth || 375,
      screenH: info.windowHeight || 600,
      videos: customList || DEFAULT_VIDEOS,
    });

    // 用户没手动设过视频列表 -> 走公开 feed（无限刷）
    if (customList) {
      this.setData({ usingFeed: false });
    } else {
      this.setData({ usingFeed: true });
      this.loadFeed(1);
    }

    // 设备唯一 ID（仅存本机），用于中继区分两端
    this._uid = wx.getStorageSync('relay_uid') || (() => {
      const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync('relay_uid', id);
      return id;
    })();
    this._room = wx.getStorageSync('relay_room') || '';

    this._loadLocalMessages();
    this._initRecorder();

    // 通过离线分享卡片进入：本地解密收到的消息
    if (options.msg) {
      try {
        const text = crypto.decrypt(decodeURIComponent(options.msg));
        this._appendLocal({ role: 'peer', text, ts: Date.now() });
        this._openOnShow = true; // 进入后直接打开聊天
      } catch (e) {
        wx.showToast({ title: '解密失败：请先设置对方公钥', icon: 'none' });
      }
    }
  },

  onReady() {
    // 尝试自动播放第一条（带声音自动播可能被系统策略拦截，用户单击即可播放）
    setTimeout(() => this.playActive(), 200);
  },

  onShow() {
    if (this._openOnShow) {
      this._openOnShow = false;
      this.setData({ chatMode: true, chatPinned: true, fakeError: false, fakeCrash: false });
      this._ensureRelay();
      return;
    }
    // 每次回到前台都强制回到浏览页，并清掉掩饰层
    this.setData({ chatMode: false, chatPinned: false, fakeError: false, fakeCrash: false });
    setTimeout(() => this.playActive(), 100);
  },

  onHide() { this.pauseAll(); },

  // ---------------- 视频流 ----------------
  getVidCtx(i) {
    if (!this._vidCtx) this._vidCtx = {};
    if (!this._vidCtx[i]) {
      try { this._vidCtx[i] = wx.createVideoContext('vid' + i); } catch (e) { return null; }
    }
    return this._vidCtx[i];
  },
  playActive() {
    if (this.data.chatMode) return;
    const ctx = this.getVidCtx(this.data.currentIndex);
    if (!ctx) return;
    try { ctx.play(); this.setData({ playing: true }); } catch (e) {}
  },
  pauseAll() {
    if (this._vidCtx) {
      Object.keys(this._vidCtx).forEach((k) => { try { this._vidCtx[k].pause(); } catch (e) {} });
    }
    this.setData({ playing: false });
  },
  onSwiperChange(e) {
    const idx = e.detail.current;
    this.pauseAll();
    this.setData({ currentIndex: idx });
    this._playTimer && clearTimeout(this._playTimer);
    this._playTimer = setTimeout(() => this.playActive(), 60);
    // 快到底了就预加载下一页（无限刷）
    if (this.data.usingFeed && !this.data.loadingFeed && this.data.hasMore &&
        idx >= this.data.videos.length - 2) {
      this.loadFeed(this.data.feedPage + 1);
    }
  },
  onVideoTap() {
    if (this.data.chatMode) return;
    const now = Date.now();
    // 双击 -> 假报错；单击(延迟判定) -> 播放/暂停
    if (this._lastTap && now - this._lastTap < 300) {
      this._lastTap = 0;
      clearTimeout(this._tapTimer);
      this.setData({ fakeError: true });
      return;
    }
    this._lastTap = now;
    clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => this._togglePlay(), 300);
  },
  _togglePlay() {
    const ctx = this.getVidCtx(this.data.currentIndex);
    if (!ctx) return;
    if (this.data.playing) {
      try { ctx.pause(); } catch (e) {}
      this.setData({ playing: false });
    } else {
      try { ctx.play(); } catch (e) {}
      this.setData({ playing: true });
    }
  },
  onBrowseLongPress() {
    if (this.data.chatMode || this.data.fakeCrash || this.data.fakeError) return;
    this.setData({ fakeCrash: true });
  },

  // ---------------- 公开视频 feed（无限刷）----------------
  async loadFeed(page) {
    if (this.data.loadingFeed || !this.data.hasMore) return;
    this.setData({ loadingFeed: true });
    try {
      const list = await feed.fetchFeed(page);
      if (!list.length) {
        // 该页空了：无密钥兜底或 Pexels 暂无更多，停在已加载内容
        this.setData({ hasMore: false, loadingFeed: false });
        return;
      }
      const exist = new Set(this.data.videos.map((v) => v.id));
      const add = list.filter((v) => v && v.src && !exist.has(v.id));
      this.setData({
        videos: this.data.videos.concat(add),
        feedPage: page,
        loadingFeed: false,
      });
      if (add.length < list.length) this.setData({ hasMore: false });
    } catch (e) {
      // 第一页就失败：退回兜底视频，保证开箱能用，并把具体原因透出便于排查
      if (page === 1 && this.data.videos === DEFAULT_VIDEOS) {
        this.setData({ usingFeed: false, hasMore: false, loadingFeed: false });
        if (!relay.getRelayUrl()) {
          wx.showToast({ title: '请先在 🔑 设置中继地址', icon: 'none' });
        } else {
          const reason = (e && e.errMsg) ? e.errMsg : (e && e.message) ? e.message : '未知错误';
          const host = (relay.getApiBase() || '').replace(/^https?:\/\//, '');
          if (reason.includes('domain list')) {
            wx.showModal({
              title: '请求域名未在白名单',
              content: '请去小程序后台「服务器域名 → request合法域名」添加：\nhttps://' + host + '\n\n当前请求被微信拦截，添加后等几分钟再重新打开小程序。',
              showCancel: false,
              confirmText: '知道了',
            });
          } else {
            wx.showToast({ title: '视频源失败:' + reason, icon: 'none', duration: 4000 });
          }
          console.error('[feed] 加载失败:', reason, '| 请求域名:', host);
        }
      } else {
        this.setData({ hasMore: false, loadingFeed: false });
      }
    }
  },

  // ---------------- 中继连接 ----------------
  _setRelay(en, zh) { this.setData({ relayStatus: en, relayLabel: zh }); },

  _ensureRelay() {
    if (!relay.getRelayUrl()) {
      this._setRelay('no-relay', '未设置中继地址');
      wx.showToast({ title: '请先在 🔑 里设置中继地址', icon: 'none' });
      return Promise.reject(new Error('no relay url'));
    }
    if (!this._room) {
      this._setRelay('no-room', '未设置房间号');
      return Promise.reject(new Error('no room'));
    }
    if (relay.isConnected()) {
      this._setRelay('connected', '已连接');
      return Promise.resolve(true);
    }
    this._setRelay('connecting', '连接中');
    return relay.connect(this._room, this._uid, (msg) => this._onRelayMessage(msg))
      .then(() => { this._setRelay('connected', '已连接'); return true; })
      .catch(() => { this._setRelay('disconnected', '未连接'); throw new Error('connect fail'); });
  },

  _onRelayMessage(msg) {
    if (msg.from === this._uid) return; // 忽略自己
    try {
      const plain = crypto.decrypt(msg.payload); // 本机解密
      let obj;
      try { obj = JSON.parse(plain); } catch (e) { obj = { kind: 'text', text: plain }; } // 兼容旧纯文本
      if (obj.kind && obj.kind !== 'text') {
        this._recvFile(obj); // 图片/视频/语音：下载密文 -> 解密 -> 写临时文件
      } else {
        this._appendLocal({ role: 'peer', text: obj.text, ts: Date.now() });
        wx.vibrateShort({ type: 'light' });
      }
    } catch (e) {
      console.error('解密失败', e);
    }
  },

  // ---------------- 手势：触发层（左上 1/3）----------------
  _pressTimer: null,
  _start: null,
  _moved: false,
  _longFired: false,

  onTriggerStart(e) {
    if (this.data.chatMode || this.data.fakeCrash) return;
    const t = e.touches[0];
    this._start = { x: t.clientX, y: t.clientY };
    this._moved = false;
    this._longFired = false;
    clearTimeout(this._pressTimer);
    // 长按 500ms -> 临时聊天
    this._pressTimer = setTimeout(() => {
      this._longFired = true;
      this._enterChat(false);
    }, 500);
  },
  onTriggerMove(e) {
    if (!this._start) return;
    const t = e.touches[0];
    const dy = t.clientY - this._start.y;
    if (Math.abs(dy) > 30) { this._moved = true; clearTimeout(this._pressTimer); }
    // 起始在触发区时：下滑到下半屏 -> 固定聊天
    if (dy > 120 && t.clientY > this.data.screenH / 2) {
      clearTimeout(this._pressTimer);
      this._enterChat(true);
    }
  },
  onTriggerEnd() {
    clearTimeout(this._pressTimer);
    if (this.data.chatMode && !this.data.chatPinned) this._exitChat();
    this._start = null;
    this._longFired = false;
  },
  _enterChat(pinned) {
    this.pauseAll(); // 进聊天先停掉视频声音
    wx.vibrateShort({ type: 'light' });
    this.setData({ chatMode: true, chatPinned: pinned });
    this._ensureRelay();
  },
  _exitChat() {
    this.setData({ chatMode: false, chatPinned: false });
    this.playActive();
  },

  // 假报错层：点击关闭
  dismissFakeError() { this.setData({ fakeError: false }); },
  // 假崩溃层：点击「关闭」-> 真的退出小程序（最像崩溃的收尾），失败则仅关闭掩饰层
  exitFake() {
    try {
      wx.exitMiniProgram({
        success: () => {},
        fail: () => this.setData({ fakeCrash: false }),
      });
    } catch (e) {
      this.setData({ fakeCrash: false });
    }
  },

  // 聊天浮层：点上方 1/3 退出
  onOverlayTap(e) {
    if (!this.data.chatMode) return;
    if (e.detail.y < this.data.screenH / 3) this.quickReturn();
  },

  quickReturn() {
    this.setData({ chatMode: false, chatPinned: false, draft: '' });
    this.playActive();
  },

  // ---------------- 发送（本机加密 -> 中继转发）----------------
  onInput(e) { this.setData({ draft: e.detail.value }); },

  async onSend() {
    const text = (this.data.draft || '').trim();
    if (!text) return;
    if (!this._room) {
      wx.showToast({ title: '请先在 🔑 里设置房间号', icon: 'none' });
      return;
    }
    let payload;
    try {
      payload = crypto.encrypt(JSON.stringify({ kind: 'text', text })); // 本机加密，密文 base64
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
      return;
    }
    // 先存本机（自己这侧立即可见）
    this._appendLocal({ role: 'me', text, ts: Date.now() });
    this.setData({ draft: '' });

    // 经中继转发密文
    try {
      await this._ensureRelay();
      const ok = relay.send(payload);
      if (!ok) wx.showToast({ title: '中继未连接，消息已存本机', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: '中继未连接，消息已存本机', icon: 'none' });
    }
  },

  // 离线兜底：手动分享卡片（长按发送键触发）
  onSendLongPress() {
    const text = (this.data.draft || '').trim();
    if (!text) {
      wx.showToast({ title: '先输入内容', icon: 'none' });
      return;
    }
    try {
      this._pendingCipher = crypto.encrypt(text);
      this._appendLocal({ role: 'me', text, ts: Date.now() });
      this.setData({ draft: '' });
      wx.showShareMenu({ withShareTicket: false });
      wx.showToast({ title: '点右上角 ··· 转发卡片', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },

  onShareAppMessage() {
    const cipher = this._pendingCipher || '';
    this._pendingCipher = '';
    return {
      title: '这个视频笑死我了 😂',                 // 伪装标题，外人看不出是密信
      path: '/pages/index/index?msg=' + encodeURIComponent(cipher),
    };
  },

  // ---------------- 密钥 / 房间 / 视频管理（一次性）----------------
  showKeyMenu() {
    wx.showActionSheet({
      itemList: ['复制我的公钥（发给对方）', '设置对方公钥', '设置房间号', '设置中继地址', '设置视频列表', '恢复公开视频流'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.setClipboardData({
            data: crypto.getMyPublicKeyB64(),
            success: () => wx.showToast({ title: '公钥已复制，发给对方', icon: 'none' }),
          });
        } else if (res.tapIndex === 1) {
          wx.showModal({
            title: '粘贴对方公钥',
            editable: true,
            placeholderText: '把对方发来的公钥字符串粘进来',
            success: (r) => {
              if (r.confirm && r.content && r.content.trim()) {
                crypto.setPeerPublicKeyB64(r.content.trim());
                wx.showToast({ title: '已保存对方公钥', icon: 'none' });
              }
            },
          });
        } else if (res.tapIndex === 2) {
          wx.showModal({
            title: '设置房间号',
            editable: true,
            placeholderText: '两人输入相同房间号即可互通',
            content: this._room,
            success: (r) => {
              if (r.confirm && r.content && r.content.trim()) {
                this._room = r.content.trim();
                wx.setStorageSync('relay_room', this._room);
                wx.showToast({ title: '房间号已保存', icon: 'none' });
                this._ensureRelay();
              }
            },
          });
        } else if (res.tapIndex === 3) {
          wx.showModal({
            title: '设置中继地址',
            editable: true,
            placeholderText: '本地测试填 ws://电脑IP:3000；真机填 wss://你的域名',
            content: relay.getRelayUrl(),
            success: (r) => {
              if (r.confirm && r.content && r.content.trim()) {
                relay.setRelayUrl(r.content.trim());
                wx.showToast({ title: '中继地址已保存', icon: 'none' });
                this._ensureRelay();
              }
            },
          });
        } else if (res.tapIndex === 4) {
          const cur = (wx.getStorageSync('video_list') || DEFAULT_VIDEOS).map((v) => v.src).join('\n');
          wx.showModal({
            title: '设置视频列表',
            editable: true,
            placeholderText: '每行一个视频地址（mp4/webm）',
            content: cur,
            success: (r) => {
              if (r.confirm && r.content) {
                const list = r.content.split('\n').map((s) => s.trim()).filter(Boolean)
                  .map((src, i) => ({ id: 'c' + i + '_' + src.length, src, poster: '', author: '视频' + (i + 1), title: '我的私有视频 ' + (i + 1) }));
                if (list.length) {
                  wx.setStorageSync('video_list', list);
                  this._vidCtx = {};
                  this.setData({ videos: list, currentIndex: 0, usingFeed: false, hasMore: false });
                  wx.showToast({ title: '视频列表已更新', icon: 'none' });
                  setTimeout(() => this.playActive(), 200);
                }
              }
            },
          });
        } else if (res.tapIndex === 5) {
          wx.removeStorageSync('video_list');
          this._vidCtx = {};
          this.setData({
            videos: [],
            currentIndex: 0,
            usingFeed: true,
            feedPage: 0,
            hasMore: true,
            loadingFeed: false,
          });
          this.loadFeed(1);
          wx.showToast({ title: '已恢复公开视频流', icon: 'none' });
        }
      },
    });
  },

  // ---------------- 本地存储 ----------------
  _appendLocal(msg) {
    const messages = chat.loadLocal().concat(msg);
    chat.saveLocal(messages);
    this.setData({ messages });
  },

  _loadLocalMessages() {
    this.setData({ messages: chat.loadLocal() });
  },

  // 录音管理器（长按语音按钮录制，松开发送）
  _initRecorder() {
    const rm = wx.getRecorderManager();
    this._recorder = rm;
    rm.onStop((res) => {
      if (res && res.tempFilePath) this._sendFile(res.tempFilePath, 'voice', Math.round((res.duration || 0) / 1000));
    });
    rm.onError(() => wx.showToast({ title: '录音失败', icon: 'none' }));
  },

  // 选图片 / 选视频，统一走端到端加密文件消息
  onPickImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: (r) => { const f = r.tempFiles[0]; if (f) this._sendFile(f.tempFilePath, 'image'); },
      fail: () => {},
    });
  },
  onPickVideo() {
    wx.chooseMedia({
      count: 1, mediaType: ['video'], maxDuration: 30,
      success: (r) => { const f = r.tempFiles[0]; if (f) this._sendFile(f.tempFilePath, 'video', Math.round(f.duration || 0)); },
      fail: () => {},
    });
  },
  onVoiceStart() {
    wx.authorize({
      scope: 'scope.record',
      fail: () => wx.showToast({ title: '请在设置里允许麦克风', icon: 'none' }),
    });
    try { this._recorder && this._recorder.start({ duration: 60000, format: 'mp3' }); } catch (e) {}
  },
  onVoiceEnd() {
    try { this._recorder && this._recorder.stop(); } catch (e) {}
  },

  // 发送端到端加密文件消息：选/录 -> 读字节 -> 随机对称密钥加密 -> 上传密文 -> 经中继发描述符
  async _sendFile(tempFilePath, kind, duration) {
    if (!this._room) { wx.showToast({ title: '请先在 🔑 里设置房间号', icon: 'none' }); return; }
    wx.showLoading({ title: '加密发送中' });
    try {
      const buf = await new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({ filePath: tempFilePath, success: (r) => resolve(r.data), fail: reject });
      });
      const kfB64 = crypto.randomKeyB64();        // 本文件独立对称密钥
      const sealedKey = crypto.encrypt(kfB64);    // 用对方公钥封装，只有对方能解
      const cipher = crypto.fileSeal(buf, kfB64);  // 对称加密文件字节
      const fileId = await relay.uploadFile(cipher.buffer, { kind });
      const payload = crypto.encrypt(JSON.stringify({ kind, fileId, sealedKey, duration: duration || 0, name: kind }));
      this._appendLocal({ role: 'me', kind, localPath: tempFilePath, duration: duration || 0, ts: Date.now() });
      try {
        await this._ensureRelay();
        const ok = relay.send(payload);
        if (!ok) wx.showToast({ title: '中继未连接，已存本机', icon: 'none' });
      } catch (e) { wx.showToast({ title: '中继未连接，已存本机', icon: 'none' }); }
    } catch (e) {
      wx.showToast({ title: '发送失败：' + (e.message || e.errMsg || ''), icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // 接收端到端加密文件消息：下载密文 -> 用对称密钥解密 -> 写临时文件 -> 渲染
  async _recvFile(json) {
    try {
      const kfB64 = crypto.decrypt(json.sealedKey); // 解开对称密钥
      const buf = await relay.downloadFileArrayBuffer(json.fileId);
      const plain = crypto.fileOpen(new Uint8Array(buf), kfB64);
      const ext = json.kind === 'voice' ? 'mp3' : (json.kind === 'video' ? 'mp4' : 'png');
      const tmp = `${wx.env.USER_DATA_PATH}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
      await new Promise((resolve, reject) => {
        wx.getFileSystemManager().writeFile({ filePath: tmp, data: plain.buffer, success: resolve, fail: reject });
      });
      this._appendLocal({ role: 'peer', kind: json.kind, localPath: tmp, duration: json.duration || 0, ts: Date.now() });
      wx.vibrateShort({ type: 'light' });
    } catch (e) {
      console.error('文件消息接收失败', e);
      this._appendLocal({ role: 'peer', text: '[图片/视频加载失败]', ts: Date.now() });
    }
  },

  previewImage(e) {
    const p = e.currentTarget.dataset.path;
    if (p) wx.previewImage({ urls: [p], current: p });
  },
  playVoice(e) {
    const p = e.currentTarget.dataset.path;
    if (!p) return;
    if (!this._audio) this._audio = wx.createInnerAudioContext();
    this._audio.stop();
    this._audio.src = p;
    this._audio.play();
  },

  _winInfo() {
    if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo();
    return wx.getSystemInfoSync();
  },
});
