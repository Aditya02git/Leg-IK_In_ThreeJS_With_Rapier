import * as THREE from 'three'
import "./style.css"
import RAPIER from '@dimforge/rapier3d-compat'
import { generateProceduralHeightmap, loadHeightmap } from './utils/heightmap.js'
import { TerrainBuilder } from './utils/terrain.js'
import { FPSController } from './utils/controller.js'
import { GLTFLoader, HDRLoader, OrbitControls } from 'three/examples/jsm/Addons.js';

// ── UI helpers ───────────────────────────────────────────────────────────────
const loadingEl   = document.getElementById('loading')
const loadingBar  = document.getElementById('loading-bar')
const loadingText = document.getElementById('loading-status')
const posX        = document.getElementById('pos-x')
const posY        = document.getElementById('pos-y')
const posZ        = document.getElementById('pos-z')
const speedFill   = document.getElementById('speed-fill')

function setProgress(pct, msg) {
  loadingBar.style.width = pct + '%'
  loadingText.textContent = msg
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {

  // 1 ── Init Rapier WASM ────────────────────────────────────────────────────
  setProgress(10, 'LOADING RAPIER PHYSICS...')
  await RAPIER.init()

  // 2 ── Load heightmap ──────────────────────────────────────────────────────
  setProgress(25, 'LOADING HEIGHTMAP...')
  let heightData
  try {
    heightData = await loadHeightmap('/heightmap.png', 101)
    console.log('Loaded heightmap.png')
  } catch {
    console.log('No heightmap.png — using procedural terrain')
    heightData = generateProceduralHeightmap(101)
  }

  // 3 ── Build terrain data ──────────────────────────────────────────────────
  setProgress(40, 'BUILDING TERRAIN...')
  const terrainBuilder = new TerrainBuilder({
    heights:      heightData.heights,
    size:         heightData.size,
    worldSize:    100,
    heightScale:  7,
    heightOffset: 0,
  })

  // 4 ── Three.js renderer ───────────────────────────────────────────────────
  setProgress(55, 'INITIALIZING RENDERER...')
  const canvas   = document.getElementById('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled   = true
  renderer.shadowMap.type      = THREE.PCFSoftShadowMap
  renderer.toneMapping         = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.85
  renderer.setClearColor(0x87ceeb)

  const scene  = new THREE.Scene()
  scene.fog    = new THREE.Fog(0x87ceeb, 80, 220)
  scene.background = new THREE.Color(0x87ceeb)

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500)

  // 5 ── Lighting ────────────────────────────────────────────────────────────
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.1)
  scene.add(ambientLight)

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
  directionalLight.position.set(0, 10, 0)
  directionalLight.castShadow = true
  scene.add(directionalLight)

  const hdriLoader = new HDRLoader()
  hdriLoader.load('sky_06_2k.hdr', function (texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping
    scene.background = texture
    scene.environment = texture
  })

  // 6 ── Terrain mesh ────────────────────────────────────────────────────────
  const terrainMesh = terrainBuilder.buildMesh()
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  // 7 ── Rapier physics world ────────────────────────────────────────────────
  setProgress(65, 'BUILDING PHYSICS WORLD...')
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 })

  const { nrows, ncols, heights, scale } = terrainBuilder.buildRapierHeightfield(RAPIER)
  const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc
      .heightfield(nrows, ncols, heights, new RAPIER.Vector3(scale.x, scale.y, scale.z))
      .setFriction(0.9),
    terrainBody
  )

  // 8 ── FPS controller ──────────────────────────────────────────────────────
  setProgress(80, 'SPAWNING PLAYER...')
  const player = new FPSController({
    world,
    RAPIER,
    camera,
    scene,
    modelUrl: '/character.glb',
    terrainBuilder,
  })

// 9 ── LOAD MODEL'S WITH TRIMESH COLLIDER ──────────────────────────────────────────
const gltfLoader = new GLTFLoader()

gltfLoader.load('/Problem_1.glb', (gltf) => {
  const model = gltf.scene
  
  model.position.set(10, 3.8, 5)
  model.scale.set(1, 1, 1)
  model.traverse(child => {
    if (child.isMesh) child.castShadow = true
  })
  scene.add(model)

  // ── Build trimesh from all meshes in the GLB ─────────────────────────────
  const vertices = []
  const indices  = []
  let   indexOffset = 0

  model.updateWorldMatrix(true, true)   // ensure world transforms are baked

  model.traverse(child => {
    if (!child.isMesh) return

    const geo = child.geometry.clone()
    geo.applyMatrix4(child.matrixWorld)  // bake world transform into vertices

    const pos = geo.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i))
    }

    const idx = geo.getIndex()
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices.push(idx.getX(i) + indexOffset)
      }
    } else {
      // Non-indexed geometry — generate sequential indices
      for (let i = 0; i < pos.count; i++) {
        indices.push(i + indexOffset)
      }
    }

    indexOffset += pos.count
  })

  const vertexArray = new Float32Array(vertices)
  const indexArray  = new Uint32Array(indices)

  // Create a fixed rigid body at origin (world transform already baked in)
  const modelBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(vertexArray, indexArray).setFriction(0.7),
    modelBody
  )
})

gltfLoader.load('/Problem_2.glb', (gltf) => {
  const model = gltf.scene
  
  // Position/scale your model
  model.position.set(15, 3.8, 5)
  model.scale.set(1, 1, 1)
  model.traverse(child => {
    if (child.isMesh) child.castShadow = true
  })
  scene.add(model)

  // ── Build trimesh from all meshes in the GLB ─────────────────────────────
  const vertices = []
  const indices  = []
  let   indexOffset = 0

  model.updateWorldMatrix(true, true)   // ensure world transforms are baked

  model.traverse(child => {
    if (!child.isMesh) return

    const geo = child.geometry.clone()
    geo.applyMatrix4(child.matrixWorld)  // bake world transform into vertices

    const pos = geo.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i))
    }

    const idx = geo.getIndex()
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices.push(idx.getX(i) + indexOffset)
      }
    } else {
      // Non-indexed geometry — generate sequential indices
      for (let i = 0; i < pos.count; i++) {
        indices.push(i + indexOffset)
      }
    }

    indexOffset += pos.count
  })

  const vertexArray = new Float32Array(vertices)
  const indexArray  = new Uint32Array(indices)

  // Create a fixed rigid body at origin (world transform already baked in)
  const modelBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(vertexArray, indexArray).setFriction(0.7),
    modelBody
  )
})

  // ── Rapier debug renderer ─────────────────────────────────────────────────
  // Uses Rapier's built-in debug lines (world.debugRender()) rendered via
  // a Three.js LineSegments object. Toggle visibility with the 'P' key.
  const debugMaterial = new THREE.LineBasicMaterial({
    color: 0x00ff00,
    vertexColors: true,
  })
  const debugGeometry = new THREE.BufferGeometry()
  const debugLines    = new THREE.LineSegments(debugGeometry, debugMaterial)
  debugLines.visible  = false   // hidden by default — press P to toggle
  scene.add(debugLines)

  window.addEventListener('keydown', e => {
    if (e.code === 'KeyP') debugLines.visible = !debugLines.visible
  })

  function updateDebugRenderer() {
    if (!debugLines.visible) return   // skip work when hidden
    const { vertices, colors } = world.debugRender()
    debugGeometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    debugGeometry.setAttribute('color',    new THREE.BufferAttribute(colors,   4))
  }

  // Show the "Click to Enter" overlay
  const overlay = document.getElementById('click-to-play')
  if (overlay) overlay.style.display = 'flex'

  // 10 ── Done loading ───────────────────────────────────────────────────────
  setProgress(100, 'READY')
  await new Promise(r => setTimeout(r, 500))
  loadingEl.classList.add('hidden')

  // 11 ── Game loop ──────────────────────────────────────────────────────────
  const MAX_SPEED = player.MOVE_SPEED * player.SPRINT_MULT
  let prevTime = performance.now()

  function loop() {
    requestAnimationFrame(loop)

    const now = performance.now()
    const dt  = Math.min((now - prevTime) / 1000, 0.05)
    prevTime  = now

    world.step()
    const { position, speed } = player.update(dt)

    // Update Rapier debug wireframes (only when visible)
    updateDebugRenderer()

    // HUD
    posX.textContent = `X: ${position.x.toFixed(1)}`
    posY.textContent = `Y: ${position.y.toFixed(1)}`
    posZ.textContent = `Z: ${position.z.toFixed(1)}`
    speedFill.style.width = Math.min(100, (speed / MAX_SPEED) * 100) + '%'

    renderer.render(scene, camera)
  }

  loop()

  // 12 ── Handle window resize ───────────────────────────────────────────────
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })
}

main().catch(console.error)