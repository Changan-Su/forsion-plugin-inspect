// 从模型 id 推出一件「藏品」的全部属性 —— 纯函数、无随机、无网络。
// 同一个模型永远是同一件皮肤(否则每次按 F 都换一把,收藏感当场没了)。

/** FNV-1a:够散、够短、跨端一致(别用 Math.random,那样同一模型每次都变)。 */
export function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 从 hash 里切一段当 0..1 的伪随机量(bit 位互不重叠,免得几个属性同涨同落)。 */
const slice01 = (h: number, shift: number, bits = 8): number =>
  ((h >>> shift) & ((1 << bits) - 1)) / ((1 << bits) - 1)

/** CS 的品质阶梯。**2026-08-29 起不再抽奖,也不由 hash 定** —— 品质 = 当前会话的思考档
 *  (Effort),见 `tierOfEffort`。七档对七档,一一对应。 */
export const TIERS = [
  { id: 'consumer', zh: '消费级', en: 'Consumer', color: '#b0c3d9', w: 22 },
  { id: 'industrial', zh: '工业级', en: 'Industrial', color: '#5e98d9', w: 20 },
  { id: 'milspec', zh: '军规级', en: 'Mil-Spec', color: '#4b69ff', w: 18 },
  { id: 'restricted', zh: '受限', en: 'Restricted', color: '#8847ff', w: 15 },
  { id: 'classified', zh: '保密', en: 'Classified', color: '#d32ce6', w: 12 },
  { id: 'covert', zh: '隐秘', en: 'Covert', color: '#eb4b4b', w: 9 },
  { id: 'extraordinary', zh: '非凡', en: 'Extraordinary', color: '#ffd700', w: 4 },
] as const

export type Tier = (typeof TIERS)[number]

/** 思考档,顺序与引擎的 THINKING_LEVELS 一致(低 → 高)。 */
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 品质 = Effort:七档思考档对七档品质,`max` 就是那把金色的「非凡」。
 *  ⚠️宿主给不出档位(旧宿主 / 还没建会话 / 引擎没报)时返回 **null** —— 面板上写「—」,
 *  不许拿哈希编一个出来:这一栏的全部意义就是「它如实对应你现在的思考档」。 */
export function tierOfEffort(effort: string | null | undefined): Tier | null {
  const i = EFFORTS.indexOf((effort ?? '') as (typeof EFFORTS)[number])
  return i < 0 ? null : TIERS[i]
}

export interface Skin {
  /** 刀身做旧程度 0..1(由模型 id 定死)。只喂材质,**不再作为「磨损度」展示** ——
   *  面板 2026-08-29 起展示的是上下文窗口 / 已用 token / 思考档这些真有用的数。 */
  float: number
  /** 刀身主色 / 辅色(HSL 推出来的一对互补色),CSS 字符串形式 —— 只给 CSS 用。 */
  primary: string
  secondary: string
  /** 同两色的 HSL 三元组(h 0..1)。**three 用这个,别喂 CSS 字符串** ——
   *  three 的 Color 解析器只认逗号形式 `hsl(h,s%,l%)`,现代空格语法它解析失败后静默留白色
   *  (症状:整把刀灰白一片,配色全丢)。08-29 真截图才发现。 */
  primaryHsl: [number, number, number]
  secondaryHsl: [number, number, number]
  /** 金属度 / 粗糙度 —— 直接喂给 three 的 MeshStandardMaterial。 */
  metalness: number
  roughness: number
  /** 花纹模板号(0..999);刻在刀身上的那行字用。 */
  seed: number
}

export function skinOf(modelId: string): Skin {
  const h = hash(modelId)
  const float = +slice01(h, 8, 10).toFixed(9)
  const hue = Math.round(slice01(h, 18, 9) * 360)
  // 做旧越重越粗糙、越不亮 —— 同一把刀的色/材质彼此对得上,不会「一身伤痕还锃亮」。
  const sat = 45 + Math.round(slice01(h, 4, 6) * 40)
  const l1 = 58 - float * 18
  const l2 = 46 - float * 12
  const h2 = (hue + 150) % 360
  return {
    float,
    primary: `hsl(${hue} ${sat}% ${l1}%)`,
    secondary: `hsl(${h2} ${sat}% ${l2}%)`,
    primaryHsl: [hue / 360, sat / 100, l1 / 100],
    secondaryHsl: [h2 / 360, sat / 100, l2 / 100],
    metalness: 0.95 - float * 0.45,
    roughness: 0.12 + float * 0.55,
    seed: h % 1000,
  }
}

/** `#rrggbb` → [h,s,l](h 0..1)。three 只吃这套三元组,别喂 CSS 字符串(见 Skin 的注解)。 */
export function hexToHsl(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const hi = Math.max(r, g, b)
  const lo = Math.min(r, g, b)
  const d = hi - lo
  const l = (hi + lo) / 2
  let h = 0
  if (d) {
    if (hi === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (hi === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [h, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l]
}

/** 用户绑定(或刀皮预设)的颜色只覆盖配色,做旧程度 / 花纹号仍由模型 id 稳定推出。
 *  `color2` 只有刀皮预设会给:不给就沿用「同色相压暗」那条自动辅色。 */
export function tintSkin(skin: Skin, color?: string, color2?: string): Skin {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return skin
  const [h, s, l] = hexToHsl(color)
  // 明确选了一种颜色时,辅色也留在同色相上、只做深浅层次;否则“选红色却长出绿刀柄”不符合颜色绑定的直觉。
  const sec = color2 && /^#[\da-f]{6}$/i.test(color2) ? hexToHsl(color2) : null
  const [h2, s2, l2] = sec ?? [h, s, Math.max(0.12, Math.min(0.72, l * 0.78))]
  return {
    ...skin,
    primary: color.toLowerCase(),
    secondary: sec ? color2!.toLowerCase() : `hsl(${Math.round(h2 * 360)} ${Math.round(s2 * 100)}% ${Math.round(l2 * 100)}%)`,
    primaryHsl: [h, s, l],
    secondaryHsl: [h2, s2, l2],
  }
}
