// 用户自制内容的解析层:刀皮预设 `*.skin.json` 与检视动作 `*.motion.json`。
//
// 这两种文件**多半是 agent 写的**(配套技能 skills/inspect-skin、skills/inspect-motion 就是让
// agent 照着写的),所以这里按**信任边界**处理:任何一处不合规都要给出人话原因、退回内置动作,
// 绝不能让一份坏 JSON 变成「按 F 后画面一片黑」——那种症状用户永远查不出是哪个文件的错。
import type { KnifeType, Motion, Pose } from './stage'

/** 一份刀皮预设 = 刀型 + 一对配色。**没有品质字段** —— 品质那一栏现在如实对应思考档(Effort),
 *  让文件去声明品质等于允许伪造。 */
export interface SkinPreset {
  name: string
  knife: KnifeType
  /** `#rrggbb`。 */
  primary: string
  secondary?: string
  /** 库内的 `.glb` / `.gltf` 路径。**给了它就用这把真模型**,配色不再生效(导入的模型自带材质)。
   *  这条是让 agent 够得着 `.glb` 的唯一通道:模型本身 agent 写不出来,但「把这个模型用起来」
   *  是一份三行 JSON 的事。 */
  model?: string
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; zh: string; en: string }

const bad = (zh: string, en: string): Parsed<never> => ({ ok: false, zh, en })
const HEX = /^#[\da-f]{6}$/i
/** 一条轨最多这么多帧 / 这么长。上限是防呆:agent 写出 `t: 999` 时用户看到的是一句人话,
 *  而不是一把在屏幕上僵住半小时的刀。 */
const MAX_FRAMES = 400
const MAX_SECONDS = 30

function asObject(text: string): Parsed<Record<string, unknown>> {
  let v: unknown
  try { v = JSON.parse(text) } catch (e) {
    return bad(`不是合法 JSON:${(e as Error).message}`, `Invalid JSON: ${(e as Error).message}`)
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('顶层必须是一个对象 {}', 'Top level must be an object')
  return { ok: true, value: v as Record<string, unknown> }
}

export function parseSkinPreset(text: string, fallbackName: string): Parsed<SkinPreset> {
  const o = asObject(text)
  if (!o.ok) return o
  const v = o.value
  // 给了 model(真 3D 模型)时颜色用不上 → primary 可省;否则必填。
  const primary = String(v.primary ?? '').trim() || (String(v.model ?? '').trim() ? '#8b96a5' : '')
  if (!HEX.test(primary)) return bad('primary 必须是 #rrggbb 形式的颜色', 'primary must be a #rrggbb color')
  const secondary = String(v.secondary ?? '').trim()
  if (secondary && !HEX.test(secondary)) return bad('secondary 必须是 #rrggbb 形式的颜色', 'secondary must be a #rrggbb color')
  // ⚠️不认识的值**不静默降级**:`"Butterfly"`(大写)悄悄变成普通刀,是唯一一种既不生效、
  // 又不进 problems 列表的不合规输入 —— 用户会以为自己写对了。
  if (v.knife !== undefined && v.knife !== 'standard' && v.knife !== 'butterfly') {
    return bad('knife 只能是 "standard" 或 "butterfly"(区分大小写)', 'knife must be "standard" or "butterfly" (case-sensitive)')
  }
  const knife = v.knife === 'butterfly' ? 'butterfly' : 'standard'
  const model = String(v.model ?? '').trim()
  if (model && !/\.(glb|gltf)$/i.test(model)) {
    return bad('model 必须是库内的 .glb / .gltf 路径', 'model must be a vault path ending in .glb / .gltf')
  }
  return {
    ok: true,
    value: {
      name: String(v.name ?? '').trim() || fallbackName,
      knife,
      primary: primary.toLowerCase(),
      ...(secondary ? { secondary: secondary.toLowerCase() } : {}),
      ...(model ? { model } : {}),
    },
  }
}

const num3 = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [v[0] as number, v[1] as number, v[2] as number]
    : null

/** 关键帧轨的通用校验。`t` 必须**严格递增**:相等会让插值除以 0(NaN 姿态 = 刀凭空消失)。 */
function parseTrack<T>(raw: unknown, label: string, pose: (v: unknown) => T | null): Parsed<Array<{ t: number; pose: T }>> {
  if (!Array.isArray(raw)) return bad(`${label} 必须是关键帧数组`, `${label} must be an array of keyframes`)
  if (raw.length < 2) return bad(`${label} 至少要两帧(起点和终点)`, `${label} needs at least two keyframes`)
  if (raw.length > MAX_FRAMES) return bad(`${label} 超过 ${MAX_FRAMES} 帧`, `${label} exceeds ${MAX_FRAMES} keyframes`)
  const out: Array<{ t: number; pose: T }> = []
  let last = -1
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] as Record<string, unknown>
    const t = f && typeof f.t === 'number' && Number.isFinite(f.t) ? f.t : NaN
    if (!(t >= 0)) return bad(`${label} 第 ${i + 1} 帧的 t 不是 ≥0 的秒数`, `${label} frame ${i + 1}: t must be a number ≥ 0`)
    if (t <= last) return bad(`${label} 第 ${i + 1} 帧的 t 没有比上一帧大(必须严格递增)`, `${label} frame ${i + 1}: t must increase strictly`)
    last = t
    const p = pose(f)
    if (!p) return bad(`${label} 第 ${i + 1} 帧的姿态字段不合法`, `${label} frame ${i + 1}: malformed pose`)
    out.push({ t, pose: p })
  }
  if (last > MAX_SECONDS) return bad(`${label} 总时长 ${last}s 超过 ${MAX_SECONDS}s`, `${label} runs ${last}s, over the ${MAX_SECONDS}s cap`)
  return { ok: true, value: out }
}

const posePart = (v: unknown): Pose | null => {
  const f = v as Record<string, unknown>
  const p = num3(f.p)
  const r = num3(f.r)
  return p && r ? { p, r } : null
}

const handlePart = (v: unknown): { a: number; b: number } | null => {
  const f = v as Record<string, unknown>
  return typeof f.a === 'number' && Number.isFinite(f.a) && typeof f.b === 'number' && Number.isFinite(f.b)
    ? { a: f.a, b: f.b }
    : null
}

export function parseMotion(text: string): Parsed<Motion & { name: string }> {
  const o = asObject(text)
  if (!o.ok) return o
  const v = o.value
  const hand = parseTrack(v.hand, 'hand', posePart)
  if (!hand.ok) return hand
  const motion: Motion & { name: string } = { name: String(v.name ?? '').trim(), hand: hand.value }
  if (v.weapon !== undefined) {
    const weapon = parseTrack(v.weapon, 'weapon', posePart)
    if (!weapon.ok) return weapon
    motion.weapon = weapon.value
  }
  if (v.handles !== undefined) {
    const handles = parseTrack(v.handles, 'handles', handlePart)
    if (!handles.ok) return handles
    motion.handles = handles.value
  }
  return { ok: true, value: motion }
}
