module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SERPAPI_KEY = process.env.SERPAPI_KEY;
  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: 'SERPAPI_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const q = String(req.query?.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });
  }

  const params = new URLSearchParams({
    engine: 'google',
    q,
    api_key: SERPAPI_KEY,
    num: '3',
    hl: 'ko',
    gl: 'kr',
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) {
    return res.status(502).json({ error: '검색 실패', detail: data || resp.status });
  }

  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  const results = organic.slice(0, 3).map(r => ({
    title: r.title || '',
    link: r.link || r.displayed_link || '',
    snippet: r.snippet || '',
    source: r.source || '',
  }));

  return res.status(200).json({ q, results });
};

