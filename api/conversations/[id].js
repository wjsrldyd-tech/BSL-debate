module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase 환경변수가 설정되지 않았습니다.' });
  }

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  if (req.method === 'GET') {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?id=eq.${id}&select=*`,
      { headers }
    );
    const data = await resp.json();
    return res.status(200).json(Array.isArray(data) ? (data[0] || null) : data);
  }

  if (req.method === 'DELETE') {
    await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?id=eq.${id}`,
      { method: 'DELETE', headers }
    );
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
