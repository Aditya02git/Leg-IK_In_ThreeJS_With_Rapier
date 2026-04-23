import * as THREE from 'three'

/**
 * TerrainBuilder
 * Takes height data and creates:
 *   1. Three.js visual mesh (with normals + vertex colors)
 *   2. Rapier heightfield collider data
 */
export class TerrainBuilder {
  constructor({
    heights,       // Float32Array, row-major
    size,          // grid resolution (e.g. 101)
    worldSize = 200,   // total world size in meters
    heightScale = 14,  // max height in meters (matches Blender strength ~2.8 * 5)
    heightOffset = 0   // Y offset
  }) {
    this.heights = heights
    this.size = size         // 101 × 101
    this.cols = size - 1     // 100 cells
    this.worldSize = worldSize
    this.heightScale = heightScale
    this.heightOffset = heightOffset
    this.cellSize = worldSize / (size - 1)  // 2m per cell
  }

  /**
   * Get height at grid position (row, col)
   */
  getHeight(row, col) {
    row = Math.max(0, Math.min(this.size - 1, row))
    col = Math.max(0, Math.min(this.size - 1, col))
    return this.heights[row * this.size + col] * this.heightScale + this.heightOffset
  }

  /**
   * Get interpolated height at world position (x, z)
   */
  getHeightAtWorld(x, z) {
    // Convert world pos to grid coords
    const gx = (x + this.worldSize / 2) / this.cellSize
    const gz = (z + this.worldSize / 2) / this.cellSize

    const col0 = Math.floor(gx)
    const row0 = Math.floor(gz)
    const col1 = col0 + 1
    const row1 = row0 + 1

    const fx = gx - col0
    const fz = gz - row0

    const h00 = this.getHeight(row0, col0)
    const h10 = this.getHeight(row0, col1)
    const h01 = this.getHeight(row1, col0)
    const h11 = this.getHeight(row1, col1)

    // Bilinear interpolation
    return h00 * (1 - fx) * (1 - fz)
         + h10 * fx * (1 - fz)
         + h01 * (1 - fx) * fz
         + h11 * fx * fz
  }

  /**
   * Build Three.js BufferGeometry terrain mesh
   */
  buildMesh() {
    const { size, worldSize, cellSize } = this
    const vertCount = size * size
    const positions = new Float32Array(vertCount * 3)
    const normals = new Float32Array(vertCount * 3)
    const uvs = new Float32Array(vertCount * 2)
    const colors = new Float32Array(vertCount * 3)

    const half = worldSize / 2

    // Build vertices
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const i = row * size + col
        const x = col * cellSize - half
        const z = row * cellSize - half
        const y = this.getHeight(row, col)

        positions[i * 3 + 0] = x
        positions[i * 3 + 1] = y
        positions[i * 3 + 2] = z

        uvs[i * 2 + 0] = col / (size - 1)
        uvs[i * 2 + 1] = row / (size - 1)

        // Vertex coloring: low=dirt, mid=grass, high=snow
        const t = this.heights[i] // 0..1
        let r, g, b
        if (t < 0.3) {
          // Brown dirt
          const s = t / 0.3
          r = 0.35 + s * 0.15
          g = 0.22 + s * 0.18
          b = 0.10
        } else if (t < 0.65) {
          // Green grass
          const s = (t - 0.3) / 0.35
          r = 0.18 + s * 0.10
          g = 0.38 + s * 0.12
          b = 0.10
        } else if (t < 0.85) {
          // Rocky gray
          const s = (t - 0.65) / 0.2
          r = 0.42 + s * 0.28
          g = 0.38 + s * 0.25
          b = 0.30 + s * 0.25
        } else {
          // Snow white
          const s = (t - 0.85) / 0.15
          r = 0.70 + s * 0.30
          g = 0.70 + s * 0.30
          b = 0.75 + s * 0.25
        }
        colors[i * 3 + 0] = r
        colors[i * 3 + 1] = g
        colors[i * 3 + 2] = b
      }
    }

    // Build indices
    const cellCount = (size - 1) * (size - 1)
    const indices = new Uint32Array(cellCount * 6)
    let idx = 0
    for (let row = 0; row < size - 1; row++) {
      for (let col = 0; col < size - 1; col++) {
        const tl = row * size + col
        const tr = tl + 1
        const bl = (row + 1) * size + col
        const br = bl + 1

        // Triangle 1
        indices[idx++] = tl
        indices[idx++] = bl
        indices[idx++] = tr
        // Triangle 2
        indices[idx++] = tr
        indices[idx++] = bl
        indices[idx++] = br
      }
    }

    // Compute normals
    // First zero out
    for (let i = 0; i < normals.length; i++) normals[i] = 0

    const _v0 = new THREE.Vector3()
    const _v1 = new THREE.Vector3()
    const _v2 = new THREE.Vector3()
    const _edge1 = new THREE.Vector3()
    const _edge2 = new THREE.Vector3()
    const _normal = new THREE.Vector3()

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i+1], c = indices[i+2]

      _v0.fromArray(positions, a * 3)
      _v1.fromArray(positions, b * 3)
      _v2.fromArray(positions, c * 3)

      _edge1.subVectors(_v1, _v0)
      _edge2.subVectors(_v2, _v0)
      _normal.crossVectors(_edge1, _edge2).normalize()

      for (const vi of [a, b, c]) {
        normals[vi * 3 + 0] += _normal.x
        normals[vi * 3 + 1] += _normal.y
        normals[vi * 3 + 2] += _normal.z
      }
    }

    // Normalize
    for (let i = 0; i < vertCount; i++) {
      _normal.set(normals[i*3], normals[i*3+1], normals[i*3+2]).normalize()
      normals[i*3] = _normal.x
      normals[i*3+1] = _normal.y
      normals[i*3+2] = _normal.z
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.name = 'terrain'

    return mesh
  }

  /**
   * Build Rapier heightfield collider descriptor
   * Rapier expects heights in a specific order:
   *   nrows × ncols Float32Array
   *   nrows = size-1, ncols = size-1... 
   *   Actually Rapier HeightField: (nrows, ncols, heights, scale)
   *   heights.length = (nrows+1)*(ncols+1)
   */
  buildRapierHeightfield(RAPIER) {
    const { size, worldSize, heightScale } = this

    // Rapier heightfield: rows × cols, heights length = (rows+1)*(cols+1)
    // We have a size×size grid so rows = size-1, cols = size-1
    const nrows = size - 1  // 100
    const ncols = size - 1  // 100

    // The scale vector: x=totalWidth, y=maxHeight, z=totalDepth
    const scale = { x: worldSize, y: heightScale, z: worldSize }

    // Heights must be in row-major Float32Array
    // Values are normalized 0..1 (Rapier scales by scale.y)
    // Rapier HeightField layout: column-major!
    // heights[i + j*(nrows+1)] = height at row i, col j
    const rapierHeights = new Float32Array((nrows + 1) * (ncols + 1))

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        // Column-major for Rapier
        rapierHeights[col * size + row] = this.heights[row * size + col]
      }
    }

    return { nrows, ncols, heights: rapierHeights, scale }
  }
}