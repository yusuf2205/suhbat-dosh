// signAndEditExecutable is off (no code-signing tools needed), so stamp the app icon into the .exe ourselves.
const path = require('path');
module.exports = async (ctx) => {
  if (ctx.electronPlatformName !== 'win32') return;
  const { rcedit } = require('rcedit');
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  await rcedit(exe, { icon: path.join(__dirname, 'icon.ico') });
};
