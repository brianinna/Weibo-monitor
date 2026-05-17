const fs = require('fs/promises');
const path = require('path');

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function parseWeiboDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

class WeiboClient {
  constructor(context, options = {}) {
    this.context = context;
    this.pages = new Map();
    this.pagePool = options.pagePool || null;
    this.log = options.log || (() => {});
  }

  async ensurePage(origin) {
    const normalized = origin.replace(/\/$/, '');
    const existing = this.pages.get(normalized);
    if (existing && !existing.isClosed()) return existing;

    const page = await this.context.newPage();
    await page.goto(`${normalized}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.pages.set(normalized, page);
    return page;
  }

  async fetchJson(requestPath, origin = 'https://weibo.com') {
    const url = new URL(requestPath, origin).toString();
    const response = await this.context.request.get(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        referer: `${origin.replace(/\/$/, '')}/`,
        'x-requested-with': 'XMLHttpRequest'
      }
    });

    if (!response.ok()) {
      const body = await response.text().catch(() => '');
      throw new Error(`Weibo request failed: ${response.status()} ${response.statusText()} ${body.slice(0, 200)}`);
    }

    return await response.json();
  }

  async hasLoginCookies() {
    const cookies = await this.context.cookies('https://weibo.com/');
    return cookies.some((cookie) => cookie.name === 'SUB' || cookie.name === 'SUBP');
  }

  async fetchLatestPosts(uid, limit) {
    await this.openUserPage(uid);
    try {
      return await this.fetchLatestPostsFromWeb(uid, limit);
    } catch (error) {
      if (!/403|Forbidden|401|login/i.test(String(error.message))) {
        throw error;
      }
      return await this.fetchLatestPostsFromMobile(uid, limit);
    }
  }

  async fetchRecentPostsUntilKnown(uid, options = {}) {
    await this.openUserPage(uid);
    const knownIds = options.knownIds || new Set();
    const maxPages = Math.max(1, Number(options.maxPages || 3));
    const limit = Math.max(1, Number(options.limit || 5));

    try {
      return await this.fetchRecentPostsUntilKnownFromWeb(uid, { knownIds, maxPages, limit });
    } catch (error) {
      if (!/403|Forbidden|401|login/i.test(String(error.message))) {
        throw error;
      }
      const posts = await this.fetchLatestPostsFromMobile(uid, limit);
      return { posts, hitKnown: posts.some((post) => knownIds.has(post.id)), pages: 1, source: 'mobile' };
    }
  }

  async openUserPage(uid) {
    const page = this.pagePool ? await this.pagePool.getUserPage(uid) : await this.context.newPage();
    const target = `https://weibo.com/${uid}`;
    if (!page.url().startsWith(target)) {
      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      return;
    }

    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
  }

  async fetchLatestPostsFromWeb(uid, limit) {
    const scanned = await this.fetchRecentPostsUntilKnownFromWeb(uid, {
      knownIds: new Set(),
      maxPages: 1,
      limit
    });
    return scanned.posts;
  }

  async fetchWebPage(uid, page, sinceId) {
    const params = new URLSearchParams({
      uid: String(uid),
      page: String(page),
      feature: '0'
    });
    if (sinceId) params.set('since_id', sinceId);

    const data = await this.fetchJson(
      `/ajax/statuses/mymblog?${params.toString()}`,
      'https://weibo.com'
    );

    const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : [];
    if (!Array.isArray(list)) {
      throw new Error(`Cannot read weibo.com mymblog list for uid ${uid}`);
    }
    return {
      list,
      sinceId: data.data && data.data.since_id,
      total: data.data && data.data.total
    };
  }

  async fetchRecentPostsUntilKnownFromWeb(uid, options) {
    const knownIds = options.knownIds || new Set();
    const maxPages = options.maxPages || 3;
    const limit = options.limit || 5;
    const fetchedPosts = [];
    const newPosts = [];
    let sinceId = '';
    let hitKnown = false;
    let pages = 0;
    let total = null;

    for (let page = 1; page <= maxPages; page++) {
      const pageData = await this.fetchWebPage(uid, page, sinceId);
      pages = page;
      sinceId = pageData.sinceId || '';
      total = pageData.total;

      const nonTop = pageData.list
        .filter((item) => item && (item.idstr || item.id))
        .filter((item) => item.isTop !== 1);

      this.log(
        `uid=${uid} web page=${page} fetched=${pageData.list.length}, nonTop=${nonTop.length}, sinceId=${sinceId || 'none'}, total=${total}`
      );

      for (const item of nonTop) {
        const post = this.normalizeWebPost(uid, item);
        fetchedPosts.push(post);
        if (knownIds.has(post.id)) {
          hitKnown = true;
          continue;
        }
        if (!hitKnown) {
          newPosts.push(post);
        }
      }

      if (hitKnown || !sinceId) break;
    }

    const unique = [];
    const seen = new Set();
    for (const post of fetchedPosts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      unique.push(post);
    }

    const sorted = unique.sort((a, b) => parseWeiboDate(b.createdAt) - parseWeiboDate(a.createdAt));
    const hydrated = await this.hydrateLongText(sorted.slice(0, Math.max(limit, sorted.length)));
    const hydratedNewPosts = await this.hydrateLongText(newPosts);
    this.log(
      `uid=${uid} scan pages=${pages}, posts=${hydrated.length}, hitKnown=${hitKnown}, returning=${hydrated
        .slice(0, limit)
        .map((post) => post.id)
        .join(', ')}`
    );
    return {
      posts: hydrated.slice(0, limit),
      scannedPosts: hydrated,
      newPosts: hydratedNewPosts,
      hitKnown,
      pages,
      total,
      source: 'web'
    };
  }

  normalizeWebPost(uid, item) {
    const id = String(item.idstr || item.id);
    const bid = item.mblogid || item.bid || '';
    const text = item.text_raw || stripHtml(item.text);
    return {
      id,
      bid,
      text,
      createdAt: item.created_at || '',
      source: stripHtml(item.source || ''),
      userName: item.user ? item.user.screen_name : '',
      url: bid ? `https://weibo.com/${uid}/${bid}` : `https://weibo.com/${uid}/${id}`
    };
  }

  async hydrateLongText(posts) {
    for (const post of posts) {
      try {
        const data = await this.fetchJson(`/ajax/statuses/longtext?id=${encodeURIComponent(post.id)}`, 'https://weibo.com');
        const longText = data && data.data && (data.data.longTextContent_raw || data.data.longTextContent);
        if (longText) post.text = stripHtml(longText);
      } catch (_) {
        // Long text is optional; keep the list text if the detail endpoint fails.
      }
    }
    return posts;
  }

  async capturePostScreenshots(uid, posts, outputDir) {
    if (!posts.length) return posts;
    await fs.mkdir(outputDir, { recursive: true });
    const missing = [];
    for (const post of posts) {
      const file = path.join(outputDir, `${sanitizeFileName(post.id)}.png`);
      post.screenshot = file;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.size > 0) {
        this.log(`uid=${uid} screenshot exists post=${post.id} file=${file}`);
      } else {
        missing.push({ post, file });
      }
    }

    if (missing.length === 0) return posts;

    let page;
    try {
      page = await this.context.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
    } catch (error) {
      this.log(`uid=${uid} screenshot page failed: ${error.message}`);
      return posts;
    }

    try {
      for (const item of missing) {
        const { post, file } = item;
        try {
          await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1200);

          const article = page.locator('article').first();
          const count = await article.count();
          if (count > 0) {
            await article.screenshot({ path: file, timeout: 12000 });
          } else {
            await page.screenshot({ path: file, fullPage: false, timeout: 12000 });
          }

          this.log(`uid=${uid} screenshot saved post=${post.id} file=${file}`);
        } catch (error) {
          this.log(`uid=${uid} screenshot failed post=${post.id}: ${error.message}`);
        }
      }
    } finally {
      await page.close().catch(() => {});
    }

    return posts;
  }

  async resolveMobileContainerId(uid) {
    const data = await this.fetchJson(
      `/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}`,
      'https://m.weibo.cn'
    );
    const tabs = data && data.data && data.data.tabsInfo && data.data.tabsInfo.tabs;
    if (!Array.isArray(tabs)) {
      throw new Error(`Cannot read mobile tabsInfo for uid ${uid}`);
    }

    const weiboTab = tabs.find((tab) => tab.tab_type === 'weibo');
    if (!weiboTab || !weiboTab.containerid) {
      throw new Error(`Cannot find mobile weibo containerid for uid ${uid}`);
    }
    return weiboTab.containerid;
  }

  async fetchLatestPostsFromMobile(uid, limit) {
    const containerId = await this.resolveMobileContainerId(uid);
    const data = await this.fetchJson(
      `/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}&containerid=${encodeURIComponent(containerId)}`,
      'https://m.weibo.cn'
    );

    const cards = data && data.data && Array.isArray(data.data.cards) ? data.data.cards : [];
    return cards
      .filter((card) => card.card_type === 9 && card.mblog)
      .filter((card) => card.mblog.isTop !== 1)
      .map((card) => {
        const mblog = card.mblog;
        const bid = mblog.bid || mblog.mblogid || '';
        return {
          id: String(mblog.id),
          bid,
          text: stripHtml(mblog.text),
          createdAt: mblog.created_at || '',
          source: stripHtml(mblog.source || ''),
          userName: mblog.user ? mblog.user.screen_name : '',
          url: bid ? `https://weibo.com/${uid}/${bid}` : `https://m.weibo.cn/detail/${mblog.id}`
        };
      })
      .sort((a, b) => parseWeiboDate(b.createdAt) - parseWeiboDate(a.createdAt))
      .slice(0, limit);
  }
}

module.exports = { WeiboClient };
