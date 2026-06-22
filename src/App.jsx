import { useState, useCallback } from 'react'

// ─── Utility Functions ──────────────────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = (x) => (x * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function calculateSlope(elevA, elevB, distMeters) {
  if (distMeters === 0) return 0
  return (Math.abs(elevB - elevA) / distMeters) * 100
}

function classifySlope(gradePct) {
  if (gradePct <= 1) return { label: 'Plana', color: 'text-green-400', emoji: '🟢' }
  if (gradePct <= 3) return { label: 'Leve inclinacao', color: 'text-yellow-400', emoji: '🟡' }
  if (gradePct <= 6) return { label: 'Inclinada', color: 'text-orange-400', emoji: '🟠' }
  return { label: 'Muito inclinada', color: 'text-red-400', emoji: '🔴' }
}

function findNearestIntersection(lat, lon, ways) {
  const nodeCount = {}
  for (const way of ways) {
    if (!way.nodes) continue
    for (const nodeId of way.nodes) {
      nodeCount[nodeId] = (nodeCount[nodeId] || 0) + 1
    }
  }
  const intersectionNodeIds = new Set(
    Object.entries(nodeCount)
      .filter(([, count]) => count >= 2)
      .map(([id]) => Number(id))
  )
  let nearest = null
  let minDist = Infinity
  for (const way of ways) {
    if (!way.geometry) continue
    for (let i = 0; i < way.geometry.length; i++) {
      const pt = way.geometry[i]
      if (!pt || pt.lat == null) continue
      const nodeId = way.nodes?.[i]
      if (nodeId && intersectionNodeIds.has(nodeId)) {
        const d = haversineDistance(lat, lon, pt.lat, pt.lon)
        if (d < minDist) {
          minDist = d
          nearest = { lat: pt.lat, lon: pt.lon, distance_m: d }
        }
      }
    }
  }
  return nearest
}

// ─── API Calls ──────────────────────────────────────────────────────────────

async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&addressdetails=1`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AddressIntelligenceDemo/1.0' },
  })
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
  const data = await res.json()
  if (!data.length) throw new Error('Endereco nao encontrado no Nominatim')
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    display_name: data[0].display_name,
  }
}

async function queryOverpass(lat, lon, radius = 300) {
  const query = `
[out:json][timeout:30];
(
  node["amenity"~"bar|pub"](around:${radius},${lat},${lon});
  way["amenity"~"bar|pub"](around:${radius},${lat},${lon});
  node["highway"="bus_stop"](around:${radius},${lat},${lon});
  node["public_transport"~"platform|stop_position"](around:${radius},${lat},${lon});
  way["highway"~"^(residential|primary|secondary|tertiary|trunk|motorway|unclassified|living_street|pedestrian|service|footway|cycleway|track|path)$"](around:${radius},${lat},${lon});
);
out body geom;
`
  const url = 'https://overpass-api.de/api/interpreter'
  const res = await fetch(url, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
  return res.json()
}

function parseOverpassResults(data, lat, lon) {
  const bars = []
  const busStops = []
  const ways = []

  for (const el of data.elements) {
    const tags = el.tags || {}
    const elLat = el.lat ?? el.center?.lat ?? el.geometry?.[0]?.lat
    const elLon = el.lon ?? el.center?.lon ?? el.geometry?.[0]?.lon

    if (tags.amenity === 'bar' || tags.amenity === 'pub') {
      if (elLat != null && elLon != null) {
        bars.push({
          name: tags.name || `${tags.amenity} (sem nome)`,
          lat: elLat,
          lon: elLon,
          distance_m: Math.round(haversineDistance(lat, lon, elLat, elLon)),
          type: tags.amenity,
        })
      }
    }

    if (
      tags.highway === 'bus_stop' ||
      tags.public_transport === 'platform' ||
      tags.public_transport === 'stop_position'
    ) {
      if (elLat != null && elLon != null) {
        const routes = tags.route_ref || tags.ref || null
        busStops.push({
          name: tags.name || 'Parada sem nome',
          lat: elLat,
          lon: elLon,
          distance_m: Math.round(haversineDistance(lat, lon, elLat, elLon)),
          routes: routes ? routes.split(';').map((r) => r.trim()) : [],
        })
      }
    }

    if (el.type === 'way' && tags.highway) {
      ways.push({
        id: el.id,
        name: tags.name || tags.highway,
        highway: tags.highway,
        geometry: el.geometry || [],
        nodes: el.nodes || [],
      })
    }
  }

  bars.sort((a, b) => a.distance_m - b.distance_m)
  busStops.sort((a, b) => a.distance_m - b.distance_m)
  return { bars, busStops, ways }
}

async function fetchElevations(points) {
  const locations = points.map((p) => ({ latitude: p.lat, longitude: p.lon }))
  const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations }),
  })
  if (!res.ok) throw new Error(`Open-Elevation HTTP ${res.status}`)
  const data = await res.json()
  return data.results.map((r) => r.elevation)
}

async function computeSlope(lat, lon, ways) {
  let bestWay = null
  let bestDist = Infinity
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue
    for (const pt of way.geometry) {
      if (!pt || pt.lat == null) continue
      const d = haversineDistance(lat, lon, pt.lat, pt.lon)
      if (d < bestDist) {
        bestDist = d
        bestWay = way
      }
    }
  }
  if (!bestWay || bestWay.geometry.length < 2) {
    return { max_grade_pct: 0, avg_grade_pct: 0, classification: classifySlope(0), sampled_points: [], error: 'Nenhuma via com geometria encontrada' }
  }

  const geom = bestWay.geometry.filter((p) => p && p.lat != null)
  const step = Math.max(1, Math.floor(geom.length / 8))
  const sampled = []
  for (let i = 0; i < geom.length; i += step) {
    sampled.push({ lat: geom[i].lat, lon: geom[i].lon })
  }
  if (sampled.length < 2) {
    sampled.push({ lat: geom[geom.length - 1].lat, lon: geom[geom.length - 1].lon })
  }
  if (sampled.length > 15) sampled.length = 15

  let elevations
  try {
    elevations = await fetchElevations(sampled)
  } catch (e) {
    return {
      max_grade_pct: 0,
      avg_grade_pct: 0,
      classification: classifySlope(0),
      sampled_points: sampled,
      error: `Falha na API de elevacao: ${e.message}`,
      way_name: bestWay.name,
    }
  }

  const grades = []
  const sampledWithElev = sampled.map((p, i) => ({ ...p, elevation: elevations[i] }))
  for (let i = 1; i < sampledWithElev.length; i++) {
    const prev = sampledWithElev[i - 1]
    const curr = sampledWithElev[i]
    const dist = haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon)
    if (dist > 0.5) {
      grades.push(calculateSlope(prev.elevation, curr.elevation, dist))
    }
  }

  const maxGrade = grades.length ? Math.max(...grades) : 0
  const avgGrade = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : 0

  return {
    max_grade_pct: Math.round(maxGrade * 100) / 100,
    avg_grade_pct: Math.round(avgGrade * 100) / 100,
    classification: classifySlope(avgGrade),
    sampled_points: sampledWithElev,
    way_name: bestWay.name,
  }
}

// ─── Main Analysis ──────────────────────────────────────────────────────────

async function analyzeAddress(address, setStatus) {
  const warnings = []

  setStatus('Geocodificando endereco...')
  const geo = await geocodeAddress(address)

  setStatus('Consultando OpenStreetMap (Overpass)...')
  const overpassData = await queryOverpass(geo.lat, geo.lon)
  const { bars, busStops, ways } = parseOverpassResults(overpassData, geo.lat, geo.lon)

  setStatus('Calculando inclinacao (consultando elevacao)...')
  const slope = await computeSlope(geo.lat, geo.lon, ways)
  if (slope.error) warnings.push(slope.error)

  setStatus('Identificando intersecoes...')
  const nearestInt = findNearestIntersection(geo.lat, geo.lon, ways)
  const cornerDist = nearestInt ? Math.round(nearestInt.distance_m) : null

  const allRoutes = new Set()
  busStops.forEach((s) => s.routes.forEach((r) => allRoutes.add(r)))

  return {
    address: geo.display_name,
    lat: geo.lat,
    lon: geo.lon,
    street_slope: {
      max_grade_pct: slope.max_grade_pct,
      avg_grade_pct: slope.avg_grade_pct,
      classification: slope.classification.label,
      sampled_points: slope.sampled_points,
      way_name: slope.way_name || null,
    },
    nearby_bars: {
      count_300m: bars.length,
      nearest: bars.slice(0, 10),
    },
    bus: {
      nearby_stops_300m: busStops.length,
      nearest_stop_m: busStops.length ? busStops[0].distance_m : null,
      routes: allRoutes.size ? [...allRoutes] : ['Linhas nao disponiveis no OSM'],
      stops: busStops.slice(0, 10),
    },
    corner: {
      distance_to_nearest_intersection_m: cornerDist,
      is_near_corner: cornerDist !== null && cornerDist <= 50,
    },
    data_quality: {
      geocoding_source: 'Nominatim/OpenStreetMap',
      osm_source: 'Overpass API',
      elevation_source: 'Open-Elevation API',
      warnings,
    },
    _slope_obj: slope,
  }
}

// ─── React Component ────────────────────────────────────────────────────────

const EXAMPLE_ADDRESSES = [
  'Avenida Paulista, 1578, Sao Paulo, Brasil',
  'Rua Augusta, 2000, Sao Paulo, Brasil',
  'Rua Oscar Freire, 379, Sao Paulo, Brasil',
  'Copacabana, Rio de Janeiro, Brasil',
]

function Card({ title, emoji, children, className = '' }) {
  return (
    <div className={`bg-gray-800/60 border border-gray-700/50 rounded-xl p-5 ${className}`}>
      <h3 className="text-lg font-semibold text-gray-100 mb-3 flex items-center gap-2">
        <span>{emoji}</span> {title}
      </h3>
      {children}
    </div>
  )
}

function StatRow({ label, value, sub }) {
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-gray-700/30 last:border-0">
      <span className="text-gray-400 text-sm">{label}</span>
      <span className="text-gray-100 font-medium text-sm">
        {value}
        {sub && <span className="text-gray-500 text-xs ml-1">{sub}</span>}
      </span>
    </div>
  )
}

export default function App() {
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [showDebug, setShowDebug] = useState(false)

  const handleAnalyze = useCallback(
    async (addr) => {
      const target = addr || address
      if (!target.trim()) return
      setLoading(true)
      setError(null)
      setResult(null)
      setStatus('Iniciando analise...')
      try {
        const data = await analyzeAddress(target.trim(), setStatus)
        setResult(data)
        setStatus('Concluido')
      } catch (e) {
        setError(e.message || 'Erro desconhecido')
        setStatus('')
      } finally {
        setLoading(false)
      }
    },
    [address]
  )

  const handleExample = (addr) => {
    setAddress(addr)
    handleAnalyze(addr)
  }

  const slopeInfo = result ? classifySlope(result.street_slope.avg_grade_pct) : null

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <span className="text-2xl">🏙️</span>
          <div>
            <h1 className="text-xl font-bold text-white leading-tight">Address Intelligence</h1>
            <p className="text-xs text-gray-500">Real Demo &mdash; dados reais via OSM, Overpass & Open-Elevation</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {/* Search */}
        <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-6 mb-6">
          <div className="flex gap-3">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
              placeholder="Digite um endereco completo..."
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={() => handleAnalyze()}
              disabled={loading || !address.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium px-6 py-3 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
            >
              {loading ? '⏳ Analisando...' : '🔍 Analisar'}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-xs text-gray-500 py-1">Exemplos:</span>
            {EXAMPLE_ADDRESSES.map((ex) => (
              <button
                key={ex}
                onClick={() => handleExample(ex)}
                disabled={loading}
                className="text-xs bg-gray-700/50 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-3 py-1 rounded-full transition-colors cursor-pointer disabled:opacity-50"
              >
                {ex.split(',')[0]}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-6 mb-6 text-center">
            <div className="inline-block w-8 h-8 border-3 border-blue-400 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-blue-300 font-medium">{status}</p>
            <p className="text-xs text-gray-500 mt-1">Consultando APIs reais (Nominatim, Overpass, Open-Elevation)</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-900/20 border border-red-800/40 rounded-xl p-6 mb-6">
            <h3 className="text-red-400 font-semibold mb-1">❌ Erro na analise</h3>
            <p className="text-red-300 text-sm">{error}</p>
            <p className="text-gray-500 text-xs mt-2">
              Causas comuns: CORS, rate limit do Nominatim (1 req/s), timeout do Overpass, indisponibilidade do Open-Elevation.
            </p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Geocode header */}
            <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-5">
              <h2 className="text-lg font-semibold text-white mb-2">📍 {result.address}</h2>
              <div className="flex gap-6 text-sm text-gray-400">
                <span>Lat: <span className="text-gray-200 font-mono">{result.lat.toFixed(6)}</span></span>
                <span>Lon: <span className="text-gray-200 font-mono">{result.lon.toFixed(6)}</span></span>
                <a
                  href={`https://www.openstreetmap.org/?mlat=${result.lat}&mlon=${result.lon}#map=17/${result.lat}/${result.lon}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Ver no mapa ↗
                </a>
              </div>
            </div>

            {/* Cards grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Slope Card */}
              <Card title="Inclinacao da Rua" emoji="⛰️">
                <div className="text-center mb-4">
                  <span className="text-4xl">{slopeInfo.emoji}</span>
                  <p className={`text-xl font-bold mt-1 ${slopeInfo.color}`}>{slopeInfo.label}</p>
                  {result.street_slope.way_name && (
                    <p className="text-xs text-gray-500 mt-1">Via: {result.street_slope.way_name}</p>
                  )}
                </div>
                <StatRow label="Inclinacao media" value={`${result.street_slope.avg_grade_pct}%`} />
                <StatRow label="Inclinacao maxima" value={`${result.street_slope.max_grade_pct}%`} />
                <StatRow label="Pontos amostrados" value={result.street_slope.sampled_points.length} />
                {result._slope_obj.error && (
                  <p className="text-xs text-yellow-500 mt-2">⚠️ {result._slope_obj.error}</p>
                )}
              </Card>

              {/* Corner Card */}
              <Card title="Proximidade de Esquina" emoji="🔀">
                <div className="text-center mb-4">
                  <span className="text-4xl">{result.corner.is_near_corner ? '✅' : '📏'}</span>
                  <p className={`text-xl font-bold mt-1 ${result.corner.is_near_corner ? 'text-green-400' : 'text-gray-300'}`}>
                    {result.corner.is_near_corner ? 'Perto da esquina' : 'Longe da esquina'}
                  </p>
                </div>
                <StatRow
                  label="Distancia ate intersecao"
                  value={
                    result.corner.distance_to_nearest_intersection_m !== null
                      ? `${result.corner.distance_to_nearest_intersection_m}m`
                      : 'N/D'
                  }
                />
                <StatRow label="Limite (perto)" value="<= 50m" />
              </Card>

              {/* Bars Card */}
              <Card title="Bares Proximos (300m)" emoji="🍺" className="md:col-span-1">
                <StatRow label="Total encontrados" value={result.nearby_bars.count_300m} />
                {result.nearby_bars.nearest.length > 0 ? (
                  <div className="mt-3 max-h-52 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-500 text-xs">
                          <th className="text-left pb-2">Nome</th>
                          <th className="text-right pb-2">Dist.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.nearby_bars.nearest.map((bar, i) => (
                          <tr key={i} className="border-t border-gray-700/30">
                            <td className="py-1.5 text-gray-300">{bar.name}</td>
                            <td className="py-1.5 text-right text-gray-400 font-mono">{bar.distance_m}m</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm mt-2">Nenhum bar encontrado em 300m no OSM</p>
                )}
              </Card>

              {/* Bus Card */}
              <Card title="Paradas de Onibus (300m)" emoji="🚌" className="md:col-span-1">
                <StatRow label="Paradas encontradas" value={result.bus.nearby_stops_300m} />
                <StatRow label="Parada mais proxima" value={result.bus.nearest_stop_m ? `${result.bus.nearest_stop_m}m` : 'N/D'} />
                <StatRow
                  label="Linhas"
                  value={
                    result.bus.routes[0] === 'Linhas nao disponiveis no OSM'
                      ? 'N/D no OSM'
                      : result.bus.routes.join(', ')
                  }
                />
                {result.bus.stops.length > 0 ? (
                  <div className="mt-3 max-h-52 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-500 text-xs">
                          <th className="text-left pb-2">Parada</th>
                          <th className="text-right pb-2">Dist.</th>
                          <th className="text-right pb-2">Linhas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.bus.stops.map((stop, i) => (
                          <tr key={i} className="border-t border-gray-700/30">
                            <td className="py-1.5 text-gray-300 max-w-[160px] truncate">{stop.name}</td>
                            <td className="py-1.5 text-right text-gray-400 font-mono">{stop.distance_m}m</td>
                            <td className="py-1.5 text-right text-gray-500 text-xs">
                              {stop.routes.length ? stop.routes.join(', ') : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm mt-2">Nenhuma parada encontrada em 300m no OSM</p>
                )}
              </Card>
            </div>

            {/* Data Quality */}
            <Card title="Qualidade dos Dados" emoji="📊">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-gray-500 text-xs">Geocoding</p>
                  <p className="text-gray-300">{result.data_quality.geocoding_source}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">POIs / Vias</p>
                  <p className="text-gray-300">{result.data_quality.osm_source}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Elevacao</p>
                  <p className="text-gray-300">{result.data_quality.elevation_source}</p>
                </div>
              </div>
              {result.data_quality.warnings.length > 0 && (
                <div className="mt-3 space-y-1">
                  {result.data_quality.warnings.map((w, i) => (
                    <p key={i} className="text-yellow-500 text-xs">⚠️ {w}</p>
                  ))}
                </div>
              )}
            </Card>

            {/* Debug JSON */}
            <div>
              <button
                onClick={() => setShowDebug(!showDebug)}
                className="text-sm text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
              >
                {showDebug ? '▼ Esconder' : '▶ Mostrar'} JSON bruto (debug)
              </button>
              {showDebug && (
                <pre className="mt-2 bg-gray-900 border border-gray-700/50 rounded-xl p-4 text-xs text-gray-400 overflow-auto max-h-96 font-mono">
                  {JSON.stringify(result, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div className="text-center py-20 text-gray-600">
            <span className="text-5xl block mb-4">🗺️</span>
            <p className="text-lg">Digite um endereco para comecar a analise</p>
            <p className="text-sm mt-1">Todos os dados sao consultados em tempo real via APIs publicas</p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-12 py-4 text-center text-xs text-gray-600">
        Address Intelligence Real Demo &mdash; Dados reais via Nominatim, Overpass API e Open-Elevation.
        Nenhum dado mockado.
      </footer>
    </div>
  )
}
