export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: req.body,
    })

    if (!response.ok) {
      return res.status(response.status).json({ error: `Overpass returned ${response.status}` })
    }

    const data = await response.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    return res.status(200).json(data)
  } catch (e) {
    return res.status(502).json({ error: `Overpass proxy error: ${e.message}` })
  }
}
