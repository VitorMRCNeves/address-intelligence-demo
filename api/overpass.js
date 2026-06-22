export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Vercel auto-parses url-encoded body into { data: "..." }
    // Extract the Overpass query and re-encode with encodeURIComponent
    let query
    if (typeof req.body === 'object' && req.body !== null && req.body.data) {
      query = req.body.data
    } else if (typeof req.body === 'string') {
      // Try to extract data= from raw string
      const match = req.body.match(/^data=(.+)$/s)
      query = match ? decodeURIComponent(match[1]) : req.body
    } else {
      return res.status(400).json({ error: 'Missing Overpass query in body' })
    }

    const body = `data=${encodeURIComponent(query)}`

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AddressIntelligenceDemo/1.0',
      },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return res.status(response.status).json({
        error: `Overpass returned ${response.status}`,
        detail: text.slice(0, 500),
      })
    }

    const data = await response.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    return res.status(200).json(data)
  } catch (e) {
    return res.status(502).json({ error: `Overpass proxy error: ${e.message}` })
  }
}
