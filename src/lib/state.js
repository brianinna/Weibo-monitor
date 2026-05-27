const fs = require('fs/promises');
const path = require('path');

class StateStore {
  constructor(file) {
    this.file = file;
    this.state = { users: {} };
  }

  async load() {
    try {
      const content = await fs.readFile(this.file, 'utf8');
      this.state = JSON.parse(content);
      if (!this.state.users) this.state.users = {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  getUserPostIds(uid, options = {}) {
    const user = this.state.users[uid];
    return new Set((user && user.posts ? user.posts : []).map((post) => post.id));
  }

  getPendingNotificationPosts(uid) {
    const user = this.state.users[uid];
    const posts = user && user.posts ? user.posts : [];
    return posts.filter(
      (post) => post.notificationPending && Array.isArray(post.notificationPendingBindings) && post.notificationPendingBindings.length > 0
    );
  }

  getLatestPost(uid) {
    const user = this.state.users[uid];
    const posts = user && user.posts ? user.posts : [];
    return posts[0] || null;
  }

  upsertPosts(uid, posts, options = {}) {
    if (!this.state.users[uid]) this.state.users[uid] = { posts: [] };
    const now = new Date().toISOString();
    const existing = new Map(this.state.users[uid].posts.map((post) => [post.id, post]));
    const fresh = [];
    const pendingNotificationIds = new Set(options.pendingNotificationIds || []);
    const deliveredNotificationIds = new Set(options.deliveredNotificationIds || []);
    const pendingBindingsByPost = options.pendingNotificationBindingsByPost || {};
    const deliveredBindingsByPost = options.deliveredNotificationBindingsByPost || {};

    for (const post of posts) {
      const old = existing.get(post.id);
      const oldAttempts = old && Number.isFinite(Number(old.notificationAttempts)) ? Number(old.notificationAttempts) : 0;
      const notificationPatch = {};
      const oldPendingBindings =
        old && Array.isArray(old.notificationPendingBindings)
          ? old.notificationPendingBindings.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
      const pendingBindings = (pendingBindingsByPost[post.id] || []).map((item) => String(item || '').trim()).filter(Boolean);
      const deliveredBindings = (deliveredBindingsByPost[post.id] || []).map((item) => String(item || '').trim()).filter(Boolean);

      if (pendingBindings.length > 0 || deliveredBindings.length > 0) {
        const delivered = new Set(deliveredBindings);
        const nextPending = oldPendingBindings.filter((item) => !delivered.has(item));
        for (const item of pendingBindings) {
          if (!nextPending.includes(item)) nextPending.push(item);
        }
        notificationPatch.notificationPending = nextPending.length > 0;
        notificationPatch.notificationPendingBindings = nextPending;
        notificationPatch.notificationLastAttemptAt = now;
        if (pendingBindings.length > 0) {
          notificationPatch.notificationFailedAt = now;
          notificationPatch.notificationAttempts = oldAttempts + 1;
        }
        if (deliveredBindings.length > 0) {
          notificationPatch.notificationDeliveredAt = now;
        }
      } else if (pendingNotificationIds.has(post.id)) {
        notificationPatch.notificationPending = true;
        notificationPatch.notificationFailedAt = now;
        notificationPatch.notificationLastAttemptAt = now;
        notificationPatch.notificationAttempts = oldAttempts + 1;
      } else if (deliveredNotificationIds.has(post.id)) {
        notificationPatch.notificationPending = false;
        notificationPatch.notificationPendingBindings = [];
        notificationPatch.notificationDeliveredAt = now;
        notificationPatch.notificationLastAttemptAt = now;
      } else if (old && old.notificationPending && !Array.isArray(old.notificationPendingBindings)) {
        notificationPatch.notificationPending = false;
        notificationPatch.notificationPendingBindings = [];
      }

      if (!old) {
        fresh.push(post);
        existing.set(post.id, {
          id: post.id,
          bid: post.bid,
          text: post.text,
          createdAt: post.createdAt,
          source: post.source || '',
          userName: post.userName || '',
          url: post.url,
          screenshot: post.screenshot || '',
          firstSeenAt: now,
          lastSeenAt: now,
          status: 'active',
          ...notificationPatch
        });
      } else {
        existing.set(post.id, {
          ...old,
          bid: post.bid || old.bid,
          text: post.text || old.text,
          createdAt: post.createdAt || old.createdAt,
          source: post.source || old.source || '',
          userName: post.userName || old.userName || '',
          url: post.url || old.url,
          screenshot: post.screenshot || old.screenshot || '',
          lastSeenAt: now,
          status: 'active',
          ...notificationPatch
        });
      }
    }

    this.state.users[uid].posts = [...existing.values()].sort((a, b) => {
      const left = Date.parse(a.createdAt || '') || 0;
      const right = Date.parse(b.createdAt || '') || 0;
      return right - left;
    });

    return fresh.sort((a, b) => {
      const left = Date.parse(a.createdAt || '') || 0;
      const right = Date.parse(b.createdAt || '') || 0;
      return right - left;
    });
  }

  markSeen(uid, post) {
    if (!this.state.users[uid]) this.state.users[uid] = { posts: [] };
    const posts = this.state.users[uid].posts;
    this.upsertPosts(uid, [post]);
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }
}

module.exports = { StateStore };
