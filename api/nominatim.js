export default async function handler(req, res) {
  const { q } = req.query
  if (!q) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&addressdetails=1`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'AddressIntelligenceDemo/1.0 (vercel-proxy)' },
    })

    if (!response.ok) {
      return res.status(response.status).json({ error: `Nominatim returned ${response.status}` })
    }

    const data = await response.json()
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400')
    return res.status(200).json(data)
  } catch (e) {
    return res.status(502).json({ error: `Nominatim proxy error: ${e.message}` })
  }
}
