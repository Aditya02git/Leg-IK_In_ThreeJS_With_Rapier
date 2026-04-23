import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { LegIK } from './legIK.js'

/**
 * TPS Character Controller
 * ─────────────────────────
 * Wraps a Rapier kinematic capsule + character controller.
 * Handles keyboard input, mouse look (camera orbit), jump, sprint, gravity.
 * Loads a GLB character model and drives Idle/Walk/Run/Jump/Fall animations, all downloaded from mixamo.
 *
 * Usage:
 *   const controller = new FPSController({ world, RAPIER, camera, scene, modelUrl, terrainBuilder })
 *   // in game loop:
 *   const { position, speed } = controller.update(dt)
 */
export class FPSController {
  constructor({ world, RAPIER, camera, scene, modelUrl, terrainBuilder }) {
    this.world          = world
    this.RAPIER         = RAPIER
    this.camera         = camera
    this.scene          = scene
    this.modelUrl       = modelUrl
    this.terrainBuilder = terrainBuilder

    // ── Input state ──────────────────────────────────────────────
    this.keys    = {}
    this.yaw     = 0
    this.pitch   = -0.25
    this.locked  = false

    // ── Physics state ────────────────────────────────────────────
    this.velY         = 0
    this.isGrounded   = false
    this.jumpCooldown = 0

    // ── Tuning ───────────────────────────────────────────────────
    this.MOVE_SPEED   = 2
    this.SPRINT_MULT  = 1.8
    this.JUMP_FORCE   = 9
    this.GRAVITY      = -25
    this.SENSITIVITY  = 0.002

    // ── TPS camera settings ──────────────────────────────────────
    this.CAM_DISTANCE = 5
    this.CAM_HEIGHT   = 1.8
    this.PITCH_MIN    = -0.6
    this.PITCH_MAX    =  1.0

    // ── Character model & animation ──────────────────────────────
    this.model       = null
    this.mixer       = null
    this.clips       = {}
    this.currentClip = null
    this.modelYaw    = 0
    this.modelLoaded = false
    this.legIK       = null

    // ── Temp vectors ─────────────────────────────────────────────
    this._fwd     = new THREE.Vector3()
    this._rgt     = new THREE.Vector3()
    this._mov     = new THREE.Vector3()
    this._camPos  = new THREE.Vector3()
    this._camLook = new THREE.Vector3()

    this._initPhysics()
    this._initInput()
    this._loadModel()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Physics
  // ─────────────────────────────────────────────────────────────────────────
  _initPhysics() {
    const { RAPIER, world } = this

    const rbDesc = RAPIER.RigidBodyDesc
      .kinematicPositionBased()
      .setTranslation(0, 30, 0)

    this.body = world.createRigidBody(rbDesc)

    // ── Main capsule: shifted UP so it covers torso only ─────────────────
    const capsuleDesc = RAPIER.ColliderDesc
      .capsule(0.35, 0.3)
      .setTranslation(0, 0.9, 0)
      .setFriction(0.0)
      .setRestitution(0.0)

    if (this.collisionGroup) {
      capsuleDesc.setCollisionGroups(this.collisionGroup)
    }
    this.collider = world.createCollider(capsuleDesc, this.body)

    // ── Foot ball: grounding probe, unchanged ─────────────────────────────
    const footDesc = RAPIER.ColliderDesc
      .ball(0.01)
      .setTranslation(0, 0.08, 0)
      .setFriction(0.8)
      .setRestitution(0.0)

    if (this.collisionGroup) {
      footDesc.setCollisionGroups(this.collisionGroup)
    }
    this.footCollider = world.createCollider(footDesc, this.body)

    this.controller = world.createCharacterController(0.05)
    this.controller.setSlideEnabled(true)
    this.controller.setMaxSlopeClimbAngle(50 * Math.PI / 180)
    this.controller.setMinSlopeSlideAngle(30 * Math.PI / 180)
    // Step height 0.5 is well above box height (0.2), minWidth 0.05 triggers
    // stepping sooner — together these let the character walk up onto the box
    this.controller.enableAutostep(0.1, 0.1, true)
    this.controller.enableSnapToGround(0.2)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model + Animations
  // ─────────────────────────────────────────────────────────────────────────
  _loadModel() {
    const loader = new GLTFLoader()
    loader.load(
      this.modelUrl,
      (gltf) => {
        this.model = gltf.scene

        this.model.position.set(0, 0.05, 0)
        this.model.scale.setScalar(1.0)

        this.model.traverse(child => {
          if (child.isMesh) {
            child.castShadow    = true
            child.receiveShadow = true
          }
        })

        this.pivot = new THREE.Group()
        this.pivot.add(this.model)
        this.scene.add(this.pivot)

        this.mixer = new THREE.AnimationMixer(this.model)

        // ── LegIK ────────────────────────────────────────────────────────
        this.legIK = new LegIK(
          this.model,
          this.terrainBuilder,
          {
            raycastHeight:               1.2,
            raycastLength:               3.5,
            feetPositionOffsetWeight:    1.0,
            feetRotationOffsetWeight:    1.0,
            feetPositionOffsetSmoothing: 0.08,
            feetRotationOffsetSmoothing: 0.1,
            bodyPositionOffsetWeight:    1.0,
            bodyPositionOffsetSmoothing: 0.12,
            invertBodyPositionOffset:    false,
          },
          this.world,
          this.RAPIER,
          this.collider,
          this.footCollider
        )

        this.clips = this._mapClips(gltf.animations)
        this._playClip('idle', 0)
        this.modelLoaded = true
      },
      undefined,
      (err) => console.error('GLB load error:', err)
    )
  }

  _mapClips(animations) {
    const map = {}
    const aliases = {
      idle: ['Idle'],
      walk: ['Walk'],
      run:  ['Sprint'],
      jump: ['Jump'],
      fall: ['Fall'],
    }

    for (const [slot, names] of Object.entries(aliases)) {
      for (const name of names) {
        const clip = THREE.AnimationClip.findByName(animations, name)
        if (clip) { map[slot] = clip; break }
      }
    }

    const slots = ['idle', 'walk', 'run', 'jump', 'fall']
    animations.forEach((clip, i) => {
      if (i < slots.length && !map[slots[i]]) map[slots[i]] = clip
    })

    console.log('Animation map:', Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, v?.name ?? 'NOT FOUND'])
    ))
    return map
  }

  _playClip(name, fadeTime = 0.2) {
    if (!this.mixer || !this.clips[name]) return
    if (this.currentClip === name) return

    const clip   = this.clips[name]
    const action = this.mixer.clipAction(clip)

    if (name === 'jump' || name === 'fall') {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity)
    }

    if (this.currentClip && this.clips[this.currentClip]) {
      this.mixer.clipAction(this.clips[this.currentClip]).fadeOut(fadeTime)
    }

    action.reset().fadeIn(fadeTime).play()
    this.currentClip = name
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Input
  // ─────────────────────────────────────────────────────────────────────────
  _initInput() {
    window.addEventListener('keydown', e => {
      this.keys[e.code] = true
      if (e.code === 'Space') e.preventDefault()
    })
    window.addEventListener('keyup', e => {
      this.keys[e.code] = false
    })

    window.addEventListener('mousemove', e => {
      if (!this.locked) return
      this.yaw   -= e.movementX * this.SENSITIVITY
      this.pitch -= e.movementY * this.SENSITIVITY
      this.pitch  = Math.max(this.PITCH_MIN, Math.min(this.PITCH_MAX, this.pitch))
    })

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === document.body
      const overlay = document.getElementById('click-to-play')
      if (overlay) overlay.style.display = this.locked ? 'none' : 'flex'
    })

    const overlay = document.getElementById('click-to-play')
    if (overlay) {
      overlay.addEventListener('click', () => document.body.requestPointerLock())
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Update (call every frame)
  // ─────────────────────────────────────────────────────────────────────────
update(dt) {
    // ── Cooldowns ─────────────────────────────────────────────────────────
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt

    // ── Horizontal movement ───────────────────────────────────────────────
    const sprint = this.keys['ShiftLeft'] || this.keys['ShiftRight']
    const speed  = this.MOVE_SPEED * (sprint ? this.SPRINT_MULT : 1.0)

    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    this._rgt.set( Math.cos(this.yaw), 0, -Math.sin(this.yaw))

    this._mov.set(0, 0, 0)
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    this._mov.addScaledVector(this._fwd, -1)
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  this._mov.addScaledVector(this._fwd,  1)
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  this._mov.addScaledVector(this._rgt,  1)
    if (this.keys['KeyD'] || this.keys['ArrowRight']) this._mov.addScaledVector(this._rgt, -1)

    const isMoving = this._mov.lengthSq() > 0.001
    if (isMoving) this._mov.normalize().multiplyScalar(speed)

    // ── Vertical velocity ─────────────────────────────────────────────────
    this.velY += this.GRAVITY * dt
    if (this.isGrounded && this.velY < 0) this.velY = -2

    const justJumped = this.keys['Space'] && this.isGrounded && this.jumpCooldown <= 0
    if (justJumped) {
      this.velY         = this.JUMP_FORCE
      this.jumpCooldown = 0.4
    }

    // ── Rapier movement ───────────────────────────────────────────────────
    const cur = this.body.translation()

    // ── Manual step-up ────────────────────────────────────────────────────
    // Cast a ray ahead of movement direction. If a surface is detected
    // between 0.02 and 0.4 units above current Y, inject upward displacement
    // directly — bypasses autostep entirely.
    let stepUpY = 0
    if (this.isGrounded && isMoving && !justJumped) {
      const norm   = this._mov.clone().normalize()
      const probeX = cur.x + norm.x * 0.2
      const probeZ = cur.z + norm.z * 0.2

      const stepRay = new this.RAPIER.Ray(
        { x: probeX, y: cur.y + 0.5, z: probeZ },
        { x: 0, y: -1, z: 0 }
      )

      const stepHit = this.world.castRay(
        stepRay,
        1.0,
        true,
        null,
        null,
        this.collider
      )

      if (stepHit) {
        const hitY       = (cur.y + 0.5) - stepHit.timeOfImpact
        const stepHeight = hitY - cur.y
        if (stepHeight > 0.02 && stepHeight < 0.4) {
          stepUpY = stepHeight
        }
      }
    }

    const desired = {
      x: this._mov.x * dt,
      y: stepUpY > 0 ? stepUpY : this.velY * dt,
      z: this._mov.z * dt,
    }

    this.controller.computeColliderMovement(this.footCollider, desired)
    const corrected  = this.controller.computedMovement()
    this.isGrounded  = this.controller.computedGrounded()

    this.body.setNextKinematicTranslation({
      x: cur.x + corrected.x,
      y: cur.y + corrected.y,
      z: cur.z + corrected.z,
    })

    // ── Sync model pivot to physics body ──────────────────────────────────
    const pos = this.body.translation()
    if (this.modelLoaded) {
      this.pivot.position.set(pos.x, pos.y, pos.z)

      if (isMoving) {
        const targetYaw = Math.atan2(this._mov.x, this._mov.z)
        let diff = targetYaw - this.modelYaw
        while (diff >  Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        this.modelYaw += diff * Math.min(1, 10 * dt)
        this.pivot.rotation.y = this.modelYaw
      }
    }

    // ── TPS camera ────────────────────────────────────────────────────────
    this._camPos.set(pos.x, pos.y + this.CAM_HEIGHT, pos.z).add(
      new THREE.Vector3(
        -Math.sin(this.yaw) * Math.cos(this.pitch) * this.CAM_DISTANCE,
         Math.sin(this.pitch) * this.CAM_DISTANCE,
        -Math.cos(this.yaw) * Math.cos(this.pitch) * this.CAM_DISTANCE
      )
    )
    this.camera.position.copy(this._camPos)
    this._camLook.set(pos.x, pos.y + this.CAM_HEIGHT, pos.z)
    this.camera.lookAt(this._camLook)

// In your update(), replace the animation state machine block:

// ── Animation state machine ───────────────────────────────────────────
if (this.mixer) {
  this.mixer.update(dt)

  // Set jump flag immediately on jump, clear only when grounded again
  if (justJumped) {
    this._isJumping = true
  }
  if (this.isGrounded && this.velY <= 0) {
    this._isJumping = false
  }

  // Grace period only for fall (prevents flicker on ledge walk-off)
  if (this.isGrounded) {
    this._groundedGrace = 0.15
  } else {
    this._groundedGrace = (this._groundedGrace ?? 0) - dt
  }

  const effectivelyGrounded = this.isGrounded || this._groundedGrace > 0

  if (this._isJumping) {
    this._playClip(this.velY > 0 ? 'jump' : 'fall')
  } else if (!effectivelyGrounded) {
    this._playClip('fall')
  } else if (isMoving) {
    this._playClip(sprint ? 'run' : 'walk')
  } else {
    this._playClip('idle')
  }
}

    // ── Leg IK ────────────────────────────────────────────────────────────
    if (this.legIK && this.modelLoaded) {
      this.legIK.isGrounded = this.isGrounded
      this.legIK.isMoving   = isMoving
      this.legIK.jumped     = !this.isGrounded && this.velY > 0
      this.legIK.isActive   = this.isGrounded && !sprint
      this.legIK.update(dt, new THREE.Vector3(pos.x, pos.y, pos.z))
    }

    return {
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      speed:    this._mov.length(),
      grounded: this.isGrounded,
    }
  }

  setPosition(x, y, z) {
    this.body.setNextKinematicTranslation({ x, y, z })
    this.velY = 0
  }

  getPosition() {
    return this.body.translation()
  }
}