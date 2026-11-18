/**
 * 自检:`node check.mjs`。四类静态断言(坏了用户立刻能看见的那种):
 *
 *  1. **构建产物**能过宿主的装载闸(顶层无 import/export、可被 new Function('ctx', …) 构造),
 *     且真的把清理函数 return 出去了(footer 那一手一旦掉了,禁用插件后按 F 还会弹)。
 *  2. **裸 ctx 装载回归**:老宿主缺 ctx.tangu / loadData / registerSetting 时 setup 不许抛 ——
 *     抛了 = 整个插件装载失败(生态铁律)。**负对照在这一条里**:把守卫拆掉必须变红。
 *  3. **宿主纪律**:浮层根声明了 no-drag、输入态守卫含 isComposing、F 键没被注册成命令热键。
 *     这三条各自都会静默出事(mac 点不动 / 打字弹窗 / 抢掉输入),纸面评审最容易漏。
 *  4. **皮肤是纯函数**:同一模型 id 两次求值必须完全一致(哈希用错成随机 = 收藏感当场没了)。
 */
import { readFileSync } from 'node:fs'
import { strict as A } from 'node:assert'

const fail = []
let TOTAL = 0
const t = (name, fn) => {
  TOTAL++
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail.push(name)
    console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const src = readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('./src/inspect.css', import.meta.url), 'utf8')

// ── 1. 构建产物 ──────────────────────────────────────────────────────────────
t('main.js 是裸 setup 体(顶层无 import/export)', () => {
  A.ok(!/^\s*(import|export)\s/m.test(main), '顶层出现了 import/export —— 宿主的 new Function 会直接抛')
})
t("main.js 语法可被 new Function('ctx', …) 构造", () => {
  new Function('ctx', main)
})
t('main.js 把清理函数 return 出去了(build.mjs 的 footer)', () => {
  A.match(main, /return forsionInspect\.dispose;?\s*$/, '尾部缺 return —— 禁用插件后 keydown 不会摘')
})
t('main.js 像是真打包过 three(改了源码要重跑 build.mjs)', () => {
  A.ok(main.length > 300_000, `产物只有 ${main.length} 字节,像是没把 three 打进去`)
})
t('manifest 与 package.json 版本一致', () => {
  A.equal(manifest.version, pkg.version)
})
t('manifest.id 与源码里的设置键前缀一致', () => {
  A.equal(manifest.id, 'inspect')
  A.match(src, /localStorage\.getItem\(`plugin\.inspect\./, '设置键前缀必须是 plugin.<manifest.id>.')
})

// ── 2. 裸 ctx 装载回归(含负对照) ────────────────────────────────────────────
/** 只给最低限度 ctx(模拟老宿主:没有 tangu / notify / loadData / getLocale)。 */
const bareCtx = () => ({
  app: { notify() {}, },
  registerCommand() {},
  registerSetting() {},
})
const stubDom = () => {
  const el = () => ({
    className: '', style: { setProperty() {} }, dataset: {}, hidden: false,
    textContent: '', innerHTML: '', classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null,
    getContext: () => null, width: 0, height: 0,
  })
  globalThis.document = {
    createElement: () => el(), head: el(), body: el(), activeElement: null,
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
  }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.requestAnimationFrame = () => 0
  globalThis.devicePixelRatio = 1
}
t('老宿主(裸 ctx,无 ctx.tangu)装载不抛,且拿得到清理函数', () => {
  stubDom()
  const dispose = new Function('ctx', main)(bareCtx())
  A.equal(typeof dispose, 'function', 'setup 没 return 出清理函数')
  dispose()
})
t('负对照:去掉 ctx.tangu 的可选链后必须炸(证明上一条不是恒绿)', () => {
  // 把源码里所有 `ctx.tangu?.` 改成 `ctx.tangu.` 再跑 —— 老宿主上必须抛。
  const broken = main.replaceAll('.tangu?.', '.tangu.')
  A.notEqual(broken, main, '产物里没找到 ctx.tangu 的可选链调用,负对照失效')
  A.throws(() => new Function('ctx', broken)(bareCtx()), '拆掉守卫却没抛 —— 这条负对照没牙')
})

// ── 3. 宿主纪律 ──────────────────────────────────────────────────────────────
t('全屏面板根声明 -webkit-app-region: no-drag(mac 拖窗区会吞掉重叠区的点击/滚轮)', () => {
  A.match(css, /\.fi-root\s*\{[^}]*-webkit-app-region:\s*no-drag/s)
})
t('HUD 层鼠标穿透(pointer-events: none)—— 耍刀时当前 Space 照常用', () => {
  A.match(css, /\.fi-hud\s*\{[^}]*pointer-events:\s*none/s)
})
t('⚠️HUD 层**没有** app-region 声明(反向纪律:写了会把左下角从拖窗区抠掉,窗口拖不动)', () => {
  const block = /\.fi-hud\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  A.ok(!/-webkit-app-region/.test(block), 'HUD 块里出现了 app-region —— 全屏面板要 no-drag,HUD 正相反')
})
t('HUD 铺满视口(不是只占一角 —— 左手要落在屏幕左下,只给右下角的话它会飘在正中)', () => {
  const block = /\.fi-hud\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  A.match(block, /position:\s*fixed/)
  A.match(block, /inset:\s*0/)
})
t('持刀在**右**、副手在**左**(用户 2026-08-29 定的;照 CS 参考录像)', () => {
  const stage = readFileSync(new URL('./src/stage.ts', import.meta.url), 'utf8')
  const rest = /const REST: Pose = \{ p: \[(-?[\d.]+)/.exec(stage)
  const off = /const OFF_HAND: Pose = \{ p: \[(-?[\d.]+)/.exec(stage)
  A.ok(rest && Number(rest[1]) > 0.2, `REST 的 x=${rest?.[1]} —— 持刀手必须在画面右侧`)
  A.ok(off && Number(off[1]) < -0.2, `OFF_HAND 的 x=${off?.[1]} —— 副手必须在画面左侧`)
})
t('切刀(deploy)是一条关键帧动作,不是一段直线插值', () => {
  const stage = readFileSync(new URL('./src/stage.ts', import.meta.url), 'utf8')
  A.match(stage, /const DRAW: Array<\{ t: number; pose: Pose \}>/)
  A.ok((stage.match(/\{ t: [\d.]+, pose:/g) || []).length >= 10, '关键帧太少,像是被简化掉了')
})
t('武器轴与主手轴分层(刀翻面不能再把手带着转圈)', () => {
  const stage = readFileSync(new URL('./src/stage.ts', import.meta.url), 'utf8')
  A.match(stage, /viewmodel\.add\(weaponPivot\)/, '武器缺少独立 weaponPivot')
  A.match(stage, /weaponPivot\.add\(current\)/, '刀没有挂在独立武器轴上')
  A.match(stage, /viewmodel\.add\(obj\)/, '主手应是 weaponPivot 的同级节点')
  A.ok(!/weaponPivot\.add\(obj\)/.test(stage), '主手被塞进武器轴了 —— 刀一转手会再次跟着转')
})
t('检视轨不含整圈旋转,时长与参考录像一致', () => {
  const stage = readFileSync(new URL('./src/stage.ts', import.meta.url), 'utf8')
  const block = /const INSPECT: Array<[\s\S]*?\n\]/.exec(stage)?.[0] ?? ''
  A.ok(block.length > 0, '找不到 INSPECT 关键帧')
  A.ok(!/TAU|Math\.PI\s*\*\s*2/.test(block), '检视轨里又出现了 2π 整圈')
  const times = [...block.matchAll(/\{ t: ([\d.]+), pose:/g)].map((m) => Number(m[1]))
  A.ok(times.at(-1) >= 5 && times.at(-1) <= 5.4, `检视时长 ${times.at(-1)}s,没有贴近录像的约 5.2s`)
})
t('副手在检视主体段退场(参考录像里只剩持刀手)', () => {
  const stage = readFileSync(new URL('./src/stage.ts', import.meta.url), 'utf8')
  A.match(stage, /phase === 'inspect'[\s\S]*offHandDrop = 0\.78/)
})
t('两档分开注册命令(短按耍刀 / 长按开面板)', () => {
  A.match(src, /id: 'inspect-flourish'/)
  A.match(src, /id: 'inspect-panel'/)
})
t('长按判定有 e.repeat 闸(按住不放会连发 keydown)', () => {
  A.match(src, /e\.repeat/)
})
t('blur 时清掉长按计时器(切窗口收不到 keyup,不清会凭空弹面板)', () => {
  A.match(src, /addEventListener\('blur', clearHold\)/)
})
t('浮层 append 到 body(DOM 顺序须晚于 Shell,no-drag 差集才生效)', () => {
  A.match(src, /document\.body\.appendChild\(root\)/)
})
t('F 键守卫含 isComposing(中文输入法选字时 e.key 也是 f)', () => {
  A.match(src, /e\.isComposing/)
  A.match(src, /keyCode === 229/)
})
t('F 键守卫排除 input / textarea / contenteditable', () => {
  for (const s of ['INPUT', 'TEXTAREA', 'isContentEditable']) A.match(src, new RegExp(s))
})
t('F 没有被注册成命令热键(宿主 installHotkeys 无输入焦点闸)', () => {
  // 找的是「传给宿主的 hotkey 字段」,不是文案里的「快捷键」——设置项标题里出现 Hotkey 是正常的。
  A.ok(!/\bhotkey\s*:/i.test(src), '给命令带了 hotkey 字段 —— 宿主热键表没有输入焦点闸,会在打字时触发')
})
t('资源 URL 走 amadeus-asset:// 且路径经 encodeURIComponent', () => {
  A.match(src, /amadeus-asset:\/\/v\/\$\{encodeURIComponent\(vaultRel\)\}/)
})
t('设置页注册逐模型刀型/颜色绑定,未绑定回落普通刀 + 自动色', () => {
  A.match(src, /registerSettingsView\?\.\(\{/)
  A.match(src, /id: 'model-knife-bindings'/)
  A.match(src, /const typeOfModel = [\s\S]{0,200}'standard'/)
  A.match(src, /tintSkin\(skinOf\(id\)/)
  A.match(src, /ctx\.tangu\?\.models\?\.\(\)/)
})
t('设置页给得出工作文件夹的**绝对路径**并能打开它(技能里的"装到哪儿"全靠这一行)', () => {
  A.match(src, /function folderPath\(\)/)
  A.match(src, /ctx\.app\.vaultRoot\?\.\(\)/, '没读库根 = 只能显示相对路径,用户照样找不到')
  A.match(src, /ctx\.app\.reveal\?\.\(/)
  // reveal 对不存在的路径是静默 no-op,工作文件夹又是首次写入才诞生 → 必须先落一份文件。
  A.match(src, /ctx\.app\.writeFile\?\.\(guide, FOLDER_README\)/, '打开文件夹前没有先把目录建出来')
})
t('设置页有刀皮预设 / 检视动作两列,且选了预设时刀型与颜色置灰', () => {
  A.match(src, /class="fi-binding-preset"/)
  A.match(src, /class="fi-binding-motion"/)
  A.match(src, /const off = preset \? ' disabled' : ''/)
  A.match(css, /\.fi-binding-row select:disabled/)
})
t('详情页信息条竖排且可换行(格子数随宿主能力变,并排会把提示行挤成一字一行的竖条)', () => {
  const foot = /\.fi-foot\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  A.match(foot, /flex-direction:\s*column/, '并排布局回来了 —— 六格信息把提示行挤没了(只有真截图看得见)')
  A.match(css, /\.fi-stats\s*\{[^}]*flex-wrap:\s*wrap/s, '信息条不换行 —— 旧宿主少三格、新宿主六格,不能假定一行放得下')
})
t('品质那一栏来自思考档(Effort),不再来自哈希', () => {
  const skin = readFileSync(new URL('./src/skin.ts', import.meta.url), 'utf8')
  A.match(skin, /export function tierOfEffort/)
  A.ok(!/pickTier/.test(skin), 'pickTier 还在 —— 品质又变回抽奖了')
  A.match(src, /tierOfEffort\(session\?\.effort\)/)
  A.match(src, /ctx\.tangu\?\.session\?\.\(\)/, 'session 必须走可选链:旧宿主上整条不存在')
})
t('面板不再展示磨损/花纹/StatTrak(用户 2026-08-29 拍板换成上下文/已用 token/Effort)', () => {
  for (const gone of ['磨损', 'StatTrak', 'EXTERIOR', 'PATTERN']) {
    A.ok(!src.includes(gone), `index.ts 里还留着「${gone}」`)
  }
  for (const gone of ['磨损', 'StatTrak', '花纹']) {
    A.ok(!manifest.description.includes(gone) && !JSON.stringify(manifest.onboarding).includes(gone),
      `manifest 文案里还写着「${gone}」—— 用户读到的是没做的功能`)
  }
  A.match(src, /最大上下文/)
  A.match(src, /本会话已用/)
})
t('自制内容随包带技能(漏拷 skills/ 是静默失败:本机全绿、用户机器上根本没有)', () => {
  for (const slug of ['inspect-skin', 'inspect-motion']) {
    const md = readFileSync(new URL(`./skills/${slug}/SKILL.md`, import.meta.url), 'utf8')
    A.match(md, /^---\nname: /, `skills/${slug}/SKILL.md 缺 frontmatter`)
    A.match(md, /^description: .{40,}$/m, `skills/${slug} 的 description 太短,agent 选不中它`)
  }
  const sh = readFileSync(new URL('./install.sh', import.meta.url), 'utf8')
  A.match(sh, /cp -R "\$HERE\/skills"/, 'install.sh 没拷 skills/')
})
t('检视动作技能写明了两条会做废的规矩(整圈要累加过 2π;t 严格递增)', () => {
  const md = readFileSync(new URL('./skills/inspect-motion/SKILL.md', import.meta.url), 'utf8')
  A.match(md, /6\.283/, '没给出 2π 的具体数值,agent 只会写"转回原位"')
  A.match(md, /严格递增/)
  A.match(md, /\[0\.54, -0\.40, -1\.02\]/, '缺静置位锚点 —— 首末帧不对齐会在两处瞬移')
  A.match(md, /0, -0\.25, 0/, '缺握把零位')
})
t('蝴蝶刀是可动的双柄结构,且只有一条单次检视轨', () => {
  const stage = readFileSync(new URL('./src/stage.ts', import.meta.url), 'utf8')
  A.match(stage, /fi-butterfly-handle-a/)
  A.match(stage, /fi-butterfly-handle-b/)
  const block = /const BUTTERFLY_INSPECT: Array<[\s\S]*?\n\]/.exec(stage)?.[0] ?? ''
  A.ok(block, '找不到 BUTTERFLY_INSPECT 时间轴')
  const times = [...block.matchAll(/\{ t: ([\d.]+), pose:/g)].map((m) => Number(m[1]))
  A.ok(times.at(-1) >= 2 && times.at(-1) <= 2.5, `单次蝴蝶刀检视应约 2.3s,实际 ${times.at(-1)}s`)
  A.equal((stage.match(/const BUTTERFLY_INSPECT:/g) || []).length, 1, '检视轨被复制了两遍')
  A.match(stage, /renderer\.domElement\.dataset\.knifeType = type/, '真 DOM 台架缺少刀型观测口')
})

// ── 4. 皮肤是纯函数 ──────────────────────────────────────────────────────────
t('皮肤是纯函数:没有随机源(同一模型必须永远是同一件藏品)', () => {
  // 先剥注释:文件顶注里就写着「别用 Math.random」,不剥的话这条恒红。
  const skin = readFileSync(new URL('./src/skin.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  A.ok(!/Math\.random|Date\.now|new Date\(/.test(skin),
    'skin.ts 里出现了随机/时间源 —— 同一个模型每次按 F 都会换一件皮肤,收藏感当场没了')
  A.match(skin, /0x811c9dc5/, '哈希不见了(FNV-1a 常量)')
})
t('自定义颜色只覆盖配色,不改品质/磨损等稳定属性', () => {
  const skin = readFileSync(new URL('./src/skin.ts', import.meta.url), 'utf8')
  const block = /export function tintSkin[\s\S]*?\n\}/.exec(skin)?.[0] ?? ''
  A.match(block, /\.\.\.skin/)
  A.match(block, /primaryHsl:/)
  A.ok(!/tier:|float:|wear:|seed:|statTrak:/.test(block), '染色不应改收藏属性')
})

// ── 5. 自制内容的校验器(真跑,不是看正则) ──────────────────────────────────
// `.skin.json` / `.motion.json` **多半是 agent 写的** → 这是信任边界。这里把 assets.ts 现编译现加载,
// 拿真输入过一遍:坏文件必须被挡住并给出人话原因,不能变成「按 F 后画面一片黑」。
// 这几条自带负对照属性 —— 校验一旦被删,下面每条 `ok === false` 的断言当场变红。
const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [new URL('./src/assets.ts', import.meta.url).pathname],
  bundle: false, format: 'esm', write: false, target: 'es2022',
})
const { parseMotion, parseSkinPreset } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const why = (r) => (r.ok ? '(通过了)' : r.zh)

t('刀皮预设:可以指向一个 .glb(agent 够得着 .glb 的唯一通道),后缀写错要拒收', () => {
  const r = parseSkinPreset('{"name":"我的刺刀","model":"检视台/bayonet.glb"}', 'x')
  A.ok(r.ok, why(r))
  A.equal(r.value.model, '检视台/bayonet.glb')
  A.equal(parseSkinPreset('{"model":"检视台/bayonet.obj"}', 'x').ok, false, '.obj 被放行了')
  // 给了 model 就不必再写 primary(导入模型自带材质)
  A.ok(parseSkinPreset('{"model":"a.gltf"}', 'x').ok)
  A.equal(parseSkinPreset('{}', 'x').ok, false, '既没 model 又没 primary,不该通过')
})
t('裸 .glb / .gltf 直接进「刀皮预设」下拉(丢进文件夹就能绑,不必先写 .skin.json)', () => {
  A.match(src, /PRESET_EXT\.test\(p\) \|\| MOTION_EXT\.test\(p\) \|\| MODEL_EXT\.test\(p\)/)
  A.match(src, /butterfly\|蝴蝶/, '没按文件名猜刀型 —— 蝴蝶刀模型会走普通刀的时间轴')
  // 5MB 的二进制不该为了拿个名字被 readFile 读进内存
  const block = /if \(MODEL_EXT\.test\(path\)\) \{[\s\S]*?continue\n\s*\}/.exec(src)?.[0] ?? ''
  A.ok(block && !/readFile/.test(block), '模型文件不该走 readFile')
  A.ok(src.indexOf('MODEL_EXT.test(path)') < src.indexOf('let text: string | null = null'), '模型判定必须早于 readFile')
})
t('绑定指向的文件不在库里时**必须显示出来**(静默退回默认正是 08-29 坑住用户的那一下)', () => {
  A.match(src, /文件已丢失/)
  A.match(src, /binding\.preset && !preset/, '设置页没给悬空的刀皮预设留可见项')
  A.match(src, /binding\.motion && !lib\.motions\.has\(binding\.motion\)/, '设置页没给悬空的检视动作留可见项')
})
t('技能把「路径只能从设置页取、别猜」写进去了(云端库在隐藏目录,猜必错且不报错)', () => {
  for (const slug of ['inspect-skin', 'inspect-motion']) {
    const md = readFileSync(new URL(`./skills/${slug}/SKILL.md`, import.meta.url), 'utf8')
    A.match(md, /Amadeus Cloud/, `skills/${slug} 没提云端库的隐藏镜像目录`)
    A.match(md, /别猜|不要猜/, `skills/${slug} 没写"别猜路径"`)
  }
  const skin = readFileSync(new URL('./skills/inspect-skin/SKILL.md', import.meta.url), 'utf8')
  A.match(skin, /"model":/, '刀皮技能没写 .glb 的接手方式')
})
t('刀皮预设:只收 #rrggbb,拿名字回落文件名', () => {
  A.equal(parseSkinPreset('{"primary":"red"}', 'x').ok, false, 'CSS 颜色名被放行了')
  A.equal(parseSkinPreset('{', 'x').ok, false, '坏 JSON 被放行了')
  A.equal(parseSkinPreset('{"primary":"#5EC8FF"}', 'frost').value.name, 'frost')
  A.equal(parseSkinPreset('{"primary":"#5EC8FF"}', 'frost').value.knife, 'standard')
  A.equal(parseSkinPreset('{"primary":"#5ec8ff","knife":"butterfly"}', 'x').value.knife, 'butterfly')
  // 品质不归文件管(那一栏如实对应 Effort)——多余字段一律不进结果。
  A.equal(parseSkinPreset('{"primary":"#5ec8ff","tier":"covert"}', 'x').value.tier, undefined)
})

const frame = (t0, y) => ({ t: t0, p: [0.5, y, -1], r: [0, 0, 0] })
t('检视动作:合法轨通过,时长由末帧决定', () => {
  const r = parseMotion(JSON.stringify({ name: 'spin', hand: [frame(0, -0.4), frame(2.5, -0.1)] }))
  A.ok(r.ok, why(r))
  A.equal(r.value.hand.at(-1).t, 2.5)
  A.equal(r.value.weapon, undefined) // 没给 weapon = 刀在手里不动,不该凭空造一条
})
t('检视动作:t 不递增必须被挡(相等会除以 0 → 刀当场消失)', () => {
  const r = parseMotion(JSON.stringify({ hand: [frame(0, -0.4), frame(0, -0.1)] }))
  A.equal(r.ok, false, 't 相等被放行了')
  A.match(r.zh, /递增/)
})
t('检视动作:少于两帧 / 姿态不是三元组 / 超时长上限,一律挡下并说人话', () => {
  A.equal(parseMotion('{"hand":[{"t":0,"p":[0,0,0],"r":[0,0,0]}]}').ok, false, '单帧被放行了')
  A.equal(parseMotion('{"hand":[{"t":0,"p":[0,0],"r":[0,0,0]},{"t":1,"p":[0,0,0],"r":[0,0,0]}]}').ok, false, '两元组被放行了')
  A.equal(parseMotion(JSON.stringify({ hand: [frame(0, 0), frame(99, 0)] })).ok, false, '99s 被放行了')
  A.equal(parseMotion('{"hand":"nope"}').ok, false, '字符串当轨被放行了')
  A.equal(parseMotion('[]').ok, false, '数组当顶层被放行了')
})
t('检视动作:整圈(欧拉角累加过 2π)必须原样保留,不许被"归一化"', () => {
  const r = parseMotion(JSON.stringify({
    hand: [frame(0, -0.4), frame(1.6, -0.1)],
    weapon: [{ t: 0, p: [0, -0.25, 0], r: [0, 0, 0] }, { t: 1.6, p: [0, -0.25, 0], r: [0, 6.283, 0] }],
  }))
  A.ok(r.ok, why(r))
  A.equal(r.value.weapon.at(-1).pose.r[1], 6.283, '把 2π 折回 0 = 整圈动作全废')
})
t('检视动作:蝴蝶刀 handles 轨同样校验(a/b 必须是有限数)', () => {
  const base = { hand: [frame(0, -0.4), frame(1, -0.1)] }
  A.equal(parseMotion(JSON.stringify({ ...base, handles: [{ t: 0, a: 0, b: 0 }, { t: 1, a: 6.283, b: -6.283 }] })).ok, true)
  A.equal(parseMotion(JSON.stringify({ ...base, handles: [{ t: 0, a: 0 }, { t: 1, a: 1, b: 0 }] })).ok, false, '缺 b 被放行了')
})

// ── 6. 导入模型的自动摆正(真跑 three,不是看正则) ───────────────────────────
// 导入的 .glb 朝向各家不一(用户那把 Sketchfab 蝴蝶刀躺在 X 轴上)。这条直接构一个「躺着的刀」
// 喂进去,断言出来是立着的、刀柄朝下 —— 摆正逻辑一旦退化当场变红。
// ⚠️必须与 orientAsKnife **共用同一份 three**:分别 import 两份的话 Box3/Group 是两套类,
// 混用时的失败是静默的(包围盒算出空)。所以用一个 stdin 入口把两者打进同一个包。
const stageBundle = await build({
  stdin: {
    contents: "export { orientAsKnife } from './src/stage.ts'\nexport * as THREE from 'three'\n",
    resolveDir: new URL('.', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true, format: 'esm', write: false, target: 'es2022', platform: 'browser',
})
const { orientAsKnife, THREE } = await import(
  `data:text/javascript;base64,${Buffer.from(stageBundle.outputFiles[0].text).toString('base64')}`
)

/** 一把「躺在 X 轴上」的刀:刀身细长在 +X,刀柄粗短在 -X(与用户那把 Sketchfab 模型同形)。 */
const lyingKnife = (handleName = 'handle') => {
  const g = new THREE.Group()
  const blade = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.30, 0.06))
  blade.position.x = 0.9
  blade.name = 'blade'
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.42, 0.12))
  handle.position.x = -0.55
  handle.name = handleName
  g.add(blade, handle)
  return g
}
const sizeOf = (o) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3())
const handleCenterY = (o) => {
  let y = null
  o.updateMatrixWorld(true)
  o.traverse((n) => { if (/handle/i.test(n.name)) y = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()).y })
  return y
}

t('导入模型:躺在 X 轴上的刀会被立起来(最长轴 → Y,最薄轴 → Z)', () => {
  const out = orientAsKnife(lyingKnife())
  const s = sizeOf(out)
  A.ok(s.y > s.x && s.y > s.z, `摆正后 size=${[s.x, s.y, s.z].map((v) => v.toFixed(2))} —— 最长的一维必须落在 Y`)
  A.ok(s.z <= s.x + 1e-6, `最薄的一维必须落在 Z(现在 z=${s.z.toFixed(2)} x=${s.x.toFixed(2)})`)
})
t('导入模型:刀柄朝下(认 handle 命名;Sketchfab / Blender 导出几乎都带)', () => {
  A.ok(handleCenterY(orientAsKnife(lyingKnife())) < 0, '刀柄跑到上面去了 —— 会变成"倒着握"')
})
t('导入模型:没有 handle 命名时退回「厚的那半是刀柄」,仍然朝下', () => {
  A.ok(handleCenterY(orientAsKnife(lyingKnife('grip_unnamed_x'))) === null, '这条用例本身要求没有 handle 命名')
  const out = orientAsKnife(lyingKnife('grip_unnamed_x'))
  // 厚的那半(原 -X 端)应落在下面:量它的中心 y
  out.updateMatrixWorld(true)
  let y = null
  out.traverse((n) => { if (n.name === 'grip_unnamed_x') y = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()).y })
  A.ok(y !== null && y < 0, `厚端应朝下,实际 y=${y}`)
})
t('导入的**手**模型不走摆正(手有自己的朝向)', () => {
  A.match(src, /stage\.loadModel\(assetUrl\(data\.hand\)\)/, '手的加载不该传 orient')
  A.match(src, /stage\.loadModel\(assetUrl\(path\), true\)/, '刀的加载必须传 orient=true')
})

// ── 5. 存过却读不出来(宿主 2026-11-17 起 loadData reject,code = 'plugin-data-unreadable')──────────────
// 不许拿 `{}` 写盘(会把用户的整份绑定盖掉);改绑定 / 换刀 / 换手拒掉并再提示一次;刀皮库照常加载、设置页照常画。
// 读还没回来时改的绑定等读完再改、再存。负对照:这一节拷到 origin/main 的检出里跑,旧代码的未处理 reject 也记成红。
{
  const ta = async (name, fn) => {
    TOTAL++
    try {
      await fn()
      console.log(`PASS  ${name}`)
    } catch (e) {
      fail.push(name)
      console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
    }
  }
  let unhandled = 0
  process.on('unhandledRejection', () => { unhandled++ })
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }
  const unreadable = () => Object.assign(new Error('plugin-data-unreadable'), { code: 'plugin-data-unreadable', reason: 'invalid-json' })
  const HAN = /[㐀-鿿]/
  const mk = (tag = 'div') => {
    const handlers = new Map()
    const cache = new Map()
    const e = {
      tagName: String(tag).toUpperCase(), className: '', style: { setProperty() {}, cssText: '' }, dataset: {}, hidden: false,
      textContent: '', innerHTML: '', children: [],
      classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)) }, remove(...c) { c.forEach((x) => this._s.delete(x)) }, toggle() {}, contains(c) { return this._s.has(c) } },
      appendChild(c) { e.children.push(c); return c }, remove() {}, setAttribute() {},
      addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn) },
      removeEventListener(type, fn) { handlers.get(type)?.delete(fn) },
      fire(type, ev = {}) { for (const fn of [...(handlers.get(type) ?? [])]) fn({ type, preventDefault() {}, stopPropagation() {}, ...ev }) },
      querySelector(sel) { if (!cache.has(sel)) cache.set(sel, mk()); return cache.get(sel) },
      querySelectorAll: () => [], closest: () => null, getContext: () => null, width: 0, height: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    }
    return e
  }
  const boot = ({ locale = 'zh', loadData } = {}) => {
    globalThis.document = {
      createElement: (tag) => mk(tag), createElementNS: (_ns, tag) => mk(tag), head: mk('head'), body: mk('body'), activeElement: null,
      addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    }
    globalThis.window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 0, setTimeout: () => 0 }
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
    globalThis.requestAnimationFrame = () => 0
    globalThis.devicePixelRatio = 1
    const got = { notes: [], saves: [], views: [], cmds: [], listed: 0 }
    const model = { id: 'gpt-x', name: 'GPT X' }
    const ctx = {
      app: { notify() {}, workFolder: () => 'Inspect', vaultRoot: () => '/v', readFile: async () => null, listFiles: async () => { got.listed++; return ['Inspect/a.glb'] } },
      registerCommand: (c) => got.cmds.push(c), registerSetting() {}, registerSettingsView: (v) => got.views.push(v),
      notify: (m, o) => got.notes.push({ m, level: o?.level }),
      getLocale: () => locale,
      saveData: async (v) => { got.saves.push(JSON.parse(JSON.stringify(v))) },
      tangu: { activeModel: () => model, models: () => [model], activeSpace: () => 'tangu', subscribe: () => () => {} },
      ...(loadData ? { loadData } : {}),
    }
    got.dispose = new Function('ctx', main)(ctx)
    got.warnings = () => got.notes.filter((n) => n.level === 'warning' && !/WebGL/.test(n.m))
    /** 设置页:挂上;改一下这个模型的刀型 / 点「自动」色。 */
    got.settings = () => {
      const el = mk()
      const off = got.views[0]?.mount?.(el)
      const row = { dataset: { model: model.id } }
      return {
        el, off,
        setType: (v) => el.fire('change', { target: { value: v, classList: { contains: (c) => c === 'fi-binding-type' }, closest: (sel) => (sel === '.fi-binding-row' ? row : null) } }),
        autoColor: () => el.fire('click', { target: { closest: (sel) => (sel === '.fi-binding-auto' ? { closest: (s2) => (s2 === '.fi-binding-row' ? row : null) } : null) } }),
      }
    }
    /** 长按 F 的面板:打开,在皮肤箱里点一项。 */
    got.panelPick = async (path, slot) => {
      got.cmds.find((c) => c.id === 'inspect-panel')?.run()
      await settle()
      const root = globalThis.document.body.children.at(-1)
      root?.querySelector('.fi-list')?.fire('click', { target: { closest: () => ({ dataset: { path, slot } }) } })
      await settle()
      return root
    }
    return got
  }
  const realWarn = console.warn
  console.warn = () => {}

  await ta('读不出来:启动时提示一次(中文、不写路径),没有未处理的 reject,刀皮库照常加载', async () => {
    const before = unhandled
    const g = boot({ loadData: async () => { throw unreadable() } })
    await settle()
    A.equal(unhandled - before, 0, '未处理的 reject —— dataReady 断了,刀皮库与设置页都起不来')
    A.ok(g.listed >= 1, '刀皮库没加载(listFiles 一次都没调)')
    A.equal(g.warnings().length, 1, JSON.stringify(g.notes))
    A.match(g.warnings()[0].m, /读不出已保存的刀皮绑定/)
    A.ok(!/\/v\/|\.json/.test(g.warnings()[0].m), '提示里不该写路径')
    A.equal(g.saves.length, 0)
    g.dispose?.()
  })
  await ta('读不出来:设置页照常画出、带说明、控件置灰;改刀型 / 点「自动」不写盘,再提示', async () => {
    const g = boot({ loadData: async () => { throw unreadable() } })
    await settle()
    const s = g.settings()
    await settle()
    A.match(s.el.innerHTML, /fi-binding-row/, '设置页没画出绑定表')
    A.match(s.el.innerHTML, /读不出已保存的刀皮绑定/, '设置页上没有说明')
    A.match(s.el.innerHTML, /class="fi-binding-preset"[^>]*disabled/, '预设下拉没置灰')
    A.match(s.el.innerHTML, /class="fi-binding-type"[^>]*disabled/, '刀型下拉没置灰')
    s.setType('butterfly')
    s.autoColor()
    await settle()
    A.equal(g.saves.length, 0, `写盘了:${JSON.stringify(g.saves)}`)
    A.equal(g.warnings().length, 3, `每次被拒都该再提示:${JSON.stringify(g.notes)}`)
    s.off?.()
    g.dispose?.()
  })
  await ta('读不出来:面板皮肤箱换刀不写盘,皮肤箱里写一句', async () => {
    const g = boot({ loadData: async () => { throw unreadable() } })
    await settle()
    const root = await g.panelPick('Inspect/a.glb', 'skin')
    A.equal(g.saves.length, 0, `写盘了:${JSON.stringify(g.saves)}`)
    A.match(root?.querySelector('.fi-err')?.textContent ?? '', /读不出已保存的刀皮绑定/)
    A.equal(g.warnings().length, 2, JSON.stringify(g.notes))
    g.dispose?.()
  })
  await ta('读不出来(英文界面):提示是英文、不含汉字', async () => {
    const g = boot({ locale: 'en', loadData: async () => { throw unreadable() } })
    await settle()
    const m = g.warnings()[0]?.m ?? ''
    A.match(m, /could not be read/)
    A.ok(!HAN.test(m), m)
    g.dispose?.()
  })
  await ta('没存过(loadData → null,旧宿主读不出来也是这样):改绑定、面板换刀照常写盘,不提示', async () => {
    const g = boot({ loadData: async () => null })
    await settle()
    const s = g.settings()
    await settle()
    s.setType('butterfly')
    await settle()
    A.equal(g.saves.length, 1, JSON.stringify(g.saves))
    A.equal(g.saves[0].bindings?.['gpt-x']?.type, 'butterfly')
    await g.panelPick('Inspect/a.glb', 'skin')
    A.equal(g.saves.length, 2, `面板换刀没写盘(探针看不见写盘的话,上面那条「不写盘」是空话):${JSON.stringify(g.saves)}`)
    A.equal(g.saves[1].skins?.['gpt-x'], 'Inspect/a.glb')
    A.equal(g.warnings().length, 0, JSON.stringify(g.notes))
    s.off?.()
    g.dispose?.()
  })
  await ta('别的 reject(不带 plugin-data-unreadable 码):当没读到、照常写盘、不提示,也不留未处理的 reject', async () => {
    const before = unhandled
    const g = boot({ loadData: async () => { throw new Error('boom') } })
    await settle()
    A.equal(unhandled - before, 0, '未处理的 reject')
    A.ok(g.listed >= 1, '刀皮库没加载')
    const s = g.settings()
    await settle()
    s.setType('butterfly')
    await settle()
    A.equal(g.saves.length, 1, JSON.stringify(g.saves))
    A.equal(g.warnings().length, 0, JSON.stringify(g.notes))
    s.off?.()
    g.dispose?.()
  })
  await ta('绑定还在读的时候就改了:等读完再存,存下的是「原来的 + 这次改的」', async () => {
    let release
    const g = boot({ loadData: () => new Promise((r) => { release = r }) })
    await settle()
    const s = g.settings()
    s.setType('butterfly')
    await settle()
    A.equal(g.saves.length, 0, `读回来之前就写盘了:${JSON.stringify(g.saves)}`)
    release?.({ hand: null, skins: { other: 'Inspect/b.glb' }, bindings: { other: { color: '#112233', name: 'Other' } } })
    await settle()
    A.equal(g.saves.length, 1, JSON.stringify(g.saves))
    const last = g.saves[0]
    A.equal(last.hand, null, '原来的「不画手」丢了')
    A.equal(last.skins?.other, 'Inspect/b.glb', '原来的刀模型绑定丢了')
    A.equal(last.bindings?.other?.color, '#112233', '原来的绑定丢了')
    A.equal(last.bindings?.['gpt-x']?.type, 'butterfly', '这次改的没存上')
    s.off?.()
    g.dispose?.()
  })
  await ta('读还没回来时改的绑定,插件先被卸载(禁用 / 重载)了:读回来后不再写盘(免得旧快照盖掉新实例刚存的)', async () => {
    let release
    const g = boot({ loadData: () => new Promise((r) => { release = r }) })
    await settle()
    const s = g.settings()
    s.setType('butterfly')
    s.off?.()
    g.dispose?.()
    release?.({ bindings: { other: { color: '#112233', name: 'Other' } } })
    await settle()
    A.equal(g.saves.length, 0, `卸载后还写盘了:${JSON.stringify(g.saves)}`)
  })
  console.warn = realWarn
}

console.log(`\n${TOTAL - fail.length}/${TOTAL} 通过`)
if (fail.length) {
  console.log('未通过:' + fail.join(' / '))
  process.exit(1)
}
