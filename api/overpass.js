export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Vercel auto-parses url-encoded body into an object { data: "..." }
    // Reconstruct the url-encoded string for the upstream request
    let body
    if (typeof req.body === 'object' && req.body !== null) {
      body = new URLSearchParams(req.body).toString()
    } else if (typeof req.body === 'string') {
      body = req.body
    } else {
      return res.status(400).json({ error: 'Missing body' })
    }

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return res.status(response.status).json({ error: `Overpass returned ${response.status}`, detail: text.slice(0, 500) })
    }

    const data = await response.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    return res.status(200).json(data)
  } catch (e) {
    return res.status(502).json({ error: `Overpass proxy error: ${e.message}` })
  }
}
