import * as THREE from "three";

export class LegIK {
  constructor(
    model,
    terrainBuilder,
    options = {},
    world = null,
    RAPIER = null,
    collider = null,
  ) {
    this.model = model;
    this.terrain = terrainBuilder;
    this.world = world;
    this.RAPIER = RAPIER; 
    this.collider = collider;

    this.raycastHeight = options.raycastHeight ?? 1.2;
    this.raycastLength = options.raycastLength ?? 2.5;
    this.feetPositionOffsetWeight = options.feetPositionOffsetWeight ?? 1.0;
    this.feetRotationOffsetWeight = options.feetRotationOffsetWeight ?? 1.0;
    this.feetPositionOffsetSmoothing =
      options.feetPositionOffsetSmoothing ?? 0.08;
    this.feetRotationOffsetSmoothing =
      options.feetRotationOffsetSmoothing ?? 0.1;
    this.bodyPositionOffsetWeight = options.bodyPositionOffsetWeight ?? 1.0;
    this.bodyPositionOffsetSmoothing =
      options.bodyPositionOffsetSmoothing ?? 0.12;
    this.invertBodyPositionOffset = options.invertBodyPositionOffset ?? false;

    this.isGrounded = true;
    this.isMoving = false;
    this.jumped = false;
    this.isActive = true;

    // Speed-based IK suppression
    this.speed = 0;
    this.ikRunSuppressSpeed = options.ikRunSuppressSpeed ?? 3.5;
    this.ikWalkEngageSpeed = options.ikWalkEngageSpeed ?? 1.5;
    this._globalIKBlend = 1.0;
    this._globalIKBlendSmoothing = options.globalIKBlendSmoothing ?? 0.12;

    this.boneNames = options.boneNames ?? {
      hips: ["mixamorigHips", "Hips", "pelvis"],
      leftThigh: [
        "mixamorigLeftUpLeg",
        "LeftUpLeg",
        "Left_UpperLeg",
        "LeftThigh",
      ],
      leftKnee: ["mixamorigLeftLeg", "LeftLeg", "Left_LowerLeg", "LeftKnee"],
      leftFoot: ["mixamorigLeftFoot", "LeftFoot", "Left_Foot"],
      rightThigh: [
        "mixamorigRightUpLeg",
        "RightUpLeg",
        "Right_UpperLeg",
        "RightThigh",
      ],
      rightKnee: [
        "mixamorigRightLeg",
        "RightLeg",
        "Right_LowerLeg",
        "RightKnee",
      ],
      rightFoot: ["mixamorigRightFoot", "RightFoot", "Right_Foot"],
    };

    this.bones = {};
    this._resolveBones();

    this.feet = {
      left: this._makeFoot(),
      right: this._makeFoot(),
    };

    this._bodyPositionOffset = 0;
    this._rootPosition = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);

    this._animSnapshot = {
      left: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
      right: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _makeFoot
  // Creates and returns the default state object for one foot.
  // Holds the smoothed position offset, rotation offset, raycast hit info,
  // and the world-space origin the ray was fired from.
  // ─────────────────────────────────────────────────────────────────────────────

  _makeFoot() {
    return {
      positionOffset: 0,
      rotationOffset: new THREE.Quaternion(),
      raycastHit: false,
      raycastHitPoint: new THREE.Vector3(),
      raycastHitNormal: new THREE.Vector3(0, 1, 0),
      raycastOrigin: new THREE.Vector3(),
      _rapierNormal: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _resolveBones
  // Walks the model's scene graph and maps each logical bone slot (hips, thigh,
  // knee, foot — left and right) to the actual Three.js bone object.
  // Tries multiple name candidates per slot to handle different skeleton rigs.
  // Warns in the console if a bone cannot be found.
  // ─────────────────────────────────────────────────────────────────────────────

  _resolveBones() {
    const nameMap = {};
    this.model.traverse((o) => {
      nameMap[o.name] = o;
    });
    for (const [slot, candidates] of Object.entries(this.boneNames)) {
      for (const name of candidates) {
        if (nameMap[name]) {
          this.bones[slot] = nameMap[name];
          break;
        }
      }
      if (!this.bones[slot]) {
        console.warn(
          `LegIK: bone not found for "${slot}". Tried: ${candidates.join(", ")}`,
        );
      }
    }
    // Add temporarily at end of _resolveBones():
    // console.log('Resolved bones:', Object.fromEntries(
    //   Object.entries(this.bones).map(([k,v]) => [k, v?.name ?? 'NOT FOUND'])
    // ))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // update:
  // Main entry point for the IK system. Runs the full pipeline in order:
  //   1. Fades the global IK blend in/out based on movement speed.
  //   2. Snapshots the animated foot poses before any IK runs.
  //   3. Fires raycasts to find actual ground height under each foot.
  //   4. Computes and smooths per-foot position/rotation offsets, then applies
  //      Two-Bone IK to thigh + knee + foot bones.
  //   5. Shifts the hips down so the body crouches naturally on uneven terrain.
  // Does nothing when isActive is false or the global blend is fully suppressed.
  // ─────────────────────────────────────────────────────────────────────────────

  update(dt, rootWorldPosition) {
    if (!this.isActive) return;

    if (rootWorldPosition) {
      this._rootPosition.copy(rootWorldPosition);
    } else {
      this.model.parent?.getWorldPosition(this._rootPosition) ??
        this.model.getWorldPosition(this._rootPosition);
    }

    // ── Master IK blend: fade out as speed increases ─────────────────────────
    const targetGlobalBlend = THREE.MathUtils.clamp(
      1 -
        (this.speed - this.ikWalkEngageSpeed) /
          (this.ikRunSuppressSpeed - this.ikWalkEngageSpeed),
      0,
      1,
    );
    this._globalIKBlend = THREE.MathUtils.lerp(
      this._globalIKBlend,
      targetGlobalBlend,
      Math.min(1, dt / this._globalIKBlendSmoothing),
    );

    // Skip all IK work when fully suppressed — let animation run free
    if (this._globalIKBlend <= 0.01) return;

    this.model.updateWorldMatrix(true, true);
    this._snapshotAnimatedPoses();
    this._getRaycastData();
    const lowestHitY = this._offsetTargets(dt);
    this._offsetBodyPosition(dt, lowestHitY);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _snapshotAnimatedPoses
  // Records the current world-space position and rotation of each foot bone
  // BEFORE any IK modification is applied this frame.
  // These snapshots are the baseline the IK offsets are calculated against,
  // so we never drift away from the animator's intended pose.
  // ─────────────────────────────────────────────────────────────────────────────

  _snapshotAnimatedPoses() {
    for (const side of ["left", "right"]) {
      const footBone = this.bones[side === "left" ? "leftFoot" : "rightFoot"];
      if (!footBone) continue;
      footBone.getWorldPosition(this._animSnapshot[side].pos);
      footBone.getWorldQuaternion(this._animSnapshot[side].quat);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _getRaycastData
  // Decides whether raycasting should run this frame, then fires rays for both
  // feet. Skips raycasting (and zeros both feet) when the character has jumped,
  // is airborne, or the global IK blend is fully suppressed — situations where
  // foot placement IK should have no effect.
  // ─────────────────────────────────────────────────────────────────────────────

  _getRaycastData() {
    if (this.jumped || !this.isGrounded || this._globalIKBlend <= 0.01) {
      this._zeroFoot(this.feet.left);
      this._zeroFoot(this.feet.right);
      return;
    }
    this._sampleFootRaycast("left", this.feet.left);
    this._sampleFootRaycast("right", this.feet.right);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _zeroFoot
  // Resets a foot's raycast state to "no hit" so IK has nothing to correct.
  // Called when the character is airborne, jumping, or IK is suppressed.
  // ─────────────────────────────────────────────────────────────────────────────

  _zeroFoot(foot) {
    foot.raycastHit = false;
    foot.raycastHitPoint.set(0, 0, 0);
    foot.raycastHitNormal.set(0, 1, 0);
    foot.raycastOrigin.set(0, 0, 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _sampleFootRaycast
  // Determines the actual ground height directly below one foot using two layers:
  //   Layer 1 — Terrain math: fast array lookup + bilinear interpolation.
  //             Always runs first.
  //   Layer 2 — Rapier physics ray: detects boxes, ramps, or any other physics
  //             collider sitting above the terrain. Only wins if its hit is
  //             higher than the terrain height and below the ray origin.
  // The character's own capsule collider is excluded from the Rapier cast so
  // the ray cannot accidentally hit the character's own body.
  // Writes the result into the foot's raycastHit / raycastHitPoint fields.
  // ─────────────────────────────────────────────────────────────────────────────

  _sampleFootRaycast(side, foot) {
    const footBone = this.bones[side === "left" ? "leftFoot" : "rightFoot"];
    if (!footBone) {
      this._zeroFoot(foot);
      return;
    }

    const snap = this._animSnapshot[side];
    const originX = snap.pos.x;
    const originZ = snap.pos.z;
    const originY = this._rootPosition.y + this.raycastHeight;

    foot.raycastOrigin.set(originX, originY, originZ);

    // ── Layer 1: Terrain height (fast math, no physics cost) ─────────────────
    let groundY = this.terrain.getHeightAtWorld(originX, originZ);
    foot._rapierNormal = null;

    // ── Layer 2: Rapier ray — detects physics objects above the terrain ───────
    if (this.world && this.RAPIER) {
      const ray = new this.RAPIER.Ray(
        { x: originX, y: originY, z: originZ },
        { x: 0, y: -1, z: 0 },
      );

      const hit = this.world.castRayAndGetNormal(
        ray,
        this.raycastLength,
        true,           // solid
        null,           // filterFlags (null = default)
        null,           // filterGroups (null = all groups)
        this.collider,  // ← exclude the character's own capsule collider
      );

      if (hit) {
        const hitY = originY - hit.timeOfImpact;
        if (hitY < originY && hitY >= groundY) {
          groundY = hitY;
          foot._rapierNormal = new THREE.Vector3(
            hit.normal.x,
            hit.normal.y,
            hit.normal.z,
          );
        }
      }
    }

    // ── Validation: discard hits that are above the ray origin or too far ─────
    if (groundY > originY) {
      this._zeroFoot(foot);
      return;
    }
    if (originY - groundY > this.raycastLength) {
      this._zeroFoot(foot);
      return;
    }

    foot.raycastHit = true;
    foot.raycastHitPoint.set(originX, groundY, originZ);
    foot.raycastHitNormal.copy(
      foot._rapierNormal ?? this._sampleNormal(originX, originZ),
    );
    foot._rapierNormal = null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _offsetTargets
  // Drives the per-foot IK for both feet and returns the lowest ground Y hit
  // this frame. The lowest hit is passed to _offsetBodyPosition so the hips
  // know how far to crouch.
  // ─────────────────────────────────────────────────────────────────────────────

  _offsetTargets(dt) {
    let lowestHitY = this._rootPosition.y;
    this._offsetOneFoot(dt, "left", this.feet.left, (y) => {
      if (y < lowestHitY) lowestHitY = y;
    });
    this._offsetOneFoot(dt, "right", this.feet.right, (y) => {
      if (y < lowestHitY) lowestHitY = y;
    });
    return lowestHitY;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _offsetOneFoot
  // Full IK pipeline for a single foot. Runs in this order:
  //   1. Computes how far the animated foot sits above or below the ground hit.
  //   2. Smoothly lerps the stored position offset toward that target (prevents
  //      snapping). Applies a minimum skin offset so the foot can't clip through.
  //   3. Calculates a per-foot IK blend: tiny corrections are ignored entirely
  //      to avoid IK fighting the animation on nearly-flat ground.
  //   4. Smoothly slerps the foot's rotation offset toward the terrain normal.
  //   5. Builds the final IK target position and rotation, then calls
  //      _applyTwoBoneIK to rotate thigh + knee + foot bones.
  //   6. Calls _postIKClamp as a final safety net against floor penetration.
  // ─────────────────────────────────────────────────────────────────────────────

  _offsetOneFoot(dt, side, foot, trackLowest) {
    const thighBone = this.bones[side === "left" ? "leftThigh" : "rightThigh"];
    const kneeBone = this.bones[side === "left" ? "leftKnee" : "rightKnee"];
    const footBone = this.bones[side === "left" ? "leftFoot" : "rightFoot"];
    if (!footBone || !kneeBone || !thighBone) return;

    const animatedFootPos = this._animSnapshot[side].pos.clone();
    const animatedFootQuat = this._animSnapshot[side].quat.clone();

    let footPositionOffsetTarget = 0;

    if (
      foot.raycastHit &&
      this.isGrounded &&
      this.feetPositionOffsetWeight > 0
    ) {
      trackLowest(foot.raycastHitPoint.y);

      const footAboveGround = animatedFootPos.y - foot.raycastHitPoint.y;
      footPositionOffsetTarget = -footAboveGround;

      if (this.feetPositionOffsetWeight !== 1) {
        footPositionOffsetTarget *= this.feetPositionOffsetWeight;
      }
    }

    if (this.feetPositionOffsetSmoothing > 0) {
      foot.positionOffset = THREE.MathUtils.lerp(
        foot.positionOffset,
        footPositionOffsetTarget,
        Math.min(1, dt / this.feetPositionOffsetSmoothing),
      );
    } else {
      foot.positionOffset = footPositionOffsetTarget;
    }

    if (foot.raycastHit) {
      // + 0.04 skin offset ensures foot sits ON surface, not clipping through
      const minOffset = foot.raycastHitPoint.y - animatedFootPos.y + 0.08;
      foot.positionOffset = Math.max(foot.positionOffset, minOffset);
    }

    const IK_BLEND_MAX_OFFSET = 0.05;
    const IK_BLEND_MIN_OFFSET = 0.005;
    const absOffset = Math.abs(foot.positionOffset);
    const perFootBlend = foot.raycastHit
      ? THREE.MathUtils.clamp(
          (absOffset - IK_BLEND_MIN_OFFSET) /
            (IK_BLEND_MAX_OFFSET - IK_BLEND_MIN_OFFSET),
          0,
          1,
        )
      : 0;

    const ikBlend = perFootBlend * this._globalIKBlend;

    let targetRotOffset = new THREE.Quaternion();
    if (foot.raycastHit && this.feetRotationOffsetWeight > 0) {
      targetRotOffset.setFromUnitVectors(this._up, foot.raycastHitNormal);
      if (this.feetRotationOffsetWeight !== 1) {
        targetRotOffset.slerp(
          new THREE.Quaternion(),
          1 - this.feetRotationOffsetWeight,
        );
      }
    }

    if (this.feetRotationOffsetSmoothing > 0) {
      foot.rotationOffset.slerp(
        targetRotOffset,
        Math.min(1, dt / this.feetRotationOffsetSmoothing),
      );
    } else {
      foot.rotationOffset.copy(targetRotOffset);
    }

    const ikTargetPos = animatedFootPos.clone();
    ikTargetPos.y += foot.positionOffset;

    if (foot.raycastHit) {
      const terrainY = this.terrain.getHeightAtWorld(
        ikTargetPos.x,
        ikTargetPos.z,
      );
      ikTargetPos.y = Math.max(ikTargetPos.y, terrainY);
    }

    const ikTargetQuat = foot.rotationOffset.clone().multiply(animatedFootQuat);

    this._applyTwoBoneIK(side, ikTargetPos, ikTargetQuat, ikBlend);

    this._postIKClamp(side, foot);

    // console.log(
    //   side,
    //   'animY:', animatedFootPos.y.toFixed(3),
    //   'hitY:', foot.raycastHit ? foot.raycastHitPoint.y.toFixed(3) : 'NO HIT',
    //   'offset:', foot.positionOffset.toFixed(3),
    //   'ikBlend:', ikBlend.toFixed(3)
    // )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _postIKClamp
  // Safety net that runs after Two-Bone IK has been applied.
  // Re-reads the foot bone's actual world position and, if it ended up below
  // the ground hit point (plus a small skin thickness), pushes it back up along
  // the parent bone's local Y axis. Prevents edge cases where the IK math leaves
  // the foot clipping through the floor.
  // ─────────────────────────────────────────────────────────────────────────────

  _postIKClamp(side, foot) {
    if (!foot.raycastHit) return;
    const footBone = this.bones[side === "left" ? "leftFoot" : "rightFoot"];
    if (!footBone) return;

    this.model.updateWorldMatrix(true, true);

    const fp = new THREE.Vector3();
    footBone.getWorldPosition(fp);

    const floorY = foot.raycastHitPoint.y;

    // Add a small skin thickness so the foot sits ON the surface, not at it
    const targetY = floorY + 0.02; // ← tweak this (0.02–0.05)

    if (fp.y >= targetY) return; // already above floor, nothing to do

    const penetration = targetY - fp.y;

    if (!footBone.parent) {
      footBone.position.y += penetration;
      return;
    }

    const parentQuat = new THREE.Quaternion();
    footBone.parent.getWorldQuaternion(parentQuat);
    const localUp = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(parentQuat.clone().invert())
      .normalize();

    footBone.position.addScaledVector(localUp, penetration);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _offsetBodyPosition
  // Moves the hips bone up or down so the whole body responds naturally to
  // uneven terrain — crouching when the ground drops, rising when it rises.
  // Computes a target offset from the average foot-to-ground delta, smoothly
  // lerps toward it, then converts the world-space offset to the hip bone's
  // local space (accounting for any parent scale or rotation). Only lowers the
  // hips, never raises them above the animated pose (offset is clamped to <= 0).
  // ─────────────────────────────────────────────────────────────────────────────

  _offsetBodyPosition(dt, lowestHitY) {
    const hipBone = this.bones.hips;
    if (!hipBone || this.bodyPositionOffsetWeight <= 0) return;

    let bodyOffsetTarget = 0;

    if (this.isGrounded) {
      const leftHit = this.feet.left.raycastHit;
      const rightHit = this.feet.right.raycastHit;

      if (leftHit || rightHit) {
        const leftDelta = leftHit
          ? this.feet.left.raycastHitPoint.y - this._animSnapshot.left.pos.y
          : 0;
        const rightDelta = rightHit
          ? this.feet.right.raycastHitPoint.y - this._animSnapshot.right.pos.y
          : 0;

        if (leftHit && rightHit) {
          bodyOffsetTarget = (leftDelta + rightDelta) / 2;
        } else if (leftHit) {
          bodyOffsetTarget = leftDelta;
        } else {
          bodyOffsetTarget = rightDelta;
        }

        bodyOffsetTarget = Math.min(bodyOffsetTarget, 0);
      }

      if (this.invertBodyPositionOffset) bodyOffsetTarget *= -1;
    }

    if (this.bodyPositionOffsetSmoothing > 0) {
      this._bodyPositionOffset = THREE.MathUtils.lerp(
        this._bodyPositionOffset,
        bodyOffsetTarget,
        Math.min(1, dt / this.bodyPositionOffsetSmoothing),
      );
    } else {
      this._bodyPositionOffset = bodyOffsetTarget;
    }

    if (Math.abs(this._bodyPositionOffset) > 0.001) {
      const hipWorldPos1 = new THREE.Vector3();
      hipBone.getWorldPosition(hipWorldPos1);

      const testAmount = 0.1;
      hipBone.position.y += testAmount;
      this.model.updateWorldMatrix(true, true);
      const hipWorldPos2 = new THREE.Vector3();
      hipBone.getWorldPosition(hipWorldPos2);

      hipBone.position.y -= testAmount;

      const worldPerLocal = (hipWorldPos2.y - hipWorldPos1.y) / testAmount;

      if (Math.abs(worldPerLocal) > 0.001) {
        const localAmount =
          (this._bodyPositionOffset *
            this.bodyPositionOffsetWeight *
            this._globalIKBlend) /
          worldPerLocal;
        hipBone.position.y += localAmount;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _applyTwoBoneIK
  // Core IK solver. Given a world-space target position and rotation for the
  // foot, rotates the thigh and knee bones so the foot reaches that target,
  // using the Law of Cosines to find the correct bend angles.
  //
  // Steps:
  //   1. Reads world positions of thigh (A), knee (B), and foot (C).
  //   2. Clamps the target distance to the total leg length so the leg never
  //      hyper-extends.
  //   3. Uses the Law of Cosines to compute the required thigh bend angle.
  //   4. Determines the bend axis from the current knee direction (pole hint),
  //      falling back to character forward/right if the hint is degenerate.
  //   5. Rotates the thigh bone, updates world matrices, then rotates the knee
  //      bone to point toward the clamped target.
  //   6. Sets the foot bone's world rotation directly to targetQuat (always at
  //      full weight so the foot stays flat on the ground surface).
  //   7. All thigh/knee corrections are scaled by `blend` so small corrections
  //      fade smoothly rather than snapping.
  // ─────────────────────────────────────────────────────────────────────────────


  _applyTwoBoneIK(side, targetPos, targetQuat, blend = 1.0) {
    const thighBone = this.bones[side === "left" ? "leftThigh" : "rightThigh"];
    const kneeBone = this.bones[side === "left" ? "leftKnee" : "rightKnee"];
    const footBone = this.bones[side === "left" ? "leftFoot" : "rightFoot"];
    if (!thighBone || !kneeBone || !footBone) return;

    // Early out — no correction needed, preserve animation fully
    if (blend <= 0) return;

    const pA = new THREE.Vector3();
    thighBone.getWorldPosition(pA);
    const pB = new THREE.Vector3();
    kneeBone.getWorldPosition(pB);
    const pC = new THREE.Vector3();
    footBone.getWorldPosition(pC);

    const lenUpper = pA.distanceTo(pB);
    const lenLower = pB.distanceTo(pC);
    const lenTotal = lenUpper + lenLower;

    const toTarget = new THREE.Vector3().subVectors(targetPos, pA);
    const targetDist = Math.min(toTarget.length(), lenTotal * 0.999);
    const targetDir = toTarget.clone().normalize();
    const clampedTarget = pA.clone().addScaledVector(targetDir, targetDist);

    const cosA = THREE.MathUtils.clamp(
      (lenUpper * lenUpper + targetDist * targetDist - lenLower * lenLower) /
        (2 * lenUpper * targetDist),
      -1,
      1,
    );
    const angleA = Math.acos(cosA);

    const pivotMatrix =
      this.model.parent?.matrixWorld ?? this.model.matrixWorld;
    const pivotQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().extractRotation(pivotMatrix),
    );
    const charFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(pivotQuat);
    const charRgt = new THREE.Vector3(1, 0, 0).applyQuaternion(pivotQuat);

    const poleHint = new THREE.Vector3();
    kneeBone.getWorldPosition(poleHint);
    const kneeHint = new THREE.Vector3().subVectors(poleHint, pA).normalize();

    let bendAxis = new THREE.Vector3().crossVectors(targetDir, kneeHint);
    if (bendAxis.lengthSq() < 0.0001) bendAxis.crossVectors(targetDir, charFwd);
    if (bendAxis.lengthSq() < 0.0001) bendAxis.copy(charRgt);
    bendAxis.normalize();

    // ── Thigh: blend delta toward identity when correction is small ──────────
    const desiredThighDir = targetDir.clone().applyAxisAngle(bendAxis, angleA);
    const currentThighDir = new THREE.Vector3().subVectors(pB, pA).normalize();
    const thighDelta = new THREE.Quaternion().setFromUnitVectors(
      currentThighDir,
      desiredThighDir,
    );

    const blendedThighDelta = new THREE.Quaternion().slerp(thighDelta, blend);
    this._applyWorldDeltaToLocal(thighBone, blendedThighDelta);

    this.model.updateWorldMatrix(true, true);
    kneeBone.getWorldPosition(pB);
    footBone.getWorldPosition(pC);

    // ── Knee: same blend treatment ───────────────────────────────────────────
    const currentKneeDir = new THREE.Vector3().subVectors(pC, pB).normalize();
    const desiredKneeDir = new THREE.Vector3()
      .subVectors(clampedTarget, pB)
      .normalize();
    const kneeDelta = new THREE.Quaternion().setFromUnitVectors(
      currentKneeDir,
      desiredKneeDir,
    );

    const blendedKneeDelta = new THREE.Quaternion().slerp(kneeDelta, blend);
    this._applyWorldDeltaToLocal(kneeBone, blendedKneeDelta);

    this.model.updateWorldMatrix(true, true);

    // ── Foot rotation: always applied at full weight for ground contact ───────
    this._setWorldRotation(footBone, targetQuat);

    // Add temporarily at the top of _applyTwoBoneIK
    // console.log('legLength:', (lenUpper + lenLower).toFixed(3), 'upper:', lenUpper.toFixed(3), 'lower:', lenLower.toFixed(3))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _sampleNormal
  // Estimates the terrain surface normal at a given (x, z) world position using
  // finite differences — samples four height values a small distance apart in
  // the X and Z axes, then computes their cross product to get a normal vector.
  // Used to tilt the foot so it lies flat on slopes rather than staying
  // axis-aligned.
  // ─────────────────────────────────────────────────────────────────────────────

  _sampleNormal(x, z) {
    const eps = 0.25;
    const hL = this.terrain.getHeightAtWorld(x - eps, z);
    const hR = this.terrain.getHeightAtWorld(x + eps, z);
    const hD = this.terrain.getHeightAtWorld(x, z - eps);
    const hU = this.terrain.getHeightAtWorld(x, z + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _applyWorldDeltaToLocal
  // Applies a world-space rotation delta to a bone's local quaternion.
  // Converts the world delta into the bone's parent space first, so the
  // local quaternion stays consistent with the parent's transform.
  // Falls back to a direct premultiply if the bone has no parent.
  // ─────────────────────────────────────────────────────────────────────────────


  _applyWorldDeltaToLocal(bone, worldDelta) {
    if (!bone.parent) {
      bone.quaternion.premultiply(worldDelta);
      return;
    }
    const parentQ = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentQ);
    const parentQInv = parentQ.clone().invert();
    const localDelta = parentQInv
      .clone()
      .multiply(worldDelta)
      .multiply(parentQ);
    bone.quaternion.premultiply(localDelta);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // _setWorldRotation
  // Sets a bone's rotation to an exact world-space quaternion by back-solving
  // through the parent's world rotation. This is how the foot bone is locked to
  // the terrain surface normal — we want the foot to have a specific orientation
  // in world space regardless of what the parent chain is doing.
  // ─────────────────────────────────────────────────────────────────────────────

  _setWorldRotation(bone, worldQuat) {
    if (!bone.parent) {
      bone.quaternion.copy(worldQuat);
      return;
    }
    const parentWorldQuat = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentWorldQuat);
    bone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldQuat));
  }
}
