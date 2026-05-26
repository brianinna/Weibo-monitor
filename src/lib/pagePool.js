function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    Promise.resolve(promise).catch(() => {});
  });
}

async function closePageQuietly(page, log, timeoutMs = 3000) {
  if (!page || page.isClosed()) return;
  try {
    await withTimeout(page.close(), timeoutMs, `page close timed out after ${timeoutMs}ms`);
  } catch (error) {
    log(`page close skipped: ${error.message}`);
  }
}

class PagePool {
  constructor(context, options = {}) {
    this.context = context;
    this.pages = new Map();
    this.log = options.log || (() => {});
  }

  async getUserPage(uid) {
    const key = `user:${uid}`;
    const existing = this.pages.get(key);
    if (existing && !existing.isClosed()) return existing;

    const page = await this.context.newPage();
    return this.trackPage(key, page);
  }

  trackPage(key, page) {
    this.pages.set(key, page);
    const forget = () => {
      if (this.pages.get(key) === page) this.pages.delete(key);
    };
    page.once('close', forget);
    page.once('crash', () => {
      this.log(`page crashed key=${key}; removing it from page pool`);
      forget();
    });
    return page;
  }

  async invalidateUserPage(uid) {
    await this.invalidate(`user:${uid}`);
  }

  async invalidate(key) {
    const page = this.pages.get(key);
    if (!page) return;
    this.pages.delete(key);
    await closePageQuietly(page, this.log);
  }

  async clear() {
    const pages = Array.from(this.pages.values());
    this.pages.clear();
    await Promise.all(pages.map((page) => closePageQuietly(page, this.log)));
  }
}

module.exports = { PagePool };
