function parseWeiboUser(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const directId = value.match(/^\d{5,}$/);
  if (directId) {
    return { id: directId[0], url: `https://weibo.com/u/${directId[0]}` };
  }

  const patterns = [
    /m\.weibo\.cn\/u\/(\d{5,})/i,
    /weibo\.com\/u\/(\d{5,})/i,
    /weibo\.com\/(\d{5,})(?:[/?#]|$)/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return { id: match[1], url: `https://weibo.com/u/${match[1]}` };
    }
  }

  return null;
}

module.exports = { parseWeiboUser };
