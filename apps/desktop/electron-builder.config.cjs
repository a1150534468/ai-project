const updateUrl = process.env.YC_DESKTOP_UPDATE_URL ?? "https://updates.example.com/desktop/win";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.example.aiproject.desktop",
  productName: "云豆AI",
  asar: true,
  directories: {
    output: "dist",
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/pyruntime/**",
    "package.json",
  ],
  // 自带 Python 运行时：二进制必须走 extraResources（解压到 app/resources 下、不进 asar 才能执行）。
  // 由 scripts/fetch-pyruntime.mjs 预先下载到 resources/pyruntime/<平台>/。
  extraResources: [
    {
      from: "resources/pyruntime",
      to: "pyruntime",
      filter: ["**/*"],
    },
  ],
  publish: [
    {
      provider: "generic",
      url: updateUrl,
    },
  ],
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
    icon: "resources/icon.png",
    // 文件名保持 ASCII 稳定，避免中文名在 CDN/OTA latest.yml 里出问题。
    artifactName: "yun-claude-${version}-win-${arch}-setup.${ext}",
    requestedExecutionLevel: "requireAdministrator",
  },
  nsis: {
    // VC++ 运行库兜底：安装时静默安装（见 build/installer.nsh）。
    include: "build/installer.nsh",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "云豆AI",
    deleteAppDataOnUninstall: false,
  },
};
