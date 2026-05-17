class PagePool {
  constructor(context) {
    this.context = context;
    this.pages = new Map();
  }

  async getUserPage(uid) {
    const key = `user:${uid}`;
    const existing = this.pages.get(key);
    if (existing && !existing.isClosed()) return existing;

    const page = await this.context.newPage();
    this.pages.set(key, page);
    return page;
  }
}

module.exports = { PagePool };
