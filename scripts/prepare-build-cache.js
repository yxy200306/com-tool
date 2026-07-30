/*
 * 打包前置脚本：修复 electron-builder 在 Windows 上的 winCodeSign 解压报错。
 *
 * 原因：electron-builder 的代码签名工具包 winCodeSign-2.6.0.7z 内含 macOS 的
 * 符号链接（libcrypto.dylib 等）。Windows 普通用户没有"创建符号链接"特权时，
 * 7-Zip 解压这些条目会失败并使整个打包中止——可这些 macOS 文件在 Windows 上
 * 根本用不到。
 *
 * 做法：先让 app-builder 下载好 .7z（解压会失败，无所谓），再用 7za 排除 darwin
 * 目录重新解压到稳定缓存名 winCodeSign-2.6.0，electron-builder 见缓存已存在即跳过
 * 解压，从而无需管理员权限 / 开发者模式即可打包。
 *
 * 该脚本被配置为 `predist`，`npm run dist` 时会自动执行；幂等，可重复运行。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

const localAppData = process.env.LOCALAPPDATA ||
  path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
const stableDir = path.join(cacheRoot, 'winCodeSign-2.6.0');
const marker = path.join(stableDir, 'rcedit-x64.exe');

function log(...a) { console.log('[prepare-build-cache]', ...a); }

if (process.platform !== 'win32') {
  log('非 Windows 平台，跳过。');
  process.exit(0);
}
if (fs.existsSync(marker)) {
  log('winCodeSign 缓存已就绪，跳过。');
  process.exit(0);
}

let path7za, appBuilderPath;
try {
  path7za = require('7zip-bin').path7za;
  appBuilderPath = require('app-builder-bin').appBuilderPath;
} catch (e) {
  log('未找到 7zip-bin / app-builder-bin，请先 npm install。', e.message);
  process.exit(1);
}

// 1) 触发下载（解压会因符号链接失败，但 .7z 会留在缓存里）
log('下载 winCodeSign（镜像：' + MIRROR + '）…');
fs.mkdirSync(cacheRoot, { recursive: true });
try {
  execFileSync(appBuilderPath, ['download-artifact', '--name', 'winCodeSign'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR: MIRROR,
      // 让 app-builder 能找到 7za（即便解压失败，下载已完成）
      PATH: path.dirname(path7za) + path.delimiter + (process.env.PATH || '')
    }
  });
} catch (e) {
  log('（解压预期内失败，已忽略，继续手动解压）');
}

// 2) 找到下载好的 .7z
const archives = fs.readdirSync(cacheRoot)
  .filter((f) => f.endsWith('.7z'))
  .map((f) => path.join(cacheRoot, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!archives.length) {
  log('缓存中未找到 winCodeSign 的 .7z，下载可能失败，请检查网络/镜像。');
  process.exit(1);
}

// 3) 排除 darwin 符号链接，解压到稳定缓存名
log('解压（排除 darwin 符号链接）→ ' + stableDir);
fs.rmSync(stableDir, { recursive: true, force: true });
execFileSync(path7za, ['x', archives[0], '-o' + stableDir, '-xr!darwin', '-y'], { stdio: 'inherit' });

if (!fs.existsSync(marker)) {
  log('解压后仍缺少 rcedit-x64.exe，异常。');
  process.exit(1);
}
log('完成，winCodeSign 缓存已准备好，可正常打包。');
