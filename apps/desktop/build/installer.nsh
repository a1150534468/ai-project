; VC++ 2015-2022 x64 运行库兜底：安装时静默安装，已装则跳过（避免多余 UAC）。
; vc_redist.x64.exe 由 scripts/fetch-vcredist.mjs 在打包前拉取到 build/（不入库）。
!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView lastused
  StrCmp $0 "1" vcAlreadyInstalled 0
  File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  DetailPrint "正在安装 Visual C++ 运行库..."
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart'
  vcAlreadyInstalled:
!macroend
