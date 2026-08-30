// 检视台 —— 像 CS 对战中那样,在**当前页面上**把手里的刀举起来耍两下。
//
// 两档(用户 2026-08-29 拍板):
//   · 短按 F  = HUD 档。右下角一层**透明、鼠标穿透**的画布,当前 Space 照常用 —— 这是 CS 的真形态
//               (对战中检视,你还看着战场)。掏刀 → 耍一遍 → 自动收刀,不常驻。
//   · 长按 F  = 面板档。拉出全屏详情页(品质=思考档 / 最大上下文 / 本会话已用 token / 皮肤箱),能拖着转。
// 由 Forsion 以 new Function('ctx', <本文件的 esbuild IIFE 产物>) 装载,故:
//  - `ctx` 是宿主注入的自由变量;
//  - 打包产物顶层不得有 import/export(esbuild format:'iife')。
//
// 三条宿主纪律,改这个文件前先读:
//  ① **全屏面板**根必须 `-webkit-app-region: no-drag` 且 append 到 body 末尾;
//     **HUD 层正相反,绝不能写 no-drag** —— 它落在 Shell 的拖窗区上,写了等于把那块
//     从拖窗区抠掉,用户从此拖不动窗口。两条都在 inspect.css 顶注里。
//  ② F 键不能注册成命令热键 —— 宿主的 installHotkeys 没有输入焦点闸,绑了 F 会在聊天框打字时触发。
//     必须自己挂 keydown,守卫含 `isComposing`(中文输入法下 e.key 是 'f' 但用户在选字)。
//  ③ 模型/Space 只能从 ctx.tangu 读,且 **ctx.tangu 在非 Tangu 宿主上整个不存在** → 一律可选链。

import css from './inspect.css'
import { parseMotion, parseSkinPreset, type SkinPreset } from './assets'
import { skinOf, tierOfEffort, tintSkin, type Skin } from './skin'
import { createStage, type KnifeType, type Motion, type Stage } from './stage'

interface TanguModel { id: string; name: string }
interface TanguSession { contextWindow: number; contextTokens: number; sessionTokens: number; effort: string | null }
declare const ctx: {
  app: {
    notify(msg: string): void
    workFolder?(): string
    listFiles?(): Promise<string[]>
    readFile?(path: string): Promise<string | null>
    writeFile?(path: string, text: string): Promise<void>
    vaultRoot?(): string | null
    reveal?(path: string): void
  }
  registerCommand(def: { id: string; title: string; keywords?: string; run(): void }): void
  registerSetting(def: { key: string; label: string; type: 'boolean'; default: boolean; description?: string }): void
  registerSettingsView?(def: { id: string; title?: string; mount(el: HTMLElement): void | (() => void) }): void
  notify?(msg: string, opts?: { level?: 'info' | 'warning' | 'error'; title?: string }): void
  getLocale?(): 'zh' | 'en'
  loadData?<T>(): Promise<T | null>
  saveData?(v: unknown): Promise<void>
  tangu?: {
    activeModel(): TanguModel | null
    models?(): TanguModel[]
    activeSpace(): string | null
    /** 旧宿主没有 → 面板上那三行(品质/上下文/已用 token)整段不画,别显示 0。 */
    session?(): TanguSession | null
    subscribe(cb: () => void): () => void
  }
}

const ZH = (ctx.getLocale?.() ?? 'zh') === 'zh'
const t = (zh: string, en: string): string => (ZH ? zh : en)

const SETTING_ANY_SPACE = 'inspectAnySpace'
const SETTING_HOTKEY_OFF = 'inspectHotkeyOff'
const readBool = (key: string): boolean => {
  // 宿主把值存成字符串,且「等于默认值 = 删键」(见 AmadeusPluginsTab)。两个开关默认都是 false。
  try { return localStorage.getItem(`plugin.inspect.${key}`) === 'true' } catch { return false }
}

ctx.registerSetting({
  key: SETTING_ANY_SPACE,
  label: t('任何 Space 都能按 F 检视', 'Allow F in every Space'),
  type: 'boolean',
  default: false,
  description: t('缺省只在 Tangu Space 生效(那里才有「当前模型」这个概念)。', 'Off = Tangu Space only, where "current model" exists.'),
})
ctx.registerSetting({
  key: SETTING_HOTKEY_OFF,
  label: t('关掉 F 快捷键(仍可用命令面板)', 'Disable the F hotkey (command palette still works)'),
  type: 'boolean',
  default: false,
})

// ── 落盘数据:模型 id → 刀型/颜色/导入模型;外加一个全局手部模型 ──────────
interface KnifeBinding {
  type?: KnifeType
  /** #rrggbb;缺省 = 继续用模型 id 算出的自动色。 */
  color?: string
  /** 刀皮预设(库内 `*.skin.json` 路径)。选了预设就由它定刀型和配色 —— 设置页会把
   *  刀型/颜色两个控件置灰,免得出现「选了预设又改颜色、看不出哪个赢」。 */
  preset?: string
  /** 自定义检视动作(库内 `*.motion.json` 路径);缺省 = 内置动作。 */
  motion?: string
  /** 只作设置页回显:模型从目录下架后也看得出这条绑定原来是谁。 */
  name?: string
}
interface Data {
  /** 模型 id → 库内 .glb 路径(没映射就用程序化生成的那把刀)。 */
  skins?: Record<string, string>
  /** 握刀的手:路径 = 用这个 glb;`null` = 不画手;缺省 = 内置那只。 */
  hand?: string | null
  /** 没有条目就是默认:普通刀 + 模型 id 自动配色。 */
  bindings?: Record<string, KnifeBinding>
}
let data: Data = {}
const dataReady = Promise.resolve(ctx.loadData?.<Data | Record<string, string>>()).then((v) => {
  if (!v || typeof v !== 'object') return
  // 1.0.x 存的是扁平的 { modelId: path };迁移成 { skins: … },别让老用户的绑定丢了。
  data = 'skins' in v || 'hand' in v || 'bindings' in v ? (v as Data) : { skins: v as Record<string, string> }
})
const modelAssetOf = (id: string): string => data.skins?.[id] ?? ''
const bindingOf = (id: string): KnifeBinding => data.bindings?.[id] ?? {}
const presetOf = (id: string): SkinPreset | null => {
  const p = bindingOf(id).preset
  return (p && lib.presets.get(p)) || null
}
const typeOfModel = (id: string): KnifeType =>
  (presetOf(id)?.knife ?? bindingOf(id).type) === 'butterfly' ? 'butterfly' : 'standard'
const skinForModel = (id: string): Skin => {
  const preset = presetOf(id)
  return preset ? tintSkin(skinOf(id), preset.primary, preset.secondary) : tintSkin(skinOf(id), bindingOf(id).color)
}
const motionForModel = (id: string): (Motion & { name: string }) | null => {
  const m = bindingOf(id).motion
  return (m && lib.motions.get(m)) || null
}
const save = (): void => { void ctx.saveData?.(data) }

// ── 用户自制内容库:工作文件夹里的 *.skin.json / *.motion.json ────────────────
// 解析结果**同步可查**(装备一把刀是零延迟的事,不能等 IO),所以在这里缓存一份;
// 文件坏了不吞:problems 收着人话原因,设置页照原样列出来 —— 否则用户改半天不知道错在哪。
const MODEL_EXT = /\.(glb|gltf)$/i
const PRESET_EXT = /\.skin\.json$/i
const MOTION_EXT = /\.motion\.json$/i
/** 一次最多读这么多份自制文件。库里可能有上万个文件,全读一遍会把开插件卡住。 */
const MAX_ASSETS = 80
interface Library {
  presets: Map<string, SkinPreset>
  motions: Map<string, Motion & { name: string }>
  problems: Array<{ path: string; why: string }>
}
let lib: Library = { presets: new Map(), motions: new Map(), problems: [] }
let libLoading: Promise<void> | null = null
/** 上次读库时的**库根**;`undefined` = 还没读过。 */
let libRoot: string | null | undefined
/** 拿不到 vaultRoot 的旧宿主用一个常量顶上:读一次就算数,不至于每次按 F 都重扫。 */
const currentRoot = (): string | null => (ctx.app.vaultRoot ? ctx.app.vaultRoot() : 'no-vaultroot-api')
/**
 * 缓存是不是该重读。⚠️**这不是优化,是正确性**:插件是在 `bootstrapEngine` 启动期同步装载的,
 * 而宿主的 vault 恢复是**懒的**(要等 Composer2 / Amadeus 视图挂载才 restoreVault)——
 * 装载那一刻 `listFiles()` 多半命中「没有活动库」而返回空数组(还不产生任何 problems,静默),
 * 于是绑定的 .skin.json / .motion.json 被整个会话忽略。按库根比对就能自然覆盖三种情况:
 * 没读过 / 读的时候库还没起来 / 用户换了库。同型事故 08-28 在青鸟收藏夹上真发生过。
 */
const libStale = (): boolean => libRoot !== currentRoot()

const baseName = (p: string): string =>
  (p.split('/').pop() || p).replace(/\.(skin|motion)\.json$/i, '').replace(/\.(glb|gltf)$/i, '')

async function refreshLibrary(): Promise<void> {
  if (libLoading) return libLoading
  libLoading = (async () => {
    const next: Library = { presets: new Map(), motions: new Map(), problems: [] }
    // 先记下这一趟读的是哪个库根:读完再取的话,中途换库会把新库根按在旧库的结果上。
    const root = currentRoot()
    const home = ctx.app.workFolder?.() ?? ''
    const all = (await ctx.app.listFiles?.()) ?? []
    // 工作文件夹优先:库大的时候上限先给插件自己的地盘。
    const hits = all.filter((p) => PRESET_EXT.test(p) || MOTION_EXT.test(p) || MODEL_EXT.test(p))
    const mine = hits.filter((p) => home && p.startsWith(`${home}/`))
    const files = [...mine, ...hits.filter((p) => !mine.includes(p))].slice(0, MAX_ASSETS)
    for (const path of files) {
      // ⚠️模型文件不读内容:它是二进制、动辄几 MB,读进来只为拿个名字纯属浪费(先于 readFile 判)。
      if (MODEL_EXT.test(path)) {
        next.presets.set(path, {
          name: baseName(path),
          knife: /butterfly|蝴蝶/i.test(path) ? 'butterfly' : 'standard',
          primary: '#8b96a5',
          model: path,
        })
        continue
      }
      // ⚠️readFile 有**两种**失败形态:读不到时返回 null(生态里踩过的头号坑),而宿主桥整个缺席时
      // 它会当场抛 TypeError —— 只接一种,另一种会让整趟 refresh 静默夭折(lib 永远停在旧值)。
      let text: string | null = null
      try { text = (await ctx.app.readFile?.(path)) ?? null } catch { text = null }
      if (text == null) { next.problems.push({ path, why: t('读不到这个文件', 'unreadable') }); continue }
      if (PRESET_EXT.test(path)) {
        const r = parseSkinPreset(text, baseName(path))
        if (r.ok) next.presets.set(path, r.value)
        else next.problems.push({ path, why: ZH ? r.zh : r.en })
      } else {
        const r = parseMotion(text)
        if (r.ok) next.motions.set(path, { ...r.value, name: r.value.name || baseName(path) })
        else next.problems.push({ path, why: ZH ? r.zh : r.en })
      }
    }
    lib = next
    libRoot = root
  })().finally(() => { libLoading = null })
  return libLoading
}

/** color input 必须是 #rrggbb;自动色在未绑定时仍要显示当前模型的真实色块。 */
const hslHex = ([h, s, l]: [number, number, number]): string => {
  const hue = (n: number): number => {
    const k = (n + h * 12) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return `#${[hue(0), hue(8), hue(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
}

/** 保存一条绑定;“普通刀 + 自动色”就是默认态,直接删条目保持落盘干净。 */
function setBinding(model: TanguModel, patch: Partial<KnifeBinding>): void {
  const cur = bindingOf(model.id)
  const next: KnifeBinding = { ...cur, ...patch, name: model.name }
  // ⚠️`{ preset: undefined }` 展开后键还在(值是 undefined),saveData 落盘会留一堆 null。
  // 统一按「等于默认值就删键」收口,顺带让「整条绑定回到默认 → 整条删掉」这个判断永远成立。
  if (next.type !== 'butterfly') delete next.type
  if (!next.color) delete next.color
  if (!next.preset) delete next.preset
  if (!next.motion) delete next.motion
  data.bindings = { ...(data.bindings ?? {}) }
  if (!next.type && !next.color && !next.preset && !next.motion) delete data.bindings[model.id]
  else data.bindings[model.id] = next
  save()
}

/** 工作文件夹的**绝对路径**(设置页要显示得出来 —— 用户/agent 得先知道往哪儿放文件)。
 *  拿不到库根(云端库 / 台架)就退回库内相对路径,不编一个假的出来。 */
function folderPath(): string {
  const home = ctx.app.workFolder?.() ?? 'Inspect'
  const root = ctx.app.vaultRoot?.() ?? ''
  return root ? `${root.replace(/\/+$/, '')}/${home}` : home
}

/** 放进文件夹的格式速查。同时兼作「把目录建出来」的载体:工作文件夹是首次写入才诞生的,
 *  而 reveal 对不存在的路径是**静默无反应** —— 先落这份 README,一步建目录 + 一步选中它。 */
const FOLDER_README = `# ${'检视台'} / Inspect

放这里的三种文件会被插件认出来:

| 后缀 | 是什么 |
| --- | --- |
| \`.glb\` / \`.gltf\` | 刀或手的 3D 模型。长按 F 的「皮肤箱」里选 |
| \`.skin.json\` | 刀皮预设(刀型 + 配色)。设置 → 插件 → 检视台里逐模型绑定 |
| \`.motion.json\` | 自定义检视动作(关键帧)。同上 |

\`\`\`json
// 例:frost.skin.json
{ "name": "霜刃", "knife": "standard", "primary": "#5ec8ff", "secondary": "#123a52" }
\`\`\`

\`\`\`json
// 例:slow-turn.motion.json —— t 是秒,p 是相机空间坐标(米),r 是欧拉角(弧度)
{
  "name": "慢转一圈",
  "hand": [
    { "t": 0,   "p": [0.54, -0.40, -1.02], "r": [0.16, -0.34, 1.02] },
    { "t": 1.2, "p": [0.34, -0.10, -0.95], "r": [0.10, -0.20, 0.14] },
    { "t": 2.6, "p": [0.54, -0.40, -1.02], "r": [0.16, -0.34, 1.02] }
  ],
  "weapon": [
    { "t": 0,   "p": [0, -0.25, 0], "r": [0, 0, 0] },
    { "t": 1.6, "p": [0, -0.25, 0], "r": [0, 6.283, 0] },
    { "t": 2.6, "p": [0, -0.25, 0], "r": [0, 6.283, 0] }
  ]
}
\`\`\`

想让 agent 代劳:让它用「检视台刀皮制作」/「检视台检视动作」这两个技能。
`

/** 打开(必要时先创建)工作文件夹。 */
async function openWorkFolder(): Promise<void> {
  const home = ctx.app.workFolder?.() ?? 'Inspect'
  const guide = `${home}/README.md`
  let target = guide
  try {
    if ((await ctx.app.readFile?.(guide)) == null) await ctx.app.writeFile?.(guide, FOLDER_README)
  } catch {
    // 写不进去(只读库 / 没有活动库)就直接试目录本身;目录也不存在的话 reveal 是**静默无反应**,
    // 所以这里必须出声 —— 一颗点了什么都不发生的按钮比没有按钮更难查。
    target = home
    ctx.notify?.(t(`建不出「${home}」文件夹,请手动在笔记库里新建。`, `Could not create "${home}" — create it manually in your vault.`), { level: 'warning' })
  }
  ctx.app.reveal?.(target)
}

ctx.registerSettingsView?.({
  id: 'model-knife-bindings',
  title: t('模型与刀皮绑定', 'Model knife bindings'),
  mount(el) {
    let disposed = false
    let catalogKey = ''
    el.classList.add('fi-binding-card')

    const catalog = (): TanguModel[] => {
      const byId = new Map<string, TanguModel>()
      for (const m of ctx.tangu?.models?.() ?? []) if (m?.id) byId.set(m.id, { id: m.id, name: m.name || m.id })
      const active = ctx.tangu?.activeModel()
      if (active?.id) byId.set(active.id, { id: active.id, name: active.name || active.id })
      for (const [id, b] of Object.entries(data.bindings ?? {})) {
        if (!byId.has(id)) byId.set(id, { id, name: b.name || id })
      }
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, ZH ? 'zh-CN' : 'en'))
    }

    const options = (items: Array<{ v: string; label: string }>, cur: string): string =>
      items.map((o) => `<option value="${escapeHtml(o.v)}"${o.v === cur ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')

    const render = (force = false): void => {
      if (disposed) return
      const models = catalog()
      const presets = [...lib.presets.entries()]
      const motions = [...lib.motions.entries()]
      // 自制内容也进 key:往文件夹里新放一份 .skin.json 后,设置页得自己长出那一项来。
      const key = [
        models.map((m) => `${m.id}\u0000${m.name}`).join('\u0001'),
        presets.map(([p, v]) => `${p}\u0000${v.name}`).join('\u0001'),
        motions.map(([p, v]) => `${p}\u0000${v.name}`).join('\u0001'),
        lib.problems.length,
      ].join('\u0002')
      if (!force && key === catalogKey) return
      catalogKey = key
      el.innerHTML = `
        <div class="fi-binding-intro">${t(
          '每个对话模型可单独绑定刀型和颜色。未绑定时仍是普通刀,颜色由模型稳定生成。',
          'Bind a knife type and color per chat model. Unbound models keep the standard knife and their stable generated color.',
        )}</div>
        <div class="fi-folder">
          <div class="fi-folder-text">
            <b>${t('刀皮 / 动作文件夹', 'Skins & motions folder')}</b>
            <small>${escapeHtml(folderPath())}</small>
            <small>${t(
              '把 .glb / .gltf(刀、手模型)、.skin.json(配色预设)、.motion.json(检视动作)放进来。',
              'Drop .glb / .gltf models, .skin.json color presets and .motion.json inspect motions here.',
            )}</small>
          </div>
          ${ctx.app.reveal ? `<button class="fi-folder-open" type="button">${t('打开文件夹', 'Open folder')}</button>` : ''}
        </div>
        ${lib.problems.length ? `<div class="fi-folder-bad">${t('这些文件没能读进来:', 'These files could not be loaded:')}${
          lib.problems.map((p) => `<div><code>${escapeHtml(p.path)}</code> — ${escapeHtml(p.why)}</div>`).join('')}</div>` : ''}
        <div class="fi-binding-head"><span>${t('模型', 'MODEL')}</span><span>${t('刀皮预设', 'PRESET')}</span><span>${
          t('刀型', 'KNIFE')}</span><span>${t('颜色', 'COLOR')}</span><span>${t('检视动作', 'MOTION')}</span></div>
        <div class="fi-binding-list">${models.length ? models.map((m) => {
          const binding = bindingOf(m.id)
          const preset = presetOf(m.id)
          const type = typeOfModel(m.id)
          const color = preset?.primary || binding.color || hslHex(skinOf(m.id).primaryHsl)
          // 选了预设 = 刀型和颜色由文件说了算,两个控件置灰。不置灰的话「改了没反应」会被当成 bug。
          const off = preset ? ' disabled' : ''
          return `<div class="fi-binding-row" data-model="${escapeHtml(m.id)}">
            <div class="fi-binding-model"><b>${escapeHtml(m.name)}</b><small>${escapeHtml(m.id)}</small></div>
            <select class="fi-binding-preset" aria-label="${t('刀皮预设', 'Skin preset')}">${options(
              [
                { v: '', label: t('◇ 不用预设', '◇ None') },
                ...presets.map(([path, v]) => ({ v: path, label: v.name })),
                // ⚠️绑定指向的文件不在库里(删了 / 改名了 / 根本没写到这个库)——**必须显示出来**。
                //   静默退回默认正是 08-29 把用户坑住的那一下:两个模型绑着一份不存在的文件,毫无提示。
                ...(binding.preset && !preset ? [{ v: binding.preset, label: `⚠️ ${t('文件已丢失', 'missing')}:${baseName(binding.preset)}` }] : []),
              ],
              binding.preset || '',
            )}</select>
            <select class="fi-binding-type" aria-label="${t('刀型', 'Knife type')}"${off}>
              <option value="standard"${type === 'standard' ? ' selected' : ''}>${t('普通刀', 'Standard')}</option>
              <option value="butterfly"${type === 'butterfly' ? ' selected' : ''}>${t('蝴蝶刀', 'Butterfly')}</option>
            </select>
            <div class="fi-binding-color">
              <input class="fi-binding-color-input" type="color" value="${escapeHtml(color)}" aria-label="${t('刀皮颜色', 'Knife color')}"${off}>
              <button class="fi-binding-auto${binding.color || preset ? '' : ' is-on'}" type="button"${off}>${t('自动', 'Auto')}</button>
            </div>
            <select class="fi-binding-motion" aria-label="${t('检视动作', 'Inspect motion')}">${options(
              [
                { v: '', label: t('◇ 内置', '◇ Built-in') },
                ...motions.map(([path, v]) => ({ v: path, label: v.name })),
                ...(binding.motion && !lib.motions.has(binding.motion) ? [{ v: binding.motion, label: `⚠️ ${t('文件已丢失', 'missing')}:${baseName(binding.motion)}` }] : []),
              ],
              binding.motion || '',
            )}</select>
          </div>`
        }).join('') : `<div class="fi-binding-empty">${t('模型目录还没有加载好。', 'The model catalog has not loaded yet.')}</div>`}</div>`
    }

    const modelFor = (target: HTMLElement): TanguModel | null => {
      const row = target.closest<HTMLElement>('.fi-binding-row')
      const id = row?.dataset.model
      if (!id) return null
      return catalog().find((m) => m.id === id) ?? { id, name: id }
    }
    const onChange = (event: Event): void => {
      const target = event.target as HTMLInputElement | HTMLSelectElement
      const model = modelFor(target)
      if (!model) return
      if (target.classList.contains('fi-binding-type')) setBinding(model, { type: target.value === 'butterfly' ? 'butterfly' : 'standard' })
      else if (target.classList.contains('fi-binding-color-input')) setBinding(model, { color: target.value.toLowerCase() })
      else if (target.classList.contains('fi-binding-preset')) setBinding(model, { preset: target.value || undefined })
      else if (target.classList.contains('fi-binding-motion')) setBinding(model, { motion: target.value || undefined })
      render(true)
    }
    const onClick = (event: Event): void => {
      const hit = event.target as HTMLElement
      if (hit.closest('.fi-folder-open')) { void openWorkFolder(); return }
      const target = hit.closest<HTMLElement>('.fi-binding-auto')
      if (!target) return
      const model = modelFor(target)
      if (!model) return
      setBinding(model, { color: undefined })
      render(true)
    }
    el.addEventListener('change', onChange)
    el.addEventListener('click', onClick)
    void dataReady.then(() => refreshLibrary()).then(() => render(true))
    const timer = window.setInterval(() => render(false), 1500)
    render(true)
    return () => {
      disposed = true
      clearInterval(timer)
      el.removeEventListener('change', onChange)
      el.removeEventListener('click', onClick)
      el.classList.remove('fi-binding-card')
    }
  },
})

const assetUrl = (vaultRel: string): string => `amadeus-asset://v/${encodeURIComponent(vaultRel)}`

// 启动就把自制内容读进来:第一次按 F 时装备是**同步**决定的,那时再去 IO 就晚了
// (症状会是「第一次按 F 用的是旧配置,第二次才对」——最难自证的那类 bug)。
void dataReady.then(() => refreshLibrary())

/** 库里所有能检视的模型文件。工作文件夹优先(那是插件自己的地盘),其余全库排在后面。 */
async function listModels(): Promise<string[]> {
  const all = (await ctx.app.listFiles?.()) ?? []
  const home = ctx.app.workFolder?.() ?? ''
  const hits = all.filter((p) => MODEL_EXT.test(p))
  const mine = hits.filter((p) => home && p.startsWith(`${home}/`))
  return [...mine, ...hits.filter((p) => !mine.includes(p))]
}

// ── 共用:把「当前该显示的刀 + 手」装进一个 stage ────────────────────────────────
/** 返回一个报错回调,拿到人话原因(HUD 档没地方显示 → 走 notify;面板档写进 .fi-err)。 */
function equip(stage: Stage, model: TanguModel, onFail: (msg: string) => void, alive: () => boolean = () => true): void {
  applyLook(stage, model, onFail)
  // 缓存过期(冷启动那次读发生在库恢复之前 / 刚换库)→ 读完再装一次。少了这一步,**短按 F 的
  // HUD 档永远不重读**(只有长按开面板或打开设置页才顺带刷新),绑定的刀皮/动作整个会话失效。
  if (libStale()) void refreshLibrary().then(() => { if (alive()) applyLook(stage, model, onFail) })
}

function applyLook(stage: Stage, model: TanguModel, onFail: (msg: string) => void): void {
  const skin = skinForModel(model.id)
  const knifeType = typeOfModel(model.id)
  stage.setKnifeType(knifeType)
  stage.setMotion(motionForModel(model.id))
  // 手:先给内置那只(同步、必定成功),再异步换成用户指定的 glb —— 别让手的加载拖住刀。
  if (data.hand === null) stage.setHand(null)
  else if (data.hand) {
    stage.setHand(stage.buildHand())
    stage.loadModel(assetUrl(data.hand)).then((o) => stage.setHand(o), () => { /* 坏文件保留内置手 */ })
  } else stage.setHand(stage.buildHand())

  // 预设里的 model 优先于皮肤箱里手选的 .glb —— 预设是「一份文件描述一把完整的刀」,
  // 而皮肤箱那份是用户点出来的旧口径,两者都在时以显式选中的预设为准。
  const path = presetOf(model.id)?.model || modelAssetOf(model.id)
  if (!path) return stage.show(stage.buildKnife(knifeType, skin, model.name))
  // orient=true:导入的刀按包围盒自动摆正(朝向各家不一,用户那把 Sketchfab 蝴蝶刀就是躺在 X 轴上的)。
  // 手模型**不能**走这条 —— 它有自己的朝向。
  stage.loadModel(assetUrl(path), true).then(
    (obj) => stage.show(obj),
    (e: Error) => {
      stage.show(stage.buildKnife(knifeType, skin, model.name))
      onFail(t('载入失败:', 'Load failed: ') + (e?.message || String(e)))
    },
  )
}

// ── HUD 档:左下角耍一遍就收 ────────────────────────────────────────────────────
let hudHandle: { close(): void } | null = null

function openHud(model: TanguModel): void {
  if (hudHandle) return
  const el = document.createElement('div')
  el.className = 'fi-hud'
  // ⚠️不写 -webkit-app-region:这层落在 ribbon 的拖窗区上,写 no-drag 会把那块从拖窗区抠掉。
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('is-in'))

  let done = false
  const teardown = (): void => {
    if (done) return
    done = true
    hudHandle = null
    el.classList.remove('is-in')
    setTimeout(() => el.remove(), 160)
  }

  let stage: Stage | null = null
  try {
    stage = createStage(el, {
      // 不镜像:CS 的持刀手本来就在右边,姿态数据就是照那份参考录像量的。
      interactive: false,  // 鼠标穿透,压根收不到事件
      autoHolster: true,   // 耍完自动收刀,不常驻
      onHolstered: () => { stage?.dispose(); teardown() },
    })
  } catch (e) {
    console.warn('[inspect] WebGL 不可用,HUD 档跳过', e)
    teardown()
    return
  }
  equip(stage, model, (msg) => ctx.notify?.(msg, { level: 'warning' }), () => !done)

  const s = stage
  hudHandle = { close: () => { void s.leave().then(() => { s.dispose(); teardown() }) } }
}

// ── 面板档:长按 F 拉出的全屏详情页 ─────────────────────────────────────────────
let openHandle: { close(): void } | null = null

function open(model: TanguModel): void {
  if (openHandle) return

  // reequip / equip 的存活判据(异步回调落地时面板可能已经关了)。
  let closing = false
  const root = document.createElement('div')
  root.className = 'fi-root'
  root.innerHTML = `
    <div class="fi-stage">
      <div class="fi-head">
        <div class="fi-name"></div>
        <div class="fi-tierbar"></div>
        <div class="fi-tier"></div>
      </div>
      <div class="fi-case">
        <h4>${t('皮肤箱', 'SKIN CASE')}</h4>
        <div class="fi-list"></div>
        <div class="fi-err" hidden></div>
      </div>
    </div>
    <div class="fi-foot">
      <div class="fi-stats"></div>
      <div class="fi-hint"></div>
    </div>`

  const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T
  // 用量/档位是**拉取式**的(见 ctx.tangu.session 的注解):开面板这一刻读一次就够 ——
  // 面板铺满整屏,开着的时候没人在打字,值不会在你眼皮底下变。
  const session = ctx.tangu?.session?.() ?? null
  const tier = tierOfEffort(session?.effort)
  root.style.setProperty('--fi-tier', tier?.color ?? '#8b96a5')
  q('.fi-name').textContent = model.name
  q('.fi-tier').textContent = tier
    ? `${ZH ? tier.zh : tier.en} · ${session!.effort}`
    : t('品质未知', 'Rarity unknown')
  // ⚠️信息条必须能**重画**:刀型/检视动作来自异步读回来的自制内容库,一次性写死会出现
  //   「3D 是蝴蝶刀 + 自定义动作,文字却写着普通刀 + 内置」——技能里的验收步骤正是看这一栏。
  const renderStats = (): void => {
  const knifeType = typeOfModel(model.id)
  const motion = motionForModel(model.id)
  q('.fi-stats').innerHTML = [
    // 品质 = 思考档。两个名字都写出来,这条对应关系自己就教会了用户。
    session ? stat(t('品质 · 思考档', 'RARITY · EFFORT'), tier
      ? `${ZH ? tier.zh : tier.en}<div class="fi-float">${escapeHtml(session.effort ?? '')}</div>`
      : '—') : '',
    session ? stat(t('最大上下文', 'CONTEXT WINDOW'), session.contextWindow
      ? `${fmtTokens(session.contextWindow)}<div class="fi-float">${session.contextWindow.toLocaleString()} tokens</div>`
      : '—') : '',
    session ? stat(t('本会话已用', 'SESSION TOKENS'), `${session.sessionTokens.toLocaleString()}<div class="fi-float">${
      t('上下文占用 ', 'context ')}${session.contextTokens.toLocaleString()}</div>`) : '',
    stat(t('刀型', 'KNIFE'), knifeType === 'butterfly' ? t('蝴蝶刀', 'Butterfly') : t('普通刀', 'Standard')),
    stat(t('检视动作', 'MOTION'), motion
      ? escapeHtml(motion.name)
      : bindingOf(model.id).motion
        ? `⚠️ ${t('文件已丢失', 'file missing')}`   // 绑着一份库里没有的文件 —— 别装作「内置」
        : t('内置', 'Built-in')),
    stat(t('标识', 'MODEL ID'), `<span class="fi-float">${escapeHtml(model.id)}</span>`),
  ].join('')
  }
  renderStats()
  q('.fi-hint').innerHTML = t(
    '点一下再看一遍 · 拖动自己转 · <kbd>F</kbd> / <kbd>Esc</kbd> 关闭 —— 短按 <kbd>F</kbd> 是在页面上直接耍刀',
    'Click to replay · drag to turn · <kbd>F</kbd> / <kbd>Esc</kbd> to close — a short <kbd>F</kbd> flourishes right on the page',
  )

  // ⚠️ 必须 append 到 body 末尾:mac 的拖窗区差集只对 DOM 顺序晚于 drag 元素的浮层生效。
  document.body.appendChild(root)
  requestAnimationFrame(() => root.classList.add('is-in'))

  // WebGL 可能压根起不来(GPU 黑名单 / 远程桌面 / 无头台架)。那时**浮层照常开**、只是没有 3D ——
  // 让整个功能连同 Esc/F 的收起一起死掉,比少一个模型难查得多。
  let stage: Stage | null = null
  try {
    stage = createStage(q('.fi-stage'))
  } catch (e) {
    q<HTMLElement>('.fi-err').textContent = t('这台机器起不了 WebGL,只能看数据。', 'WebGL unavailable here; stats only.')
    q<HTMLElement>('.fi-err').hidden = false
    console.warn('[inspect] WebGL 不可用', e)
  }
  const fail = (msg: string): void => {
    const box = q<HTMLElement>('.fi-err')
    box.textContent = msg
    box.hidden = false
  }
  /** 重新按当前绑定装备一次,并刷新皮肤箱的选中态。 */
  const reequip = (): void => {
    q<HTMLElement>('.fi-err').hidden = true
    if (stage) equip(stage, model, fail, () => !closing)
    renderStats()
    for (const el of Array.from(root.querySelectorAll('.fi-item'))) {
      const d = el as HTMLElement
      // ⚠️`data.hand === null` 是「不画手」这条真选项,不是缺省 —— `?? ''` 会把它折成
      //   「默认(程序生成)」,选了不画手却高亮在默认那行。
      const cur = d.dataset.slot === 'hand'
        ? (data.hand === null ? '__none__' : data.hand ?? '')
        : modelAssetOf(model.id)
      el.classList.toggle('is-on', d.dataset.path === cur)
    }
  }

  // 皮肤箱列表(异步填,别挡住入场动画):上面一节换刀,下面一节换手。
  void refreshLibrary().then(listModels).then((files) => {
    const list = q<HTMLElement>('.fi-list')
    const home = ctx.app.workFolder?.() ?? 'Inspect'
    const named = (f: string): string => (f.split('/').pop() || f).replace(MODEL_EXT, '')
    if (!files.length) {
      list.innerHTML = `<div class="fi-empty">${t(
        `把 <code>.glb</code> / <code>.gltf</code> 放进笔记库的「<code>${escapeHtml(home)}</code>」文件夹,这里就会列出来 —— 刀和手都能换。` +
          `同一个文件夹里的 <code>.skin.json</code>(配色预设)和 <code>.motion.json</code>(检视动作)在设置页逐模型绑定。`,
        `Drop <code>.glb</code> / <code>.gltf</code> files into <code>${escapeHtml(home)}/</code> — both the knife and the hand can be swapped. ` +
          `<code>.skin.json</code> presets and <code>.motion.json</code> motions from the same folder are bound per model in settings.`,
      )}</div>`
      return
    }
    list.innerHTML = [
      item('', t('◇ 默认(程序生成)', '◇ Default (procedural)'), 'skin'),
      ...files.map((f) => item(f, named(f), 'skin')),
      `<h4 style="margin-top:12px">${t('手部模型', 'HAND')}</h4>`,
      item('', t('◇ 默认(程序生成)', '◇ Default (procedural)'), 'hand'),
      item('__none__', t('✕ 不画手', '✕ No hand'), 'hand'),
      ...files.map((f) => item(f, named(f), 'hand')),
    ].join('')
    list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.fi-item')
      if (!btn) return
      const path = btn.dataset.path || ''
      if (btn.dataset.slot === 'hand') {
        data.hand = path === '__none__' ? null : path || undefined
      } else {
        data.skins = { ...(data.skins ?? {}) }
        if (path) data.skins[model.id] = path
        else delete data.skins[model.id]
      }
      save()
      reequip()
    })
    reequip()
  })

  reequip()

  const close = (): void => {
    if (closing) return
    closing = true
    openHandle = null
    root.classList.remove('is-in')
    const s = stage
    void (s ? s.leave() : Promise.resolve()).then(() => {
      s?.dispose()
      root.remove()
    })
  }

  // 点空白收起(点皮肤箱/信息条不收)
  root.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.fi-case, .fi-foot')) return
    if (e.target === root) close()
  })

  openHandle = { close }
}

/** 皮肤箱一行。path='' = 回到程序生成的默认;slot 区分这行是换刀还是换手。 */
const item = (path: string, label: string, slot: 'skin' | 'hand'): string =>
  `<button class="fi-item" data-slot="${slot}" data-path="${escapeHtml(path)}">${escapeHtml(label)}</button>`

/** 1200000 → 1.2M / 128000 → 128K。大数字要一眼看出量级,精确值放小字那行。 */
const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)

const stat = (label: string, value: string): string =>
  value ? `<div class="fi-stat"><b>${label}</b><span>${value}</span></div>` : ''

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ── 触发 ───────────────────────────────────────────────────────────────────────
/** 两档共用的门控:拿得到当前模型就返回它,拿不到就顺手 notify 一声。 */
function gate(): TanguModel | null {
  if (!ctx.tangu) {
    ctx.notify?.(t('这个宿主没有 Tangu 对话(检视台读不到当前模型)。', 'No Tangu chat on this host.'), { level: 'warning' })
    return null
  }
  if (!readBool(SETTING_ANY_SPACE) && ctx.tangu.activeSpace() !== 'tangu') {
    ctx.notify?.(t('先切到 Tangu Space,或在插件设置里放开限制。', 'Switch to the Tangu Space, or allow every Space in settings.'), { level: 'info' })
    return null
  }
  const model = ctx.tangu.activeModel()
  if (!model) {
    ctx.notify?.(t('还没有可用的模型 —— 模型目录没拉回来?', 'No model available yet.'), { level: 'warning' })
    return null
  }
  return model
}

/** 短按:左下角耍一遍(CS 的真形态)。已经在耍 → 提前收刀。 */
function flourish(): void {
  if (hudHandle) return hudHandle.close()
  const m = gate()
  if (m) openHud(m)
}

/** 长按 / 命令面板:全屏详情页。 */
function openPanel(): void {
  if (openHandle) return openHandle.close()
  hudHandle?.close() // 两档不同时在场
  const m = gate()
  if (m) open(m)
}

/** 用户此刻是不是在打字。少一条就会「在聊天框打个 f 当场弹出检视台」。 */
function isEditing(e: KeyboardEvent): boolean {
  if (e.isComposing || (e as KeyboardEvent & { keyCode: number }).keyCode === 229) return true // 中文输入法选字中(台架抓不到这条)
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** 长按判定门槛。短按走 HUD(零延迟,按下即耍),按住超过这个数就升级成面板档。 */
const LONG_PRESS_MS = 420
let holdTimer: number | null = null
const clearHold = (): void => {
  if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null }
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') {
    if (openHandle) { openHandle.close(); e.preventDefault() }
    else if (hudHandle) { hudHandle.close(); e.preventDefault() }
    return
  }
  if (e.key !== 'f' && e.key !== 'F') return
  if (e.metaKey || e.ctrlKey || e.altKey) return // ⌘F/Ctrl+F 是查找,别抢
  if (e.repeat) return                            // 按住不放会连发 keydown,只认第一枚
  if (readBool(SETTING_HOTKEY_OFF) || isEditing(e)) return
  // 别的全屏浮层开着时让路(命令面板/设置/市场都在 body 末尾挂 fixed 层)
  if (!openHandle && document.querySelector('.cmd-overlay, .settings-overlay, .market-overlay')) return
  e.preventDefault()
  // 面板开着时,F 就是关它 —— 别在面板上面再叠一层 HUD。
  if (openHandle) { openHandle.close(); return }
  // 先按短按处理(HUD 立刻出来,零延迟);按住超过门槛再升级成面板。
  flourish()
  clearHold()
  holdTimer = window.setTimeout(() => { holdTimer = null; openPanel() }, LONG_PRESS_MS)
}
const onKeyUp = (e: KeyboardEvent): void => {
  if (e.key === 'f' || e.key === 'F') clearHold()
}
window.addEventListener('keydown', onKey)
window.addEventListener('keyup', onKeyUp)
// 焦点被抢走(切窗口 / 弹了个原生对话框)时 keyup 收不到 → 计时器留着会凭空弹出面板。
window.addEventListener('blur', clearHold)

ctx.registerCommand({
  id: 'inspect-flourish',
  title: t('检视台:耍一下刀', 'Inspect: flourish the knife'),
  keywords: 'inspect skin cs knife 检视 耍刀 皮肤 刀 模型 jianshi',
  run: flourish,
})
ctx.registerCommand({
  id: 'inspect-panel',
  title: t('检视台:打开详情面板', 'Inspect: open the detail panel'),
  keywords: 'inspect panel skin cs 检视 面板 详情 皮肤箱 jianshi',
  run: openPanel,
})

// 模型/Space 变了而浮层还开着 → 收起(检视的是「当时那件」,留着就对不上号了)。
// 模型/Space 变了 → 两档都收(检视的是「当时那件」,留着就对不上号了)。
const offTangu = ctx.tangu?.subscribe(() => { openHandle?.close(); hudHandle?.close() })

const style = document.createElement('style')
style.textContent = css
document.head.appendChild(style)

/** 宿主的 teardown 出口 —— build.mjs 的 footer 把它 `return` 出去(见那边的注释)。
 *  ⚠️ keydown 是挂在 window 上的:不摘,禁用插件后按 F 照样弹检视台。 */
export function dispose(): void {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', clearHold)
  clearHold()
  offTangu?.()
  openHandle?.close()
  hudHandle?.close()
  style.remove()
}
