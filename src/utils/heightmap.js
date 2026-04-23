/**
 * HeightmapLoader
 * Loads a grayscale PNG heightmap and returns:
 *   - Float32Array of heights (row-major)
 *   - width/height of the grid
 *   - min/max height values
 */
export async function loadHeightmap(url, targetSize = 101) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = targetSize
      canvas.height = targetSize
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, targetSize, targetSize)
      const imageData = ctx.getImageData(0, 0, targetSize, targetSize)
      const pixels = imageData.data

      const heights = new Float32Array(targetSize * targetSize)
      let minH = Infinity, maxH = -Infinity

      for (let i = 0; i < targetSize * targetSize; i++) {
        // Use red channel (grayscale: R=G=B)
        const brightness = pixels[i * 4] / 255.0
        heights[i] = brightness
        if (brightness < minH) minH = brightness
        if (brightness > maxH) maxH = brightness
      }

      resolve({ heights, size: targetSize, minH, maxH })
    }
    img.onerror = reject
    img.src = url
  })
}

/**
 * Generates a procedural heightmap using cloud-like noise
 * This simulates what you'd get from Blender's Cloud displacement
 * Use this if you don't have a PNG yet!
 */
export function generateProceduralHeightmap(size = 101) {
  const heights = new Float32Array(size * size)

  // Simple multi-octave noise simulation
  function noise(x, y) {
    // Pseudo-random based on position
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
    return n - Math.floor(n)
  }

  function smoothNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y)
    const fx = x - ix, fy = y - iy
    // Smoothstep
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)

    const a = noise(ix, iy)
    const b = noise(ix + 1, iy)
    const c = noise(ix, iy + 1)
    const d = noise(ix + 1, iy + 1)

    return a + (b - a) * ux + (c - a) * uy + (d - a) * ux * uy + (b - a) * (1 - uy) * 0
  }

  function fractalNoise(x, y, octaves = 6) {
    let value = 0
    let amplitude = 1
    let frequency = 1
    let maxValue = 0

    for (let i = 0; i < octaves; i++) {
      value += smoothNoise(x * frequency, y * frequency) * amplitude
      maxValue += amplitude
      amplitude *= 0.5
      frequency *= 2.1
    }

    return value / maxValue
  }

  let minH = Infinity, maxH = -Infinity

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const nx = col / size * 4.0
      const ny = row / size * 4.0
      const h = fractalNoise(nx, ny)
      heights[row * size + col] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
    }
  }

  // Normalize to [0..1]
  const range = maxH - minH
  for (let i = 0; i < heights.length; i++) {
    heights[i] = (heights[i] - minH) / range
  }

  return { heights, size, minH: 0, maxH: 1 }
}