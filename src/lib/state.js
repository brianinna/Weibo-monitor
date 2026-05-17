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

  getUserPostIds(uid) {
    const user = this.state.users[uid];
    return new Set((user && user.posts ? user.posts : []).map((post) => post.id));
  }

  getLatestPost(uid) {
    const user = this.state.users[uid];
    const posts = user && user.posts ? user.posts : [];
    return posts[0] || null;
  }

  upsertPosts(uid, posts) {
    if (!this.state.users[uid]) this.state.users[uid] = { posts: [] };
    const now = new Date().toISOString();
    const existing = new Map(this.state.users[uid].posts.map((post) => [post.id, post]));
    const fresh = [];

    for (const post of posts) {
      const old = existing.get(post.id);
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
          status: 'active'
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
          status: 'active'
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
