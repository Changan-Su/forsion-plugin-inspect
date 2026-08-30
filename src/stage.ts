// 检视台的 3D 部分:**第一人称手持(viewmodel)** + CS 那套 inspect 动作。
//
// 不是转台。CS 里按 F 是这样的:刀本来就握在手里、挂在屏幕右下角随脚步轻晃(idle bob);
// 按下去之后角色把刀抬到眼前,先竖直看刀面,再斜举看另一侧,最后放回右下角继续晃。
// 所以这里做的是**一条关键帧动作**,不是「物体在画面中央自转」。
//
//   ① deploy   掏刀(从画面右下翻入,~1.05s)→ 接着自动走一遍 ③
//   ② idle     右下角静置 + 呼吸/脚步式微晃,一直循环
//   ③ inspect  按 F / 点一下模型触发的那段 flourish(≈5.15s 关键帧,跑完自动回 ②)
//   ④ holster  收刀(往下沉出画,~260ms)
//
// ⚠️录像里的主手没有绕刀转圈:主手只做有限腕部转向,刀在握把轴上另有一层小幅翻面。
// 因此 viewmodel / weaponPivot / mainHand 必须是三层,不能再把刀和手塞进同一组后累计 2π。
//
// 两种载体(见 index.ts):
//   · HUD 档   —— 铺满视口的**透明、鼠标穿透**画布,当前 Space 照常用。这是 CS 的真形态。
//                 传 `{ mirror: true }`:CS 是右手持刀挂右下,挪到左下必须整套姿态镜像,
//                 否则看着像左手反着攥刀。镜像 = x 取负 + rotY/rotZ 取负(绕 YZ 平面照镜子)。
//                 ⚠️**不能靠 `scale.x = -1` 镜像**:负缩放会翻转法线与面剔除,金属高光当场反过来。
//   · 面板档   —— 长按 F 拉出的全屏详情页,能拖着转。
//
// 拖拽只在面板档给(HUD 档鼠标是穿透的,压根收不到事件)。

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Skin } from './skin'

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export type KnifeType = 'standard' | 'butterfly'

/** 一个手持姿态:位置(相机空间,单位≈米)+ 欧拉角。 */
export interface Pose {
  p: [number, number, number]
  r: [number, number, number]
}

/** 静置位。**照 CS 刺刀参考录像**:刀不是竖着挂在角落的,而是**斜横**在画面下缘中偏右,
 *  刀尖朝**左上**约 30°,刀柄在右手里。竖着挂是"展台"的摆法,不是握着的摆法。 */
const REST: Pose = { p: [0.54, -0.40, -1.02], r: [0.16, -0.34, 1.02] }
/** 收刀位:顺着握持方向往右下沉出画。 */
const HOLSTER: Pose = { p: [0.96, -1.30, -0.98], r: [0.55, -0.34, 0.80] }
/** 副手(左手)的固定位:画面左下角,只露手掌与一截袖口。相机空间。 */
const OFF_HAND: Pose = { p: [-0.34, -0.46, -0.96], r: [-0.95, 0.50, -0.18] }
/** 刀与手的接触点。归一化后的刀中心在原点,握把约在 y=-0.25。 */
const GRIP_Y = -0.25
const WEAPON_REST: Pose = { p: [0, GRIP_Y, 0], r: [0, 0, 0] }

/** 切刀(deploy):右下入镜 → 刀绕握把向左翻过掌心 → 接住 → 落回斜横静置位。≈1.05s。
 *  DRAW 只管手腕/整套挂点;刀在掌心里的快速翻转单独写在 DRAW_WEAPON。 */
const DRAW: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: { p: [1.04, -1.36, -0.94], r: [0.34, -0.55, 0.12] } },
  { t: 0.18, pose: { p: [0.82, -0.70, -0.94], r: [0.28, -0.42, 0.14] } },
  { t: 0.36, pose: { p: [0.50, -0.25, -0.91], r: [0.20, -0.30, 0.18] } },
  { t: 0.55, pose: { p: [0.34, 0.01, -0.88], r: [0.12, -0.22, 0.25] } },
  { t: 0.78, pose: { p: [0.42, -0.10, -0.94], r: [0.14, -0.29, 0.58] } },
  { t: 1.05, pose: REST },
]
const DRAW_WEAPON: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: WEAPON_REST },
  { t: 0.18, pose: { p: [0, GRIP_Y, 0], r: [0.02, -0.08, 0.14] } },
  { t: 0.36, pose: { p: [0, GRIP_Y, 0], r: [0.04, -0.34, 0.72] } },
  { t: 0.55, pose: { p: [0, GRIP_Y, 0], r: [0.06, -0.46, 1.30] } },
  { t: 0.78, pose: { p: [0, GRIP_Y, 0], r: [0.02, -0.18, 0.34] } },
  { t: 1.05, pose: WEAPON_REST },
]
/** 检视(inspect)。按录像时间线:斜横静置 → 竖直看刀面 → 斜举看另一侧 → 再竖直 → 放回。
 *  主手所有轴的累计变化都小于 1rad;没有任何整圈。 */
const INSPECT: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: REST },
  { t: 0.38, pose: { p: [0.35, -0.17, -1.02], r: [0.10, -0.18, 0.14] } }, // 竖直入镜
  { t: 1.30, pose: { p: [0.34, -0.14, -1.00], r: [0.08, -0.10, 0.13] } }, // 第一面停看
  { t: 1.78, pose: { p: [0.33, -0.11, -0.98], r: [0.10, -0.24, 0.18] } }, // 轻转刀面
  { t: 2.42, pose: { p: [0.30, -0.05, -0.90], r: [0.05, -0.20, 0.58] } }, // 斜举到左上
  { t: 3.20, pose: { p: [0.30, -0.04, -0.90], r: [-0.04, -0.27, 0.60] } }, // 第二面停看
  { t: 3.82, pose: { p: [0.34, -0.12, -1.00], r: [0.09, -0.12, 0.15] } }, // 回到竖直
  { t: 4.62, pose: { p: [0.36, -0.15, -1.02], r: [0.10, -0.21, 0.14] } },
  { t: 5.15, pose: REST },
]

/** 刀相对握把的小幅翻面。最大 0.46rad(≈26°),只让刀面吃到高光;主手不继承这层。 */
const INSPECT_WEAPON: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: WEAPON_REST },
  { t: 0.38, pose: WEAPON_REST },
  { t: 1.30, pose: { p: [0, GRIP_Y, 0], r: [0, 0.42, 0] } },
  { t: 1.78, pose: { p: [0, GRIP_Y, 0], r: [0, -0.36, 0] } },
  { t: 2.42, pose: { p: [0, GRIP_Y, 0], r: [0, -0.18, 0] } },
  { t: 3.20, pose: { p: [0, GRIP_Y, 0], r: [0, 0.20, 0] } },
  { t: 3.82, pose: { p: [0, GRIP_Y, 0], r: [0, 0.38, 0] } },
  { t: 4.62, pose: { p: [0, GRIP_Y, 0], r: [0, -0.18, 0] } },
  { t: 5.15, pose: WEAPON_REST },
]

/** 蝴蝶刀切刀:闭合的两柄从右下进镜,只让柄围轴连续翻开;手腕本身不跟着绕圈。 */
const BUTTERFLY_DRAW: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: { p: [0.98, -1.28, -0.94], r: [0.30, -0.48, 0.18] } },
  { t: 0.18, pose: { p: [0.72, -0.66, -0.92], r: [0.22, -0.36, 0.22] } },
  { t: 0.42, pose: { p: [0.43, -0.18, -0.90], r: [0.14, -0.24, 0.30] } },
  { t: 0.68, pose: { p: [0.34, -0.02, -0.88], r: [0.08, -0.18, 0.48] } },
  { t: 0.94, pose: { p: [0.46, -0.16, -0.96], r: [0.12, -0.27, 0.78] } },
  { t: 1.18, pose: REST },
]
const BUTTERFLY_DRAW_WEAPON: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: { p: [0, GRIP_Y, 0], r: [0.04, -0.06, -0.28] } },
  { t: 0.18, pose: { p: [0, GRIP_Y, 0], r: [0.02, -0.12, 0.36] } },
  { t: 0.42, pose: { p: [0, GRIP_Y, 0], r: [0.06, -0.36, 1.18] } },
  { t: 0.68, pose: { p: [0, GRIP_Y, 0], r: [-0.02, -0.24, -0.42] } },
  { t: 0.94, pose: { p: [0, GRIP_Y, 0], r: [0.02, -0.14, 0.26] } },
  { t: 1.18, pose: WEAPON_REST },
]

/** 参考视频后半段两遍是同一次 inspect 的重复展示。这里只编码一遍:抬刀 → 柄翻过指间 → 张开接住 → 回静置。 */
const BUTTERFLY_INSPECT: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: REST },
  { t: 0.24, pose: { p: [0.42, -0.19, -0.98], r: [0.10, -0.21, 0.58] } },
  { t: 0.56, pose: { p: [0.31, -0.03, -0.90], r: [0.02, -0.14, 0.20] } },
  { t: 0.94, pose: { p: [0.34, -0.07, -0.91], r: [0.08, -0.24, 0.36] } },
  { t: 1.28, pose: { p: [0.40, -0.15, -0.96], r: [0.12, -0.29, 0.74] } },
  { t: 1.72, pose: REST },
  { t: 2.28, pose: REST },
]
const BUTTERFLY_INSPECT_WEAPON: Array<{ t: number; pose: Pose }> = [
  { t: 0.00, pose: WEAPON_REST },
  { t: 0.24, pose: { p: [0, GRIP_Y, 0], r: [0.03, -0.18, 0.30] } },
  { t: 0.56, pose: { p: [0, GRIP_Y, 0], r: [0.06, -0.42, 1.10] } },
  { t: 0.94, pose: { p: [0, GRIP_Y, 0], r: [-0.02, 0.20, -0.54] } },
  { t: 1.28, pose: { p: [0, GRIP_Y, 0], r: [0.02, -0.12, 0.22] } },
  { t: 1.72, pose: WEAPON_REST },
  { t: 2.28, pose: WEAPON_REST },
]

export interface HandlePose { a: number; b: number }
const BUTTERFLY_DRAW_HANDLES: Array<{ t: number; pose: HandlePose }> = [
  { t: 0.00, pose: { a: Math.PI, b: -Math.PI } }, // 闭合:两柄叠在刀背上
  { t: 0.18, pose: { a: Math.PI * 1.36, b: -Math.PI * 1.18 } },
  { t: 0.38, pose: { a: Math.PI * 0.34, b: -Math.PI * 0.28 } },
  { t: 0.58, pose: { a: -Math.PI * 0.72, b: Math.PI * 0.86 } },
  { t: 0.78, pose: { a: Math.PI * 1.08, b: -Math.PI * 0.82 } },
  { t: 0.98, pose: { a: 0.14, b: -0.10 } },
  { t: 1.18, pose: { a: 0, b: 0 } },
]
const BUTTERFLY_INSPECT_HANDLES: Array<{ t: number; pose: HandlePose }> = [
  { t: 0.00, pose: { a: 0, b: 0 } },
  { t: 0.18, pose: { a: Math.PI * 0.92, b: -0.18 } },
  { t: 0.38, pose: { a: Math.PI * 1.72, b: -Math.PI * 0.62 } },
  { t: 0.62, pose: { a: Math.PI * 2.28, b: -Math.PI * 1.46 } },
  { t: 0.88, pose: { a: Math.PI * 1.82, b: -Math.PI * 2.22 } },
  { t: 1.14, pose: { a: Math.PI * 2.06, b: -Math.PI * 1.96 } },
  { t: 1.42, pose: { a: Math.PI * 2, b: -Math.PI * 2 } },
  { t: 2.28, pose: { a: Math.PI * 2, b: -Math.PI * 2 } },
]


/** 一条自定义检视动作(用户从库里的 `*.motion.json` 导入)。**只替换检视段**,切刀/收刀仍是内置的
 *  —— 切刀要接得住任意时长的检视轨,让用户改它等于让每份动作文件都得自己处理入场。
 *  时长由 `hand` 最后一帧的 `t` 决定(tick 里全程按轨末取时长,没有写死的秒数)。 */
export interface Motion {
  /** 手腕/整套挂点的轨道。至少两帧,`t` 严格递增。 */
  hand: Array<{ t: number; pose: Pose }>
  /** 刀相对握把的翻面;省略 = 刀在手里不动(只有手腕在动)。 */
  weapon?: Array<{ t: number; pose: Pose }>
  /** 只有蝴蝶刀吃这条:两片柄各自的转角(弧度,可累加过 2π 转整圈)。省略 = 保持张开。 */
  handles?: Array<{ t: number; pose: HandlePose }>
}

/**
 * 把**导入的模型**摆成「刀」该有的样子。导入的 `.glb` 各家朝向不一 —— 用户这把 Sketchfab 蝴蝶刀
 * 就是躺在 X 轴上的(长 2.53 在 X、厚 0.13 在 Z),原样装上去就是横躺在手里。
 *
 * 三步,全是包围盒算出来的,不需要用户填任何字段:
 *  ① **最长轴 → +Y**(刀锋朝上)、**最薄轴 → Z**(刀面正对镜头,这样高光才扫得到刀面);
 *  ② **刀柄朝下**:优先看节点名(`handle`/`grip`/`hilt`/`柄` —— Sketchfab 导出几乎都带),
 *     拿它的质心定方向;没有命名就退回「较厚的那半是刀柄」;
 *  ③ 归一化后把**刀柄那端**落到握持点,而不是把整把刀居中(居中 = 半把刀吊在手下面)。
 * ⚠️只对导入模型做;内置刀和导入的**手**模型都不能进这里(手有自己的朝向)。
 */
export function orientAsKnife(obj: THREE.Object3D): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(obj)
  if (box.isEmpty()) return obj
  const size = box.getSize(new THREE.Vector3())
  const axes: Array<['x' | 'y' | 'z', number]> = [['x', size.x], ['y', size.y], ['z', size.z]]
  const sorted = [...axes].sort((a, b) => b[1] - a[1])
  const longAxis = sorted[0][0]
  const thinAxis = sorted[2][0]

  const wrap = new THREE.Group()
  wrap.add(obj)
  // 长轴 → Y。绕哪个轴转由「长轴是谁」决定;顺带把最薄轴带到 Z(不成立时再补一次绕 Y 的转)。
  if (longAxis === 'x') wrap.rotation.z = Math.PI / 2
  else if (longAxis === 'z') wrap.rotation.x = -Math.PI / 2
  wrap.updateMatrixWorld(true)
  const after = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3())
  if (after.z > after.x) {
    // 最薄的那维还没落到 Z(长轴是 X 且原本薄在 Y 之类)→ 绕 Y 再转 90°。
    const fix = new THREE.Group()
    fix.add(wrap)
    fix.rotation.y = Math.PI / 2
    fix.updateMatrixWorld(true)
    return orientHandleDown(fix, thinAxis)
  }
  return orientHandleDown(wrap, thinAxis)
}

/** 让刀柄那端朝 -Y,并把刀柄末端对到原点(握持点)。 */
function orientHandleDown(node: THREE.Object3D, _thinAxis: string): THREE.Object3D {
  node.updateMatrixWorld(true)
  // 刀柄质心:先认名字(Sketchfab / Blender 导出几乎都留着 handle / grip / 柄)。
  const HANDLE = /handle|grip|hilt|haft|柄/i
  const pt = new THREE.Vector3()
  let handleY: number | null = null
  let n = 0
  let sum = 0
  node.traverse((o) => {
    if (!HANDLE.test(o.name)) return
    const b = new THREE.Box3().setFromObject(o)
    if (b.isEmpty()) return
    sum += b.getCenter(pt).y
    n++
  })
  if (n) handleY = sum / n

  const box = new THREE.Box3().setFromObject(node)
  const mid = box.getCenter(new THREE.Vector3()).y
  let flip = false
  if (handleY != null) {
    flip = handleY > mid // 刀柄在上半 → 整把翻过来
  } else {
    // 没有命名可依:比两半的**厚度**(次长轴的跨度),厚的那半是刀柄。
    flip = halfThickness(node, box, true) < halfThickness(node, box, false)
  }
  const out = new THREE.Group()
  out.add(node)
  if (flip) out.rotation.z = Math.PI
  out.updateMatrixWorld(true)
  return out
}

/** 上/下半段在 X 方向的跨度(粗略当厚度用)。逐顶点太贵,按子网格的包围盒统计已经够分辨刀柄。 */
function halfThickness(node: THREE.Object3D, box: THREE.Box3, upper: boolean): number {
  const mid = (box.min.y + box.max.y) / 2
  let span = 0
  const b = new THREE.Box3()
  node.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return
    b.setFromObject(o)
    if (b.isEmpty()) return
    const c = (b.min.y + b.max.y) / 2
    if (upper === c > mid) span = Math.max(span, b.max.x - b.min.x)
  })
  return span
}

export interface Stage {
  show(obj: THREE.Object3D): void
  /** 选择当前刀型;必须在 show 前设置,决定切刀 / 检视时间轴。 */
  setKnifeType(type: KnifeType): void
  buildKnife(type: KnifeType, skin: Skin, label: string): THREE.Object3D
  buildBlade(skin: Skin, label: string): THREE.Object3D
  buildButterfly(skin: Skin, label: string): THREE.Object3D
  /** 程序化生成的一只戴手套的手(几何拼的,不写实)。 */
  buildHand(): THREE.Object3D
  /** 换/摘握刀的那只手。传 null = 不画手。 */
  setHand(obj: THREE.Object3D | null): void
  /** `orient=true` 时按「刀」的朝向自动摆正(见 orientAsKnife)。手模型不要传 true。 */
  loadModel(url: string, orient?: boolean): Promise<THREE.Object3D>
  /** 换一条自定义检视动作;传 null 回到内置轨。下一次进入检视段时生效。 */
  setMotion(motion: Motion | null): void
  /** 重播一遍 flourish(点一下模型)。收刀中忽略。 */
  replay(): void
  /** 收刀;resolve 时可以拆浮层了。 */
  leave(): Promise<void>
  dispose(): void
}

/** 在一条关键帧时间轴上取姿态(段内 easeInOut)。切刀与检视共用。 */
function poseAt(track: Array<{ t: number; pose: Pose }>, time: number): Pose {
  if (time <= 0) return track[0].pose
  if (time >= track[track.length - 1].t) return track[track.length - 1].pose
  let i = 0
  while (i < track.length - 2 && track[i + 1].t <= time) i++
  return lerpPose(track[i].pose, track[i + 1].pose, easeInOut((time - track[i].t) / (track[i + 1].t - track[i].t)))
}

function handleAt(track: Array<{ t: number; pose: HandlePose }>, time: number): HandlePose {
  if (time <= 0) return track[0].pose
  if (time >= track[track.length - 1].t) return track[track.length - 1].pose
  let i = 0
  while (i < track.length - 2 && track[i + 1].t <= time) i++
  const k = easeInOut((time - track[i].t) / (track[i + 1].t - track[i].t))
  return {
    a: track[i].pose.a + (track[i + 1].pose.a - track[i].pose.a) * k,
    b: track[i].pose.b + (track[i + 1].pose.b - track[i].pose.b) * k,
  }
}

/** 自定义动作没给 weapon 轨时用的「刀在手里不动」占位轨。 */
const STILL_WEAPON: Array<{ t: number; pose: Pose }> = [{ t: 0, pose: WEAPON_REST }]

const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k],
  r: [a.r[0] + (b.r[0] - a.r[0]) * k, a.r[1] + (b.r[1] - a.r[1]) * k, a.r[2] + (b.r[2] - a.r[2]) * k],
})

export interface StageOpts {
  /** 左下角挂位(镜像成左手)。缺省 false = CS 原样的右下角。 */
  mirror?: boolean
  /** 是否接管鼠标(面板档 true;HUD 档鼠标穿透,给 false)。 */
  interactive?: boolean
  /** 手部模型:缺省用内置几何拼的那只;传 null 则不画手。 */
  hand?: THREE.Object3D | null
  /** 一次性:flourish 跑完自动收刀(HUD 档)。缺省 false = 跑完回静置态一直挂着(面板档)。 */
  autoHolster?: boolean
  /** 收刀动画播完(不论是 autoHolster 还是 leave() 触发)。HUD 档拿它来拆自己那层 DOM。 */
  onHolstered?(): void
}

/** 关于 YZ 平面照镜子:位置 x 取负,绕 Y / 绕 Z 的旋转取负,绕 X 不变。
 *  x 再乘 0.6 往中间收一点:HUD 那块画布比整屏窄得多,原样镜像刀会怼在左边缘上被裁掉刀尖
 *  (真截图上就是这样)。这不是「镜像」的一部分,是给窄画布的取景补偿。 */
const MIRROR_INSET = 0.6
const mirrorPose = (o: Pose): Pose => ({ p: [-o.p[0] * MIRROR_INSET, o.p[1], o.p[2]], r: [o.r[0], -o.r[1], -o.r[2]] })

/** 一只戴手套的手 + 一小截袖口。全是胶囊和盒子 —— 目的是让画面里「有人在耍」,不是解剖模型。
 *  照参考录像:手在画面下缘,**只露手掌和很短一截袖口**(小臂立刻出画)。做长手臂反而穿帮。
 *  左右手共用同一份几何 —— 副手挂在相机上、姿态另给,不需要真的镜像出一只左手。 */
function makeHand(): THREE.Object3D {
  const g = new THREE.Group()
  const glove = new THREE.MeshStandardMaterial({ color: 0x8a8175, roughness: 0.82, metalness: 0.03 })
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.92, metalness: 0.02 })

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.20, 0.135), glove)
  palm.position.set(0.005, -0.02, -0.055)
  g.add(palm)

  // 四指:横着(沿 X)扣在握把前方,自上而下略微下沉,像自然握持
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.10, 3, 8), glove)
    f.rotation.z = Math.PI / 2
    f.position.set(0.0, 0.06 - i * 0.047, 0.036 - i * 0.004)
    g.add(f)
  }
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.085, 3, 8), glove)
  thumb.rotation.set(0, 0, Math.PI / 2.6)
  thumb.position.set(-0.055, 0.045, -0.005)
  g.add(thumb)

  // 袖口:短短一截黑色战术服,收在手掌后面就够了
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.088, 0.17, 14), sleeve)
  cuff.rotation.set(-0.5, 0, 0.1)
  cuff.position.set(0.02, -0.18, -0.13)
  g.add(cuff)

  return g
}

export function createStage(host: HTMLElement, opts: StageOpts = {}): Stage {
  const MIRROR = opts.mirror === true
  const INTERACTIVE = opts.interactive !== false
  const AUTO_HOLSTER = opts.autoHolster === true
  const mp = (o: Pose): Pose => (MIRROR ? mirrorPose(o) : o)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  // viewmodel FOV:手持视角比世界视角宽得多,刀离眼睛很近才有「握在手里」的透视。
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 100)

  // ⚠️金属(metalness≈1)反射的是环境,没有 env map 就是一块**灰塑料** —— 打多少灯都没用。
  // RoomEnvironment 是 three 自带的程序化房间,零资产、零网络请求(CSP 下唯一可行的做法)。
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture

  scene.add(new THREE.AmbientLight(0xffffff, 0.4))
  // 头灯挂在相机上:刀转动时永远有一道扫过刀面的高光(手持视角的关键观感)。
  const headlamp = new THREE.DirectionalLight(0xffffff, 2.4)
  headlamp.position.set(0.6, 0.8, 1)
  camera.add(headlamp)
  scene.add(camera)
  const rim = new THREE.DirectionalLight(0x9ec4ff, 2.0)
  rim.position.set(-2.5, 1.0, -1.5)
  scene.add(rim)
  const fill = new THREE.DirectionalLight(0xffd9a0, 0.8)
  fill.position.set(-1.0, -1.8, 1.5)
  scene.add(fill)

  // 整体手腕挂点只负责位移和有限腕部转向。武器另挂 weaponPivot,才能绕握把翻面而不把手带着转。
  const viewmodel = new THREE.Group()
  scene.add(viewmodel)
  const weaponPivot = new THREE.Group()
  viewmodel.add(weaponPivot)
  // 副手(左手)。CS 刺刀是**双手入镜**的,而左手**不跟着刀转** —— 它固定在画面左下角,只随呼吸微动。
  // 所以它挂在相机上,不能塞进 hand 组(塞进去会跟着刀一起翻跟头)。
  const offHand = new THREE.Group()
  offHand.add(makeHand()) // 副手始终用内置几何:它只是陪衬,导入的手模型只换主手
  offHand.visible = false
  camera.add(offHand)
  let current: THREE.Object3D | null = null
  let knifeType: KnifeType = 'standard'
  /** 自定义检视动作;null = 走内置轨。 */
  let motion: Motion | null = null
  let butterflyHandleA: THREE.Object3D | null = null
  let butterflyHandleB: THREE.Object3D | null = null

  // 握着刀的那只手。**与 weaponPivot 同级**,不进武器的旋转层 —— 这是本次修复的结构闸。
  // ⚠️自带刀的握把归一化后落在 y ≈ -0.25;**导入的 glb 无从得知握把在哪**,手多半对不上,
  // 所以皮肤箱里换刀时手可以单独关掉(见 index.ts 的「手部模型」一节)。
  let handMesh: THREE.Object3D | null = null
  const mountHand = (obj: THREE.Object3D | null): void => {
    if (handMesh) { viewmodel.remove(handMesh); release(handMesh) }
    handMesh = obj
    if (obj) { obj.position.set(0, GRIP_Y, 0); viewmodel.add(obj) }
    // 左手只在「有右手」时出现 —— 用户选了「不画手」就两只都不画。
    offHand.visible = !!obj
  }

  const resize = (): void => {
    const w = host.clientWidth || 1
    const h = host.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(host)

  // ── 状态机 ──────────────────────────────────────────────────────────────────
  type Phase = 'deploy' | 'idle' | 'inspect' | 'holster'
  let phase: Phase = 'deploy'
  /** 当前阶段已走的秒数。 */
  let clockIn = 0
  let leaveResolve: (() => void) | null = null
  /** 收刀只报一次(tick 每帧都跑,不设闸会把 onHolstered 敲成每帧一次)。 */
  let holstered = false

  // 拖拽接管
  let dragging = false
  let dragged = false
  let lastX = 0
  let lastY = 0
  let uYaw = 0
  let uPitch = 0
  let vYaw = 0
  let vPitch = 0

  function replay(): void {
    if (phase === 'holster') return
    phase = 'inspect'
    clockIn = 0
    // 重播时把手动偏移收回去,否则 flourish 会歪着跑。
    uYaw = 0
    uPitch = 0
    vYaw = 0
    vPitch = 0
  }

  const onDown = (e: PointerEvent): void => {
    dragging = true
    dragged = false
    lastX = e.clientX
    lastY = e.clientY
    renderer.domElement.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return
    // 归一化到画布宽度:窗口尺寸 / 端级 zoom 变了手感也一致。
    const k = 4 / Math.max(host.clientWidth, 1)
    vYaw = (e.clientX - lastX) * k
    vPitch = (e.clientY - lastY) * k
    if (Math.abs(vYaw) + Math.abs(vPitch) > 0.004) dragged = true
    uYaw += vYaw
    uPitch = THREE.MathUtils.clamp(uPitch + vPitch, -1.3, 1.3)
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = (e: PointerEvent): void => {
    dragging = false
    try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
    if (!dragged) replay() // 没拖动 = 单击 → 再看一遍(CS 里就是再按一次 F)
  }
  if (INTERACTIVE) {
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)
  }

  let raf = 0
  const clock = new THREE.Clock()
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.05)
    clockIn += dt
    const t = clock.getElapsedTime()

    let pose: Pose
    let weaponPose: Pose
    let handles: HandlePose = { a: 0, b: 0 }
    const drawTrack = knifeType === 'butterfly' ? BUTTERFLY_DRAW : DRAW
    const drawWeaponTrack = knifeType === 'butterfly' ? BUTTERFLY_DRAW_WEAPON : DRAW_WEAPON
    // 自定义动作只接管检视段;省略的轨道**不回落到内置轨**(内置轨是另一条时间线,长度对不上会
    // 在半路上突然跳一下),而是整段保持静置姿态。
    const inspectTrack = motion?.hand ?? (knifeType === 'butterfly' ? BUTTERFLY_INSPECT : INSPECT)
    const inspectWeaponTrack = motion
      ? motion.weapon ?? STILL_WEAPON
      : knifeType === 'butterfly' ? BUTTERFLY_INSPECT_WEAPON : INSPECT_WEAPON
    const drawEnd = drawTrack[drawTrack.length - 1].t
    const inspectEnd = inspectTrack[inspectTrack.length - 1].t
    if (phase === 'deploy') {
      pose = mp(poseAt(drawTrack, clockIn))
      weaponPose = mp(poseAt(drawWeaponTrack, clockIn))
      if (knifeType === 'butterfly') handles = handleAt(BUTTERFLY_DRAW_HANDLES, clockIn)
      if (clockIn >= drawEnd) { phase = 'inspect'; clockIn = 0 } // 切完刀接着看一遍,同 CS 换刀后的手感
    } else if (phase === 'inspect') {
      pose = mp(poseAt(inspectTrack, clockIn))
      weaponPose = mp(poseAt(inspectWeaponTrack, clockIn))
      if (motion) { if (motion.handles) handles = handleAt(motion.handles, clockIn) }
      else if (knifeType === 'butterfly') handles = handleAt(BUTTERFLY_INSPECT_HANDLES, clockIn)
      if (clockIn >= inspectEnd) { phase = AUTO_HOLSTER ? 'holster' : 'idle'; clockIn = 0 }
    } else if (phase === 'holster') {
      const k = Math.min(clockIn / 0.26, 1)
      pose = lerpPose(mp(REST), mp(HOLSTER), k * k)
      weaponPose = mp(WEAPON_REST)
      if (k >= 1 && !holstered) {
        holstered = true
        leaveResolve?.()
        leaveResolve = null
        opts.onHolstered?.()
      }
    } else {
      pose = mp(REST)
      weaponPose = mp(WEAPON_REST)
    }

    // idle bob:呼吸 + 脚步式左右摆。只在静置态给足,动作中几乎关掉(不然 flourish 会抖)。
    const amp = phase === 'idle' ? 1 : 0.15
    const bobX = Math.sin(t * 0.9) * 0.012 * amp
    const bobY = Math.sin(t * 1.7) * 0.009 * amp
    const swayZ = Math.sin(t * 0.6) * 0.035 * amp

    if (!dragging) {
      uYaw += vYaw
      uPitch = THREE.MathUtils.clamp(uPitch + vPitch, -1.3, 1.3)
      vYaw *= 0.93
      vPitch *= 0.93
      if (Math.abs(vYaw) < 1e-4) vYaw = 0
      if (Math.abs(vPitch) < 1e-4) vPitch = 0
      // 惯性走完后手动偏移在静置态缓缓归位(松手后刀自己回到挂位)。
      if (phase === 'idle' && vYaw === 0 && vPitch === 0) {
        uYaw *= 0.97
        uPitch *= 0.97
      }
    }

    viewmodel.position.set(pose.p[0] + bobX, pose.p[1] + bobY, pose.p[2])
    viewmodel.rotation.set(pose.r[0], pose.r[1], pose.r[2] + swayZ)
    // 动画里的刀面翻转和面板里的拖拽都只打在武器轴上,不会再把主手拖着转圈。
    weaponPivot.position.set(weaponPose.p[0], weaponPose.p[1], weaponPose.p[2])
    weaponPivot.rotation.set(weaponPose.r[0] + uPitch, weaponPose.r[1] + uYaw, weaponPose.r[2])
    // 只有蝴蝶刀的两片柄在轴心上做连续大角度翻转;主手仍住在 viewmodel 同级,不会跟着转圈。
    if (butterflyHandleA) butterflyHandleA.rotation.z = MIRROR ? -handles.a : handles.a
    if (butterflyHandleB) butterflyHandleB.rotation.z = MIRROR ? -handles.b : handles.b

    // 参考录像:副手只在切刀/静置时入镜;检视抬刀后退到画外,结束前再回来。
    let offHandDrop = 0
    if (phase === 'deploy') offHandDrop = (1 - easeInOut(Math.min(Math.max((clockIn - 0.12) / 0.40, 0), 1))) * 0.78
    else if (phase === 'inspect') {
      // ⚠️进出场斜坡要按轨长收缩:自定义动作可以短到 0.5s,而写死的 .32/.46 两段一旦重叠,
      //   副手会在中间**瞬移**入画(内置轨都在 2s 以上,只有导入的短动作会撞上)。
      const inRamp = Math.min(0.32, inspectEnd * 0.4)
      const outRamp = Math.min(0.46, inspectEnd * 0.4)
      if (clockIn < inRamp) offHandDrop = easeInOut(clockIn / inRamp) * 0.78
      else if (clockIn > inspectEnd - outRamp) offHandDrop = easeInOut((inspectEnd - clockIn) / outRamp) * 0.78
      else offHandDrop = 0.78
    } else if (phase === 'holster') offHandDrop = easeInOut(Math.min(clockIn / 0.26, 1)) * 0.78
    offHand.position.set(OFF_HAND.p[0] * (MIRROR ? -1 : 1) + bobX * 0.5, OFF_HAND.p[1] - offHandDrop + bobY * 0.6, OFF_HAND.p[2])
    offHand.rotation.set(OFF_HAND.r[0], MIRROR ? -OFF_HAND.r[1] : OFF_HAND.r[1], MIRROR ? -OFF_HAND.r[2] : OFF_HAND.r[2])

    renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(tick)

  /** 释放一棵子树的 geometry/material/texture(three 不 GC 这些,换一次漏一次)。 */
  const release = (root: THREE.Object3D): void => {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material
      for (const one of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        for (const v of Object.values(one as unknown as Record<string, unknown>)) {
          if (v instanceof THREE.Texture) v.dispose()
        }
        one.dispose()
      }
    })
  }

  /** 把任意尺度的模型归一并居中 —— 导入的 glb 尺度千奇百怪。
   *  ⚠️按**包围盒最长边**归一,不是包围球半径:刀这种细长物体的外接球半径 ≈ 半个长度,
   *  按球算会长到出画。0.82 ≈ 手持视角下一把刀该占的大小。 */
  const fit = (obj: THREE.Object3D, maxDim = 0.82): THREE.Object3D => {
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return obj
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const wrap = new THREE.Group()
    obj.position.sub(center)
    wrap.add(obj)
    const longest = Math.max(size.x, size.y, size.z)
    wrap.scale.setScalar(longest > 0 ? maxDim / longest : 1)
    return wrap
  }

  return {
    show(obj) {
      if (current) {
        weaponPivot.remove(current)
        release(current)
      }
      current = fit(obj)
      butterflyHandleA = null
      butterflyHandleB = null
      current.traverse((o) => {
        if (o.name === 'fi-butterfly-handle-a') butterflyHandleA = o
        if (o.name === 'fi-butterfly-handle-b') butterflyHandleB = o
      })
      // weaponPivot 的原点在握把;把居中的模型反向补回,零旋转时画面位置与旧版一致。
      current.position.y = -GRIP_Y
      weaponPivot.add(current)
      phase = 'deploy'
      clockIn = 0
      holstered = false
      uYaw = 0
      uPitch = 0
      vYaw = 0
      vPitch = 0
    },

    replay,
    setKnifeType(type) {
      knifeType = type
      // 可观测口:真 DOM 台架能确认设置绑定最终接到了哪条动画轨。
      renderer.domElement.dataset.knifeType = type
    },
    setMotion(m) {
      motion = m
      renderer.domElement.dataset.motion = m ? 'custom' : 'builtin'
    },
    setHand: mountHand,

    buildHand: makeHand,

    buildKnife(type, skin, label) {
      return type === 'butterfly' ? this.buildButterfly(skin, label) : this.buildBlade(skin, label)
    },

    buildBlade(skin, label) {
      const g = new THREE.Group()
      // ⚠️用 setHSL,别把 skin.primary 那个 CSS 字符串喂给 THREE.Color —— 见 skin.ts 里的注解。
      const body = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(...skin.primaryHsl),
        metalness: skin.metalness,
        roughness: skin.roughness,
      })
      const grip = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(...skin.secondaryHsl),
        metalness: 0.25,
        roughness: 0.72,
      })

      // 刀身:一条 2D 轮廓挤出来(比拼几个 Box 像刀,又比载模型省事)。长轴 = +Y。
      const s = new THREE.Shape()
      s.moveTo(-0.09, 0)
      s.lineTo(-0.09, 0.95)
      s.quadraticCurveTo(-0.04, 1.32, 0.2, 1.46) // 刀尖
      s.quadraticCurveTo(0.42, 1.18, 0.38, 0.86) // 反刃回落
      s.lineTo(0.38, 0)
      s.lineTo(-0.09, 0)
      const blade = new THREE.Mesh(
        new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.015, bevelSegments: 2, curveSegments: 12 }),
        body,
      )
      blade.position.set(-0.15, 0.12, -0.035)
      g.add(blade)

      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.2), grip)
      guard.position.set(0, 0.06, 0)
      g.add(guard)
      const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.62, 4, 14), grip)
      handle.position.set(0, -0.36, 0)
      g.add(handle)
      const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 14), body)
      pommel.position.set(0, -0.74, 0)
      g.add(pommel)

      // 模型名蚀刻在刀身上:一张透明画布贴图,贴在刀面外侧一丁点。
      // ⚠️正反两面各用一张贴图,**背面那张水平翻转** —— 只做一张再 rotateY(π),刀转到背面朝镜头时
      // 字是镜像的(08-29 真截图上就是这样)。真刀两面刻字也不是同一张。
      // 翻转走 **UV**(repeat.x = -1),不在 canvas 里 scale(-1,1):canvas 变换按顺序复合,镜像轴会
      // 跟着 rotate 一起转,出来是上下翻不是左右翻 —— 试过,没修好。UV 这层没有顺序歧义。
      const tex = etchTexture(label, skin)
      const texBack = tex.clone()
      texBack.wrapS = THREE.RepeatWrapping
      texBack.repeat.x = -1
      texBack.offset.x = 1
      texBack.needsUpdate = true
      const etch = new THREE.Mesh(
        new THREE.PlaneGeometry(0.3, 1.05),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.7, depthWrite: false }),
      )
      // ⚠️刀面真实 z:挤出 depth 0.07 + bevelThickness 0.015 两侧 → 世界 z ∈ [-0.05, 0.05]
      // (blade.position.z = -0.035)。贴 0.041 会**埋进刀身里**看不见 —— 真截图才发现。
      etch.position.set(0.02, 0.68, 0.058)
      g.add(etch)
      const etchBack = new THREE.Mesh(
        etch.geometry,
        new THREE.MeshBasicMaterial({ map: texBack, transparent: true, opacity: 0.7, depthWrite: false }),
      )
      etchBack.position.set(0.02, 0.68, -0.058)
      etchBack.rotation.y = Math.PI
      g.add(etchBack)

      return g
    },

    buildButterfly(skin, label) {
      const g = new THREE.Group()
      const steel = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(...skin.primaryHsl),
        metalness: skin.metalness,
        roughness: skin.roughness,
      })
      const handleMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(...skin.secondaryHsl),
        metalness: 0.72,
        roughness: 0.34 + skin.float * 0.30,
      })
      const dark = new THREE.MeshStandardMaterial({ color: 0x15191e, metalness: 0.78, roughness: 0.38 })

      // 刀身长轴 = +Y,枢轴在原点;开刃侧稍外弯,贴近参考里的细长刀尖。
      const s = new THREE.Shape()
      s.moveTo(-0.055, 0.03)
      s.lineTo(-0.055, 1.08)
      s.quadraticCurveTo(-0.025, 1.31, 0.075, 1.43)
      s.quadraticCurveTo(0.16, 1.20, 0.145, 0.94)
      s.lineTo(0.125, 0.03)
      s.closePath()
      const blade = new THREE.Mesh(
        new THREE.ExtrudeGeometry(s, { depth: 0.055, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2, curveSegments: 12 }),
        steel,
      )
      blade.position.z = -0.028
      g.add(blade)

      const spine = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.74, 0.085), dark)
      spine.position.set(-0.035, 0.49, 0)
      g.add(spine)

      /** 每片刀柄是独立 pivot:程序可只转它,而不是把手和整把刀一起拧。 */
      const makeHandle = (name: string, x: number, z: number): THREE.Group => {
        const pivot = new THREE.Group()
        pivot.name = name
        pivot.position.set(x, 0, z)
        const railL = new THREE.Mesh(new THREE.CapsuleGeometry(0.034, 0.61, 4, 10), handleMat)
        railL.position.set(-0.052, -0.36, 0)
        const railR = railL.clone()
        railR.position.x = 0.052
        pivot.add(railL, railR)
        for (const y of [-0.10, -0.36, -0.62]) {
          const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.052, 0.074), dark)
          bridge.position.set(0, y, 0)
          pivot.add(bridge)
        }
        const end = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.09), handleMat)
        end.position.set(0, -0.70, 0)
        pivot.add(end)
        return pivot
      }
      const handleA = makeHandle('fi-butterfly-handle-a', -0.075, -0.035)
      const handleB = makeHandle('fi-butterfly-handle-b', 0.095, 0.04)
      g.add(handleA, handleB)

      for (const x of [-0.075, 0.095]) {
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.13, 18), steel)
        pin.rotation.x = Math.PI / 2
        pin.position.set(x, 0, 0)
        g.add(pin)
      }

      const tex = etchTexture(label, skin)
      const etch = new THREE.Mesh(
        new THREE.PlaneGeometry(0.15, 0.78),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.58, depthWrite: false }),
      )
      etch.position.set(0.08, 0.70, 0.045)
      g.add(etch)
      return g
    },

    async loadModel(url, orient = false) {
      const buf = await fetch(url)
        .then((r) => {
          if (r.status === 404) throw new Error('文件找不到了(库里被移走或重命名?)')
          if (!r.ok) throw new Error(`读不到文件(HTTP ${r.status})`)
          return r.arrayBuffer()
        })
        .catch((e: Error) => {
          // 最常见的两种:没打开笔记库(协议回 404 'no vault')、宿主 CSP 没放行 amadeus-asset:。
          throw new Error(`${e.message || e}` + (String(e).includes('Failed to fetch') ? ' —— 宿主版本过旧(CSP 未放行 amadeus-asset:)或未打开笔记库' : ''))
        })
      const gltf = await new GLTFLoader().parseAsync(buf, '')
      return orient ? orientAsKnife(gltf.scene) : gltf.scene
    },

    leave() {
      if (phase === 'holster') return Promise.resolve()
      phase = 'holster'
      clockIn = 0
      return new Promise<void>((res) => { leaveResolve = res })
    },

    dispose() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      if (current) release(current)
      envRT.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

/** 刀身蚀刻贴图:模型名 + 花纹号。画在离屏 canvas 上,不碰 DOM。 */
function etchTexture(label: string, skin: Skin): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 1024
  const x = c.getContext('2d')!
  x.translate(c.width / 2, c.height / 2)
  // ⚠️沿刀身的字**朝哪个方向排**是有讲究的:静置位刀尖指向左上(屏幕转角 ≈148°),
  // 字若按「刀尖→刀柄」排,在静置位就是上下颠倒的(08-29 真截图放大才看清 —— 一开始误判成镜像,
  // 白查了两轮 UV 与面剔除)。按「刀柄→刀尖」排,静置位约 -32°,几乎是平的,最好读;
  // 切刀亮相位(刀竖直)则是自上而下,像书脊,一样读得通。两个姿态取其优。
  x.rotate(Math.PI / 2)
  x.fillStyle = '#ffffff'
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  x.font = '600 84px ui-sans-serif, system-ui, sans-serif'
  x.fillText(label.slice(0, 22), 0, -34)
  x.globalAlpha = 0.72
  x.font = '500 46px ui-monospace, monospace'
  x.fillText(`PATTERN ${String(skin.seed).padStart(3, '0')}`, 0, 52)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
