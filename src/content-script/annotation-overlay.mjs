const VIZCHAT_OVERLAY_ID = 'vizchat-ai-annotation-overlay'
const VIZCHAT_ANNOTATION_TAG_START = '[VIZCHAT_ANNOTATIONS_JSON]'
const VIZCHAT_ANNOTATION_TAG_END = '[/VIZCHAT_ANNOTATIONS_JSON]'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getScaleMeta(payload, fallbackWidth, fallbackHeight) {
  const sourceWidth = Number(
    payload?.imageWidth ?? payload?.sourceWidth ?? payload?.width ?? fallbackWidth,
  )
  const sourceHeight = Number(
    payload?.imageHeight ?? payload?.sourceHeight ?? payload?.height ?? fallbackHeight,
  )
  const coordinateSystem = String(payload?.coordinateSystem ?? payload?.coordinateMode ?? 'auto')
    .toLowerCase()

  return {
    sourceWidth: Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : null,
    sourceHeight: Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : null,
    coordinateSystem,
  }
}

function projectValue(value, viewportMax, sourceMax, coordinateSystem, kindHint = 'position') {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return null

  if (coordinateSystem === 'normalized') {
    return clamp(numericValue * viewportMax, 0, viewportMax)
  }
  if (coordinateSystem === 'percent') {
    return clamp((numericValue / 100) * viewportMax, 0, viewportMax)
  }
  if (coordinateSystem === 'image-pixels' && sourceMax) {
    return (numericValue / sourceMax) * viewportMax
  }

  if (numericValue >= 0 && numericValue <= 1) {
    return numericValue * viewportMax
  }

  if (numericValue > 1 && numericValue <= 100) {
    // Treat values up to 100 as percent in auto mode to avoid giant boxes.
    return (numericValue / 100) * viewportMax
  }

  if (sourceMax && numericValue > viewportMax * 1.1) {
    return (numericValue / sourceMax) * viewportMax
  }

  if (kindHint === 'size' && numericValue > viewportMax) {
    return viewportMax
  }

  return numericValue
}

function getChartKeywordScore(element) {
  const signal = `${element.id || ''} ${element.className || ''} ${element.alt || ''} ${
    element.ariaLabel || ''
  }`.toLowerCase()
  if (!signal) return 0

  let score = 0
  if (signal.includes('chart')) score += 4
  if (signal.includes('graph')) score += 3
  if (signal.includes('plot')) score += 2
  if (signal.includes('analytics')) score += 2
  if (signal.includes('dashboard')) score += 2
  if (signal.includes('figure')) score += 1
  return score
}

export function detectLikelyChartRect() {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const viewportArea = Math.max(1, viewportWidth * viewportHeight)

  const candidates = [...document.querySelectorAll('canvas, svg, img')]
    .map((element) => {
      const rect = element.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0))
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
      )
      const visibleArea = visibleWidth * visibleHeight

      if (visibleWidth < 80 || visibleHeight < 60 || visibleArea < 9000) return null

      const areaRatio = visibleArea / viewportArea
      const areaScore = 1 - Math.abs(areaRatio - 0.12) * 3.2
      const positionScore =
        (rect.top < viewportHeight * 0.85 ? 0.8 : 0) +
        (rect.left < viewportWidth * 0.9 ? 0.2 : 0)
      const typeScore =
        element.tagName.toLowerCase() === 'svg' || element.tagName.toLowerCase() === 'canvas'
          ? 1.3
          : 0.5
      const keywordScore = getChartKeywordScore(element)

      return {
        rect,
        score: areaScore + positionScore + typeScore + keywordScore,
      }
    })
    .filter(Boolean)

  if (candidates.length === 0) return null

  const best = candidates.sort((a, b) => b.score - a.score)[0].rect
  return {
    x: clamp(best.left, 0, viewportWidth),
    y: clamp(best.top, 0, viewportHeight),
    width: clamp(best.width, 30, viewportWidth),
    height: clamp(best.height, 30, viewportHeight),
  }
}

function getRectFromChartBox(payloadChartBox, viewportWidth, viewportHeight, coordinateSystem = 'normalized') {
  if (!payloadChartBox) return null
  const boxX = projectValue(payloadChartBox.x, viewportWidth, null, coordinateSystem)
  const boxY = projectValue(payloadChartBox.y, viewportHeight, null, coordinateSystem)
  const boxW = projectValue(
    payloadChartBox.w ?? payloadChartBox.width,
    viewportWidth,
    null,
    coordinateSystem,
    'size',
  )
  const boxH = projectValue(
    payloadChartBox.h ?? payloadChartBox.height,
    viewportHeight,
    null,
    coordinateSystem,
    'size',
  )

  if ([boxX, boxY, boxW, boxH].some((v) => v === null)) return null
  return {
    x: clamp(boxX, 0, viewportWidth),
    y: clamp(boxY, 0, viewportHeight),
    width: clamp(boxW, 20, viewportWidth),
    height: clamp(boxH, 20, viewportHeight),
  }
}

function projectPointToRect(value, rectStart, rectSize, sourceSize, coordinateSystem) {
  const projected = projectValue(value, rectSize, sourceSize, coordinateSystem)
  if (projected === null) return null
  return rectStart + projected
}

function wrapText(text, maxCharsPerLine = 58, maxLines = 4) {
  const source = String(text || '').trim()
  if (!source) return []

  const words = source.split(/\s+/)
  const lines = []
  let current = ''

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= maxCharsPerLine) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  })
  if (current) lines.push(current)

  const clipped = lines.slice(0, maxLines)
  if (lines.length > maxLines) {
    clipped[maxLines - 1] = `${clipped[maxLines - 1].slice(0, Math.max(0, maxCharsPerLine - 3))}...`
  }
  return clipped
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

function rectsOverlapWithPadding(a, b, padding = 0) {
  const expandedA = {
    x: a.x - padding,
    y: a.y - padding,
    width: a.width + padding * 2,
    height: a.height + padding * 2,
  }
  const expandedB = {
    x: b.x - padding,
    y: b.y - padding,
    width: b.width + padding * 2,
    height: b.height + padding * 2,
  }
  return rectsOverlap(expandedA, expandedB)
}

function overlapArea(a, b) {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return xOverlap * yOverlap
}

function normalizeAnnotationTitle(rawTitle) {
  const title = String(rawTitle || '').trim()
  // Remove AI-provided numeric prefixes so UI numbering stays consistent.
  return title.replace(/^\s*\d+\s*[)\].:-]?\s*/, '').trim()
}

function findBestCalloutPlacement(
  focus,
  boxWidth,
  boxHeight,
  viewportWidth,
  viewportHeight,
  occupied,
  avoidRects,
) {
  const margin = 8
  const gap = 10
  const minBoxGap = 14
  const maxHorizontalOffset = Math.max(180, Math.min(320, viewportWidth * 0.22))
  const longConnectorThreshold = Math.max(220, Math.min(320, viewportWidth * 0.2))

  // Keep callouts above the focused region, but avoid pinning them to viewport top.
  const preferredTop = focus.cy - focus.r - boxHeight - 20
  const bandTop = clamp(preferredTop - 40, 42, Math.max(42, viewportHeight * 0.24))
  const bandBottom = clamp(
    preferredTop + 130,
    bandTop + boxHeight + gap,
    Math.max(bandTop + boxHeight + gap, viewportHeight * 0.72),
  )

  const rowHeight = boxHeight + gap
  const maxRows = Math.max(1, Math.floor((bandBottom - bandTop) / rowHeight) + 1)
  const candidates = []
  const xOffsets = [0, -0.22, 0.22, -0.4, 0.4, -0.58, 0.58]

  for (let row = 0; row < maxRows; row += 1) {
    const y = clamp(bandTop + row * rowHeight, bandTop, bandBottom)
    // Prioritize positions near focus x to keep connector short.
    xOffsets.forEach((offset) => {
      const x = focus.cx - boxWidth / 2 + offset * maxHorizontalOffset
      candidates.push({ x, y })
    })
  }

  // A couple of extra rows below if upper area is crowded.
  for (let extra = 1; extra <= 2; extra += 1) {
    const overflowY = clamp(
      bandBottom + extra * rowHeight,
      margin,
      viewportHeight - boxHeight - margin,
    )
    xOffsets.forEach((offset) => {
      candidates.push({ x: focus.cx - boxWidth * offset, y: overflowY })
    })
  }

  let bestNoCollision = null
  let bestFallback = null

  candidates.forEach((candidate) => {
    const placed = {
      x: clamp(candidate.x, margin, viewportWidth - boxWidth - margin),
      y: clamp(candidate.y, bandTop, Math.max(bandTop, bandBottom - boxHeight)),
      width: boxWidth,
      height: boxHeight,
    }

    let hasCollision = false
    let totalOverlap = 0
    occupied.forEach((o) => {
      if (rectsOverlapWithPadding(placed, o, minBoxGap)) {
        hasCollision = true
        totalOverlap += overlapArea(placed, o)
      }
    })

    let avoidOverlap = 0
    avoidRects.forEach((r) => {
      if (rectsOverlapWithPadding(placed, r, 5)) {
        avoidOverlap += overlapArea(placed, r)
      }
    })

    const centerDx = Math.abs(placed.x + placed.width / 2 - focus.cx)
    const centerDy = Math.abs(placed.y + placed.height / 2 - focus.cy)
    const distanceScore = centerDx + centerDy
    const connectorPenalty =
      distanceScore > longConnectorThreshold
        ? (distanceScore - longConnectorThreshold) * 300
        : 0

    const score =
      totalOverlap * 1000 +
      avoidOverlap * 2000 +
      distanceScore +
      connectorPenalty +
      (hasCollision ? 50000 : 0) +
      (avoidOverlap > 0 ? 90000 : 0)

    if (!hasCollision && avoidOverlap === 0) {
      if (!bestNoCollision || score < bestNoCollision.score) {
        bestNoCollision = { ...placed, score }
      }
    }

    if (!bestFallback || score < bestFallback.score) {
      bestFallback = { ...placed, score }
    }
  })

  if (bestNoCollision) return bestNoCollision

  // Hard fallback: local free-slot scan near this focus (not full viewport).
  const scanStepY = rowHeight
  const scanStepX = Math.max(40, Math.floor(boxWidth * 0.35))
  const localScanLeft = clamp(focus.cx - maxHorizontalOffset - boxWidth, margin, viewportWidth - boxWidth - margin)
  const localScanRight = clamp(focus.cx + maxHorizontalOffset, margin, viewportWidth - boxWidth - margin)
  const localScanBottom = clamp(bandBottom + rowHeight * 2, bandBottom, viewportHeight - boxHeight - margin)

  for (
    let y = Math.max(margin, Math.floor(bandTop));
    y <= localScanBottom;
    y += scanStepY
  ) {
    for (let x = localScanLeft; x <= localScanRight; x += scanStepX) {
      const candidate = { x, y, width: boxWidth, height: boxHeight }
      const collideOccupied = occupied.some((o) => rectsOverlapWithPadding(candidate, o, minBoxGap))
      const collideCircle = avoidRects.some((r) => rectsOverlapWithPadding(candidate, r, 5))
      if (!collideOccupied && !collideCircle) {
        return { ...candidate, score: Number.MAX_SAFE_INTEGER - 1 }
      }
    }
  }

  return bestFallback || {
    x: clamp(focus.cx - boxWidth / 2, margin, viewportWidth - boxWidth - margin),
    y: clamp(preferredTop, bandTop, Math.max(bandTop, bandBottom - boxHeight)),
    width: boxWidth,
    height: boxHeight,
    score: Number.MAX_SAFE_INTEGER,
  }
}

function resolveCircleOverlaps(entries, minRadius = 26, gap = 10) {
  if (!entries || entries.length < 2) return

  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i]
        const b = entries[j]
        const dx = b.focus.cx - a.focus.cx
        const dy = b.focus.cy - a.focus.cy
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const requiredDist = a.focus.r + b.focus.r + gap

        if (dist >= requiredDist) continue

        const overlap = requiredDist - dist
        const aReducible = Math.max(0, a.focus.r - minRadius)
        const bReducible = Math.max(0, b.focus.r - minRadius)
        const totalReducible = aReducible + bReducible

        if (totalReducible > 0) {
          const aReduce = (overlap * aReducible) / totalReducible
          const bReduce = (overlap * bReducible) / totalReducible
          const newAR = Math.max(minRadius, a.focus.r - aReduce)
          const newBR = Math.max(minRadius, b.focus.r - bReduce)

          if (newAR !== a.focus.r || newBR !== b.focus.r) {
            a.focus.r = newAR
            b.focus.r = newBR
            changed = true
          }
        }
      }
    }

    if (!changed) break
  }
}

function getFocusFromAnnotation(
  annotation,
  effectiveRect,
  scaleMeta,
  effectiveCoordinateSystem,
) {
  const kind = String(annotation.type || annotation.kind || 'focus').toLowerCase()

  if (kind === 'arrow') {
    const x = projectPointToRect(
      annotation.x2 ?? annotation.x1,
      effectiveRect.x,
      effectiveRect.width,
      scaleMeta.sourceWidth,
      effectiveCoordinateSystem,
    )
    const y = projectPointToRect(
      annotation.y2 ?? annotation.y1,
      effectiveRect.y,
      effectiveRect.height,
      scaleMeta.sourceHeight,
      effectiveCoordinateSystem,
    )
    if (x === null || y === null) return null
    return {
      cx: x,
      cy: y,
      r: Math.max(34, Math.min(effectiveRect.width, effectiveRect.height) * 0.08),
    }
  }

  const cx = projectPointToRect(
    annotation.cx,
    effectiveRect.x,
    effectiveRect.width,
    scaleMeta.sourceWidth,
    effectiveCoordinateSystem,
  )
  const cy = projectPointToRect(
    annotation.cy,
    effectiveRect.y,
    effectiveRect.height,
    scaleMeta.sourceHeight,
    effectiveCoordinateSystem,
  )
  const r = projectValue(
    annotation.r,
    Math.min(effectiveRect.width, effectiveRect.height),
    Math.min(scaleMeta.sourceWidth || 0, scaleMeta.sourceHeight || 0) || null,
    effectiveCoordinateSystem,
    'size',
  )

  if (cx !== null && cy !== null && r !== null) {
    return {
      cx,
      cy,
      r: Math.max(18, r),
    }
  }

  const x = projectPointToRect(
    annotation.x,
    effectiveRect.x,
    effectiveRect.width,
    scaleMeta.sourceWidth,
    effectiveCoordinateSystem,
  )
  const y = projectPointToRect(
    annotation.y,
    effectiveRect.y,
    effectiveRect.height,
    scaleMeta.sourceHeight,
    effectiveCoordinateSystem,
  )
  const w = projectValue(
    annotation.w ?? annotation.width,
    effectiveRect.width,
    scaleMeta.sourceWidth,
    effectiveCoordinateSystem,
    'size',
  )
  const h = projectValue(
    annotation.h ?? annotation.height,
    effectiveRect.height,
    scaleMeta.sourceHeight,
    effectiveCoordinateSystem,
    'size',
  )

  if ([x, y, w, h].some((v) => v === null)) return null

  const clampedW = Math.max(10, Math.min(w, effectiveRect.width))
  const clampedH = Math.max(10, Math.min(h, effectiveRect.height))

  const halfW = clampedW / 2
  const halfH = clampedH / 2
  const fullCoverRadius = Math.sqrt(halfW * halfW + halfH * halfH)
  const padding = Math.max(14, Math.min(clampedW, clampedH) * 0.16)

  return {
    cx: x + halfW,
    cy: y + halfH,
    // Circle radius covers full rectangular region + padding.
    r: Math.max(24, fullCoverRadius + padding),
  }
}

function getLanguageName(languageCode) {
  const normalized = String(languageCode || '').toLowerCase()
  if (normalized.startsWith('vi')) return 'Vietnamese'
  if (normalized.startsWith('en')) return 'English'
  if (normalized.startsWith('fr')) return 'French'
  if (normalized.startsWith('de')) return 'German'
  if (normalized.startsWith('es')) return 'Spanish'
  if (normalized.startsWith('pt')) return 'Portuguese'
  if (normalized.startsWith('ja')) return 'Japanese'
  if (normalized.startsWith('ko')) return 'Korean'
  if (normalized.startsWith('ru')) return 'Russian'
  if (normalized.startsWith('tr')) return 'Turkish'
  if (normalized.startsWith('zh')) return 'Chinese'
  return 'the same language as the user interface'
}

export function extractAnnotationPayload(answerText) {
  if (!answerText || typeof answerText !== 'string') return null

  const taggedRegex = /\[VIZCHAT_ANNOTATIONS_JSON\]([\s\S]*?)\[\/VIZCHAT_ANNOTATIONS_JSON\]/i
  const taggedMatch = answerText.match(taggedRegex)
  if (taggedMatch?.[1]) {
    try {
      const parsed = JSON.parse(taggedMatch[1].trim())
      if (Array.isArray(parsed?.annotations)) return parsed
    } catch (e) {
      /* empty */
    }
  }

  const fencedRegex = /```(?:vizchat-annotations|json)\s*([\s\S]*?)```/gi
  let fenceMatch
  while ((fenceMatch = fencedRegex.exec(answerText)) !== null) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim())
      if (Array.isArray(parsed?.annotations)) return parsed
    } catch (e) {
      /* empty */
    }
  }

  return null
}

export function stripAnnotationPayload(answerText) {
  if (!answerText || typeof answerText !== 'string') return answerText

  let cleaned = answerText
    .replace(/\[VIZCHAT_ANNOTATIONS_JSON\][\s\S]*?\[\/VIZCHAT_ANNOTATIONS_JSON\]/gi, '')
    .replace(/```vizchat-annotations\s*[\s\S]*?```/gi, '')
    .trim()

  if (!cleaned) cleaned = answerText
  return cleaned
}

export function clearAnnotationOverlay() {
  document.getElementById(VIZCHAT_OVERLAY_ID)?.remove()
}

export function renderAnnotationOverlay(payload, fallbackWidth, fallbackHeight, fallbackChartRect) {
  clearAnnotationOverlay()
  if (!payload || !Array.isArray(payload.annotations) || payload.annotations.length === 0) return

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const scaleMeta = getScaleMeta(payload, fallbackWidth, fallbackHeight)
  const chartBoxCoordinateSystem = String(payload?.chartBoxCoordinateSystem || 'normalized')
    .toLowerCase()

  // Ignore obviously large AI chart boxes that tend to cause oversized overlays.
  const chartRectFromPayload = getRectFromChartBox(
    payload?.chartBox,
    viewportWidth,
    viewportHeight,
    chartBoxCoordinateSystem,
  )
  const fallbackOrDetectedChartRect = fallbackChartRect || detectLikelyChartRect()
  const chartRect = (() => {
    if (!chartRectFromPayload) return fallbackOrDetectedChartRect
    const payloadArea = chartRectFromPayload.width * chartRectFromPayload.height
    const viewportArea = viewportWidth * viewportHeight
    if (payloadArea / viewportArea > 0.5) {
      return fallbackOrDetectedChartRect || chartRectFromPayload
    }
    return chartRectFromPayload
  })()

  const mode = String(payload?.coordinateSystem || 'auto').toLowerCase()
  const useChartRect =
    mode === 'chart-normalized' ||
    mode === 'chart-percent' ||
    mode === 'chart-pixels' ||
    mode === 'normalized' ||
    mode === 'percent' ||
    mode === 'auto'

  const effectiveRect =
    useChartRect && chartRect
      ? chartRect
      : { x: 0, y: 0, width: viewportWidth, height: viewportHeight }

  const effectiveCoordinateSystem = (() => {
    if (mode === 'chart-normalized') return 'normalized'
    if (mode === 'chart-percent') return 'percent'
    if (mode === 'chart-pixels') return 'image-pixels'
    if (mode === 'normalized' || mode === 'percent' || mode === 'image-pixels') return mode
    return scaleMeta.coordinateSystem
  })()

  const container = document.createElement('div')
  container.id = VIZCHAT_OVERLAY_ID
  container.className = 'vizchat-ai-annotation-overlay'
  container.style.position = 'fixed'
  container.style.inset = '0'
  container.style.pointerEvents = 'none'
  container.style.zIndex = '2147483647'

  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('width', `${viewportWidth}`)
  svg.setAttribute('height', `${viewportHeight}`)
  svg.setAttribute('viewBox', `0 0 ${viewportWidth} ${viewportHeight}`)

  const defs = document.createElementNS(svgNS, 'defs')
  svg.appendChild(defs)

  const occupiedCallouts = []
  let nextSequentialX = 8

  const entries = payload.annotations.slice(0, 5).map((item) => {
    const annotation = item || {}
    const color = annotation.color || '#ff4d4f'
    const focus = getFocusFromAnnotation(annotation, effectiveRect, scaleMeta, effectiveCoordinateSystem)
    if (!focus) return null

    const title = String(annotation.title || annotation.label || annotation.text || '').trim()
    const reason = String(annotation.why || annotation.reason || annotation.explanation || '').trim()
    return { annotation, color, focus, title, reason }
  }).filter(Boolean)

  // Always render annotations from left to right on the chart.
  entries.sort((a, b) => a.focus.cx - b.focus.cx)

  // Keep circle sizes as-is so each circle continues to fully cover its target.

  const circleRects = entries.map((entry) => ({
    x: entry.focus.cx - entry.focus.r,
    y: entry.focus.cy - entry.focus.r,
    width: entry.focus.r * 2,
    height: entry.focus.r * 2,
  }))

  entries.forEach((entry, entryIndex) => {
    const { color, focus, title, reason } = entry

    const cleanTitle = normalizeAnnotationTitle(title)
    const calloutLines = []
    calloutLines.push(`${entryIndex + 1}) ${cleanTitle || 'Focus point'}`)
    if (reason) calloutLines.push(`Ly do: ${reason}`)

    const renderedLines = calloutLines
      .flatMap((line) => wrapText(line, 58, 2))
      .slice(0, 3)

    if (renderedLines.length === 0) return

    const ring = document.createElementNS(svgNS, 'circle')
    ring.setAttribute('cx', `${focus.cx}`)
    ring.setAttribute('cy', `${focus.cy}`)
    ring.setAttribute('r', `${focus.r}`)
    ring.setAttribute('fill', 'rgba(255, 77, 79, 0.04)')
    ring.setAttribute('stroke', color)
    ring.setAttribute('stroke-width', '3')
    svg.appendChild(ring)

    const maxLineLength = renderedLines.reduce((maxLen, line) => Math.max(maxLen, line.length), 0)
    const boxWidth = clamp(maxLineLength * 7 + 16, 150, 430)
    const boxHeight = renderedLines.length * 16 + 10

    const avoidRects = circleRects.filter((_, idx) => idx !== entryIndex)

    // Prefer a deterministic left-to-right layout for better readability.
    const margin = 8
    const laneLeft = clamp(effectiveRect.x + 10, margin, viewportWidth - margin)
    const laneRight = clamp(
      effectiveRect.x + effectiveRect.width - 10,
      laneLeft + 1,
      viewportWidth - margin,
    )
    const slotStep = (laneRight - laneLeft) / Math.max(1, entries.length)
    const slotCenter = laneLeft + slotStep * (entryIndex + 0.5)
    const preferredY = clamp(
      effectiveRect.y - boxHeight - 14,
      margin,
      Math.max(margin, viewportHeight - boxHeight - margin),
    )

    let sequentialX = clamp(slotCenter - boxWidth / 2, margin, viewportWidth - boxWidth - margin)
    sequentialX = Math.max(sequentialX, nextSequentialX)

    let placedBox = {
      x: clamp(sequentialX, margin, viewportWidth - boxWidth - margin),
      y: preferredY,
      width: boxWidth,
      height: boxHeight,
    }

    const hasSequentialCollision =
      occupiedCallouts.some((o) => rectsOverlapWithPadding(placedBox, o, 12)) ||
      avoidRects.some((r) => rectsOverlapWithPadding(placedBox, r, 5))

    if (hasSequentialCollision) {
      placedBox = findBestCalloutPlacement(
        focus,
        boxWidth,
        boxHeight,
        viewportWidth,
        viewportHeight,
        occupiedCallouts,
        avoidRects,
      )
    }

    occupiedCallouts.push(placedBox)
    nextSequentialX = Math.min(
      viewportWidth - margin,
      placedBox.x + placedBox.width + 10,
    )

    const textX = placedBox.x + 6
    const textY = placedBox.y + 14

    const background = document.createElementNS(svgNS, 'rect')
    background.setAttribute('x', `${placedBox.x}`)
    background.setAttribute('y', `${placedBox.y}`)
    background.setAttribute('width', `${placedBox.width}`)
    background.setAttribute('height', `${placedBox.height}`)
    background.setAttribute('rx', '6')
    background.setAttribute('fill', 'rgba(255,255,255,0.92)')
    background.setAttribute('stroke', color)
    background.setAttribute('stroke-width', '1.5')
    svg.appendChild(background)

    const boxCenterX = placedBox.x + placedBox.width / 2
    const boxCenterY = placedBox.y + placedBox.height / 2
    const dx = boxCenterX - focus.cx
    const dy = boxCenterY - focus.cy
    const connectorNorm = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const startX = focus.cx + (dx / connectorNorm) * focus.r
    const startY = focus.cy + (dy / connectorNorm) * focus.r

    const endX = clamp(boxCenterX, placedBox.x + 10, placedBox.x + placedBox.width - 10)
    const endY = clamp(boxCenterY, placedBox.y + 8, placedBox.y + placedBox.height - 8)

    const connector = document.createElementNS(svgNS, 'line')
    connector.setAttribute('x1', `${startX}`)
    connector.setAttribute('y1', `${startY}`)
    connector.setAttribute('x2', `${endX}`)
    connector.setAttribute('y2', `${endY}`)
    connector.setAttribute('stroke', color)
    connector.setAttribute('stroke-width', '2')
    connector.setAttribute('stroke-dasharray', '4 3')
    svg.appendChild(connector)

    const text = document.createElementNS(svgNS, 'text')
    text.setAttribute('x', `${textX}`)
    text.setAttribute('y', `${textY}`)
    text.setAttribute('fill', color)
    text.setAttribute('font-size', '12.5')
    text.setAttribute('font-weight', '700')
    text.setAttribute('paint-order', 'stroke')
    text.setAttribute('stroke', 'rgba(255,255,255,0.98)')
    text.setAttribute('stroke-width', '2.5')

    renderedLines.forEach((line, lineIndex) => {
      const tspan = document.createElementNS(svgNS, 'tspan')
      tspan.setAttribute('x', `${textX}`)
      tspan.setAttribute('dy', lineIndex === 0 ? '0' : '16')
      tspan.textContent = line
      text.appendChild(tspan)
    })

    svg.appendChild(text)
  })

  container.appendChild(svg)
  document.body.appendChild(container)
}

export function buildAnnotatedQuestion(question, sourceWidth, sourceHeight, preferredLanguageCode) {
  const languageName = getLanguageName(preferredLanguageCode)
  const isVietnamese = String(preferredLanguageCode || '').toLowerCase().startsWith('vi')
  const sampleTitle1 = isVietnamese ? 'Giai đoạn Aware' : 'Aware stage'
  const sampleWhy1 = isVietnamese
    ? 'Đây là mức trưởng thành khởi đầu, nền tảng theo dõi cơ bản.'
    : 'This is the starting maturity stage with basic monitoring foundations.'
  const sampleTitle2 = isVietnamese ? 'Giai đoạn Experimentation' : 'Experimentation stage'
  const sampleWhy2 = isVietnamese
    ? 'Bắt đầu thử nghiệm dashboard và drill-down để mở rộng phân tích.'
    : 'This stage pilots dashboards and drill-down to expand analysis.'
  const sampleTitle3 = isVietnamese ? 'Giai đoạn Organisation' : 'Organisation stage'
  const sampleWhy3 = isVietnamese
    ? 'Mở rộng từ dashboard đơn lẻ sang phối hợp nhiều nhóm trong tổ chức.'
    : 'Scales from isolated dashboards to multi-team organizational coordination.'
  const sampleTitle4 = isVietnamese ? 'Giai đoạn Organisational Transformation' : 'Organisational Transformation stage'
  const sampleWhy4 = isVietnamese
    ? 'Dữ liệu bắt đầu dẫn dắt chiến lược và cá nhân hóa ở cấp tổ chức.'
    : 'Data starts driving strategy and personalization at organization level.'
  const sampleTitle5 = isVietnamese ? 'Giai đoạn Sector Transformation' : 'Sector Transformation stage'
  const sampleWhy5 = isVietnamese
    ? 'Tác động mở rộng ra cấp ngành với chia sẻ dữ liệu và đổi mới hệ thống.'
    : 'Impact expands to sector level with data sharing and system innovation.'
  return `${question}\n\nYou are analyzing a learning analytics chart from the provided image.\n` +
    `First, answer the question normally in ${languageName}.\n` +
    `Then append an annotation JSON block in this exact format:\n` +
    `${VIZCHAT_ANNOTATION_TAG_START}\n` +
    `{"coordinateSystem":"chart-normalized","imageWidth":${sourceWidth || 0},"imageHeight":${sourceHeight || 0},"annotations":[{"type":"focus","x":0.03,"y":0.62,"w":0.2,"h":0.18,"title":"${sampleTitle1}","why":"${sampleWhy1}","color":"#16a34a"},{"type":"focus","x":0.17,"y":0.46,"w":0.22,"h":0.2,"title":"${sampleTitle2}","why":"${sampleWhy2}","color":"#f59e0b"},{"type":"focus","x":0.33,"y":0.34,"w":0.2,"h":0.24,"title":"${sampleTitle3}","why":"${sampleWhy3}","color":"#2563eb"},{"type":"focus","x":0.57,"y":0.22,"w":0.2,"h":0.2,"title":"${sampleTitle4}","why":"${sampleWhy4}","color":"#0ea5e9"},{"type":"focus","x":0.75,"y":0.12,"w":0.2,"h":0.2,"title":"${sampleTitle5}","why":"${sampleWhy5}","color":"#7c3aed"}]}\n` +
    `${VIZCHAT_ANNOTATION_TAG_END}\n` +
    `Rules: focus on the main chart area only. Use coordinateSystem as chart-normalized. All annotation coordinates must be normalized between 0 and 1 relative to the chart area, not full page. Use type=focus and return title + why only. Exactly 5 annotations are required and must cover the 5 major stage boxes from left to right. Each annotation must include x,y,w,h that tightly wraps one stage box so the circle can fully cover it. title and why MUST be written in ${languageName}. Keep why concise (max 12 words). Do not return chartBox unless explicitly requested.`
}
