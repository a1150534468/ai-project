# 连接器自带 Python 运行时

连接器把一份 Python 运行时打包进安装包（`extraResources`），让 AI 的 `python xxx.py`
在任何客户机器上都能执行，无需客户自装 Python。

## 打包前准备（在构建机上执行一次）

```bash
node apps/desktop/scripts/fetch-pyruntime.mjs
```

该脚本会下载 Windows 嵌入式 Python 并解压到 `win/`（内含 `python.exe`）。

- Python 二进制**不提交到 git**（见 `apps/desktop/.gitignore` 的忽略规则），每次构建机拉取。
- 纯标准库脚本开箱即用，无需 pip。
- 运行时由 `src/shared/tools/pyruntime.ts` 从 `process.resourcesPath/pyruntime/win` 解析，
  并在 `runTerminal` 里前置到 PATH。

## 其它平台

如需支持 Mac/Linux，把对应的独立 Python 放到 `mac/`（`bin/python3`）或 `linux/`（`bin/python3`），
`bundledPythonBinDir()` 会自动识别。
