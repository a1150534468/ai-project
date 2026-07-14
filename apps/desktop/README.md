# AI 助手桌面客户端（C2a 核心）

AI 助手桌面客户端是 AI agent 平台的本地执行节点，通过 WebSocket 连接后端，为用户聊天提供本地文件系统、终端、搜索等工具集。

## 架构概览

```
[用户] → Electron 桌面应用窗口
         ├─ Web UI（React/Vite）→ localhost:8090 API + WebSocket
         ├─ 主进程（daemon 管理、配对、IPC）
         └─ preload（Web ↔ IPC 隔离）

[后端] → API 服务（:8090）
         ├─ Device Service（设备注册表）
         ├─ Connector Hub（WS 设备连接管理）
         └─ Tool Dispatcher（工具路由、权限检查、执行）

[本地执行] → 9 个工具模块
             ├─ 终端执行（terminal_exec）
             ├─ 文件操作（fs_read / fs_write / fs_edit / fs_list / fs_stat / fs_glob / fs_grep / fs_mkdir / fs_move / fs_delete / fs_copy）
             └─ 所有高危操作需用户确认
```

## 开发环境搭建

### 前置条件

- Node.js 18+, pnpm 8+
- Postgres 14+ 运行中
- Redis 6+ 运行中
- macOS / Linux（C2a 暂未支持 Windows）

### Step 1：启动后端依赖

```bash
# 终端 1：API 服务（:8090，带 WS 服务）
cd /Users/xingye/Ai/ai-assistant
pnpm --filter @ai-assistant/api dev
```

预期输出：`Server running at http://localhost:8090`

### Step 2：启动 Web 前端（可选，用浏览器登录）

```bash
# 终端 2：Web UI（:5173）
pnpm --filter @ai-assistant/web dev
```

访问 http://localhost:5173 进行注册/登录。

### Step 3：启动桌面客户端开发模式

```bash
# 终端 3：桌面应用
pnpm --filter @ai-assistant/desktop dev
```

预期：Electron 窗口启动 → 自动加载 http://localhost:5173（或 http://localhost:8090/web）。

---

## 手动端到端验证（完整流程）

### 准备阶段

1. **登录账户**
   - 客户端窗口加载后跳转至登录/注册页面
   - 输入邮箱、密码完成注册或登录
   - 后端生成 `authToken`，保存至本地存储

2. **配对触发**
   - 在客户端中触发配对（如点击"配对此设备"按钮或调用 IPC `ai-assistant:pair`）
   - 后端收到配对请求 → 生成 `deviceToken` → 触发 daemon 连接
   - daemon 主进程启动 WS 连接至 `ws://localhost:8090/ws/connector`
   - daemon 向后端发送 `register` 消息，包含 deviceId、deviceName、authToken
   - 后端将设备加入在线注册表（Redis DeviceRegistry）

### 验证场景 1：文件系统操作

**目标：** 通过聊天让 AI 列举桌面文件。

```
用户消息："列出我桌面的文件"
↓
AI 响应：调用 tool.invoke → fs_list [path: ~/Desktop]
↓
后端 Tool Dispatcher：
  1. 检查用户是否有在线设备
  2. 设备在线 → 暴露全工具集（包括 fs_list）
  3. 工具调用编码成 JSON → 发送到设备 WS
↓
客户端 daemon 收到：
  1. 解析工具调用 JSON
  2. 调用 fs module → fs.readdirSync(path)
  3. 返回文件列表
↓
结果回灌至后端 → AI 理解 → 在聊天窗口显示
  "您的桌面上有：Desktop.dmg, Documents, Downloads, ..."
```

**手动验证步骤：**

1. 打开客户端，完成登录
2. 在聊天输入框输入："列出我桌面文件"
3. 观察聊天窗口：
   - AI 应该调用 `fs_list` 工具
   - 出现文件列表（真实的 ~/Desktop 内容）
   - 不应该是模拟数据

**预期结果：**
```
✓ 返回真实文件列表
✓ 聊天显示标准输出格式
✓ 无权限/不存在错误正确捕获
```

---

### 验证场景 2：文件编辑

**目标：** 让 AI 修改一个文本文件。

```
用户消息："在 ~/Desktop/test.txt 中把 'hello' 改成 'goodbye'"
↓
AI 响应：
  1. 调用 fs_read → 读取文件内容
  2. 调用 fs_edit → 执行替换
↓
客户端执行：
  1. fs_read：读取 ~/Desktop/test.txt 内容
  2. fs_edit：正则替换 hello → goodbye
  3. 返回修改后的内容
↓
AI 显示结果："已将文件中的 'hello' 改成 'goodbye'"
```

**手动验证步骤：**

1. 在 ~/Desktop 创建测试文件：
   ```bash
   echo "hello world" > ~/Desktop/test.txt
   ```

2. 在聊天中输入："在 ~/Desktop/test.txt 中把 'hello' 改成 'goodbye'"

3. 观察：
   - AI 调用 fs_read 与 fs_edit
   - 后端返回工具结果
   - 文件实际被修改

4. 验证修改：
   ```bash
   cat ~/Desktop/test.txt
   # 输出应为：goodbye world
   ```

**预期结果：**
```
✓ 文件内容正确修改
✓ 聊天显示修改结果
✓ 本地文件确实被改动
```

---

### 验证场景 3：搜索

**目标：** 让 AI 搜索代码中的 TODO。

```
用户消息："在我的项目目录中搜索所有 TODO"
↓
AI 响应：调用 fs_grep [pattern: "TODO", path: ~/Ai/ai-assistant]
↓
客户端执行：grep -r "TODO" ~/Ai/ai-assistant
↓
结果回灌，AI 总结所有 TODO 项
```

**手动验证步骤：**

1. 在聊天中输入："在 ~/Ai/ai-assistant 中搜索所有 TODO 代码注释"

2. 观察：
   - AI 调用 `fs_grep` 工具
   - 返回真实搜索结果（项目中确实存在的 TODO）
   - 聊天显示匹配行

**预期结果：**
```
✓ 搜索结果非空且正确
✓ 显示文件路径、行号、匹配内容
✓ 搜索速度合理（<5秒）
```

---

### 验证场景 4：终端执行

**目标：** 让 AI 执行系统命令。

```
用户消息："执行 echo hello，然后告诉我输出是什么"
↓
AI 响应：调用 terminal_exec [cmd: "echo hello"]
↓
客户端执行：exec("echo hello")
↓
返回：stdout = "hello\n"
↓
AI 在聊天中显示："执行结果是 'hello'"
```

**手动验证步骤：**

1. 在聊天中输入："执行 `echo 'test command'`"

2. 观察：
   - AI 调用 `terminal_exec` 工具
   - 显示命令输出："test command"

3. 尝试执行更复杂的命令：
   ```
   "执行 ls -la ~/.ssh | head -5"
   ```
   观察是否正确返回前 5 行输出。

**预期结果：**
```
✓ 命令执行并返回 stdout
✓ 执行失败时返回 stderr（如命令不存在）
✓ 超时或长时间运行的命令能被合理处理
```

---

### 验证场景 5：高危操作拦截

**目标：** 验证高危命令被正确拦截。

```
用户消息："执行 rm -rf /"
↓
后端 Tool Dispatcher 检查：高危模式匹配 → 决策 BLOCKED
↓
客户端弹出确认对话框："此操作删除系统文件，是否确认？"
↓
用户点击"取消" → 操作被中止
↓
聊天显示："由于安全原因，此操作已被拦截"
```

**高危黑名单示例（详见 src/shared/high-risk.ts）：**

```typescript
// 危险的文件删除
rm -rf /
rm -rf /System
rm -rf /Library
rm -rf /Applications

// 危险的磁盘操作
diskutil erase
dd if=/dev/random of=/dev/...

// 危险的进程杀死
killall -9 kernel
kill -9 1

// 其他风险
chmod 777 /
chown -R root /
```

**手动验证步骤：**

1. 在聊天中输入："执行 `rm -rf /tmp/important`"（安全的删除）
   - 应该执行成功（不在黑名单中）

2. 在聊天中输入："执行 `rm -rf /System`"（系统目录）
   - 应该弹出确认对话框
   - 点击"取消"：操作中止，聊天显示"已拦截"
   - 点击"继续"（如果允许）：执行，但实际不应该删除系统目录（文件权限会拒绝）

3. 在聊天中输入："执行 `killall -9 kernel`"
   - 应该弹出确认对话框
   - 取消后显示"已拦截"

**预期结果：**
```
✓ 高危操作弹出确认框
✓ 用户可以安全取消
✓ 被拦截的操作在聊天中有反馈
✓ 非高危操作不弹框
```

---

## 工具集完整列表（C2a 第一版）

| 工具 | 功能 | 参数 | 返回值 |
|------|------|------|--------|
| `terminal_exec` | 执行 shell 命令 | `cmd` (string) | `{ stdout, stderr, code }` |
| `fs_read` | 读文件 | `path` (string) | `{ content: string }` |
| `fs_write` | 写文件 | `path`, `content` | `{ success: boolean }` |
| `fs_edit` | 编辑文件（正则替换） | `path`, `pattern`, `replacement` | `{ content: string }` |
| `fs_list` | 列举目录 | `path` (string) | `{ files: [{ name, type, size }] }` |
| `fs_stat` | 获取文件属性 | `path` (string) | `{ size, mtime, isDirectory }` |
| `fs_glob` | 模式匹配 | `pattern` (string) | `{ paths: string[] }` |
| `fs_grep` | 搜索文本 | `pattern`, `path` | `{ matches: [{ file, line, content }] }` |
| `fs_mkdir` | 创建目录 | `path` (string) | `{ success: boolean }` |
| `fs_move` | 移动/重命名 | `from`, `to` | `{ success: boolean }` |
| `fs_delete` | 删除文件/目录 | `path` (string) | `{ success: boolean }` |
| `fs_copy` | 复制文件 | `src`, `dst` | `{ success: boolean }` |

**高危操作黑名单：** 所有 fs_delete / terminal_exec 涉及以下路径的会被拦截：
- 系统目录：`/System`, `/Library`, `/Applications`, `/bin`, `/sbin`, `/usr/bin`
- 危险命令：`rm -rf /`, `killall`, `dd`, `diskutil erase`
- 更多规则见 `src/shared/high-risk.ts`

---

## 架构详解

### 配对流程（IPC → WS → 注册）

```
1. 用户点击"配对"
   ↓
2. Web UI 调用 IPC (ai-assistant:pair)
   ↓
3. Main Process 响应：
   - 调用后端 POST /api/device/pair?token=<authToken>
   - 获得 deviceToken 与 deviceId
   ↓
4. daemon module 启动 WS 连接：
   - url: ws://localhost:8090/ws/connector
   - 发送 register 消息：{type: "register", deviceId, authToken, ...}
   ↓
5. 后端 Connector Hub 接收：
   - 验证 deviceId & authToken
   - 将 WS 连接记入 DeviceRegistry（Redis key: device:{deviceId}）
   - 订阅工具调用队列
   ↓
6. 聊天发送工具调用时：
   - 后端查询在线设备列表
   - 对该用户的在线设备暴露全工具集
   - 工具调用序列化 → 通过 WS 推送给 daemon
   ↓
7. daemon 接收工具调用：
   - 解析 JSON
   - 调用相应执行模块（terminal / fs / search）
   - 返回结果至后端 → 流式返回给前端
```

### 工具执行与权限检查

```
[后端 dispatcher.ts]
  1. 用户有在线设备吗？
     是 → 暴露全工具集
     否 → 不暴露任何工具
     
  2. 工具调用合法吗？（类型、参数）
     否 → 返回 tool_error
     
  3. 是高危操作吗？
     是 → 返回 HIGH_RISK_BLOCKED
        → 前端收到，Web 弹出确认框
        → 用户确认后（或取消）通知后端
        → 后端继续执行（或拒绝）
        
  4. 分发到设备：
     - 序列化工具调用 JSON
     - 通过 WS 发送至 daemon
     - 等待结果（带超时 5~10s）
     
  5. 设备返回结果：
     - daemon 执行完毕，通过 WS 返回
     - 后端接收 → 验证格式 → 流式返回前端
     - 前端解析 → AI 继续推理
```

---

## 测试覆盖

当前单元测试覆盖以下 9 个模块（共 33 个用例，全绿）：

| 模块 | 文件 | 测试数 | 覆盖内容 |
|------|------|--------|---------|
| config | `src/shared/config.test.ts` | 2 | env 加载、默认值 |
| high-risk | `src/shared/high-risk.test.ts` | 5 | 黑名单匹配 |
| pairing | `src/shared/pairing.test.ts` | 3 | 配对请求格式 |
| ws-client | `src/shared/ws-client.test.ts` | 2 | WS 连接、重连逻辑 |
| daemon | `src/shared/daemon.test.ts` | 5 | 工具调用路由 |
| fs 工具 | `src/shared/tools/fs.test.ts` | 5 | 读写、编辑、删除 |
| terminal 工具 | `src/shared/tools/terminal.test.ts` | 4 | 命令执行、超时 |
| search 工具 | `src/shared/tools/search.test.ts` | 3 | grep、glob 正确性 |
| tools/index | `src/shared/tools/index.test.ts` | 4 | 工具分发、错误处理 |

---

## 常见问题

### Q: 配对后客户端连不上 WebSocket？

**A:** 检查后端是否运行：
```bash
# 确认后端启动
pnpm --filter @ai-assistant/api dev

# 检查 WS 端点是否就绪
curl -i http://localhost:8090/health
# 应返回 200 OK

# 检查 Redis 是否就绪（设备注册表）
redis-cli ping
# 应返回 PONG
```

---

### Q: 执行文件操作时收到"权限拒绝"？

**A:** 检查文件权限：
```bash
# 查看文件属主和权限
ls -l ~/Desktop/test.txt

# 如果是只读，改为可写
chmod u+w ~/Desktop/test.txt
```

客户端使用当前用户身份执行，无法访问超过用户权限的文件。

---

### Q: 高危操作确认框出现后不消失？

**A:** 这通常是前端 UI 问题。检查：
```bash
# 查看浏览器控制台（F12）
# 是否有 JavaScript 错误？
# 点击"取消"或"继续"后，是否有网络请求？
```

刷新页面重试。

---

### Q: 搜索（fs_grep）很慢？

**A:** `fs_grep` 使用 `grep -r`，在大项目中可能很慢。优化：
- 指定搜索目录，避免根目录：`~/Ai/ai-assistant/apps` 比 `/`
- 排除大目录：`--exclude-dir=node_modules`
- 限制文件类型：`--include="*.ts"`

当前 C2a 不支持这些选项，C2b 可能会添加。

---

## Windows 安装器与自动更新（C2b）

Windows 发行使用 `electron-builder` 生成 NSIS 安装器，并用 `electron-updater`
从 S3 兼容对象存储托管的 generic 更新源读取 `latest.yml`。

```bash
# 生成 Windows x64 安装器、latest.yml 和 blockmap
AI_ASSISTANT_DESKTOP_UPDATE_URL="https://<public-oos-host>/desktop/win" pnpm --filter @ai-assistant/desktop dist:win

# 上传 dist 目录中的 .exe / .blockmap / latest.yml 到 S3 兼容对象存储
DESKTOP_RELEASE_S3_ENDPOINT="https://<endpoint>" \
DESKTOP_RELEASE_S3_BUCKET="<bucket>" \
DESKTOP_RELEASE_S3_ACCESS_KEY_ID="[REDACTED]" \
DESKTOP_RELEASE_S3_SECRET_ACCESS_KEY="[REDACTED]" \
DESKTOP_RELEASE_S3_PREFIX="desktop/win" \
pnpm --filter @ai-assistant/desktop publish:win
```

`AI_ASSISTANT_DESKTOP_UPDATE_URL` 必须与对象存储公开访问路径一致，客户端会从该 URL
拉取更新元数据。对象存储密钥只允许通过环境变量提供，不写入代码、配置或 Git。

当前 Windows 安装器未接入 CA 代码签名，用户首次安装可能看到 SmartScreen 提示。
拿到证书后再通过 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 接入签名流程。

## 后续计划（C2b+）

- **代码签名**：接入 Windows CA 证书，减少 SmartScreen 提示
- **deviceId 持久化**：系统钥匙链存储
- **Preload 隔离**：完整的 IPC 上下文隔离
- **托盘支持**：菜单栏状态与快速操作
- **通知系统**：桌面通知用户行为（配对成功、工具执行完成等）

---

## 范围说明

### ✓ 已完成（C2a）
- 多工具本地执行（终端、文件、搜索）
- 后端设备注册与工具分发
- WS 连接管理与心跳
- 高危操作拦截与用户确认
- 完整单元测试覆盖

### ✗ 暂未实现
- 工具执行的权限细粒度控制（如只读模式）
- 工具调用的审计日志
- 离线模式与本地回放
- 跨平台支持（Windows / Linux）

---

## 快速开始

```bash
# 1. 启动后端
pnpm --filter @ai-assistant/api dev

# 2. 启动前端（可选）
pnpm --filter @ai-assistant/web dev

# 3. 启动桌面客户端
pnpm --filter @ai-assistant/desktop dev

# 4. 注册账户 → 配对 → 聊天测试
```

有问题？查看 `apps/desktop/src/shared/*.test.ts` 的测试用例了解各模块用法。
