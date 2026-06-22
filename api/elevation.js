export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const { locations, source } = body

  // Try Open-Elevation
  if (!source || source === 'open-elevation') {
    try {
      const response = await fetch('https://api.open-elevation.com/api/v1/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations }),
      })
      if (response.ok) {
        const data = await response.json()
        if (data.results) {
          res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400')
          return res.status(200).json({
            results: data.results,
            source: 'Open-Elevation',
          })
        }
      }
    } catch (_) { /* fallback below */ }
  }

  // Fallback: Open Topo Data
  try {
    const locStr = locations.map((l) => `${l.latitude},${l.longitude}`).join('|')
    const response = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${locStr}`)
    if (response.ok) {
      const data = await response.json()
      if (data.results) {
        const mapped = data.results.map((r) => ({ elevation: r.elevation ?? 0, latitude: r.location?.lat, longitude: r.location?.lng }))
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400')
        return res.status(200).json({
          results: mapped,
          source: 'OpenTopoData/SRTM',
        })
      }
    }
  } catch (_) { /* error below */ }

  return res.status(502).json({ error: 'Both elevation APIs failed' })
}
