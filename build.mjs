// 打包 src/index.ts(含 three.js)→ 单文件 IIFE main.js。
//  - format:'iife' → 顶层无 import/export,过 Forsion 的「main.js 必须是裸 setup 体」闸;
//  - `ctx` 是自由变量,由宿主 new Function('ctx', code) 注入,esbuild 原样保留其引用;
//  - **globalName + footer 是这个插件特有的一手**:宿主要拿到清理函数(本插件在 window 上挂了
//    keydown,不摘掉的话禁用后按 F 照样弹)。裸 IIFE 的返回值会被丢掉,所以让 esbuild 把模块
//    导出赋给一个 var,再由 footer 在**函数体最外层**把它 return 出去 —— 整个 main.js 就是
//    `new Function('ctx', …)` 的函数体,footer 那行正好落在合法的 return 位置。
//  - three 内联进包(CSP 是 default-src 'self',没有 CDN 可用,也要能离线跑)。
//  - .css 当文本进包,运行时注入 <style>(插件没有构建期样式管线)。
//  - main.js 必须提交并与 src 同步(装包不构建)—— 改 src 后务必重跑本脚本。
import { build } from 'esbuild'

const dev = process.argv.includes('--dev')

const out = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  globalName: 'forsionInspect',
  footer: { js: 'return forsionInspect.dispose;' },
  platform: 'browser',
  target: 'es2022',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
  logLevel: 'info',
})

const bytes = out.metafile.outputs['main.js'].bytes
console.log(`built main.js (${(bytes / 1024).toFixed(0)} KB)`)
