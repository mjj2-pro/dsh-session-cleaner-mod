# dsh-session-cleaner（本地改造版）开发与维护手册

> 这份文档是给**下一个接手的人或 AI** 看的。原版作者的设计说明在 `README.md`，
> 这里只记录「本地改了什么、为什么这么改、哪些坑已经踩过」。
>
> 最后更新：2026-11-08（标题与列表性能重做）　改造者：DSH 会话内 AI　版本：`0.8.1-mod.1`

---

## 0. 三十秒读懂

**它解决的问题**：DeepSeek Harness（DSH）到 0.2.2-rc.1 为止**没有删除会话的功能**。
侧栏「⋯」菜单只有 重命名 / 分叉 / 归档。归档只是把 sessionId 塞进
`workspace.json` 的 `archivedSessionIds`，**磁盘上的日志、附件、投影缓存一个字节都不动**，
而且单向不可逆。

**它做了什么**：在「⋯」菜单里加一行红色「删除」，把会话（含子智能体整棵树）
连同记账、置顶、归档标记、投影缓存行、定时任务一起搬进插件自己的回收站；
删除前列出该会话产生的**交付物 / 中间产物**供用户逐条勾选；**文件也是搬不是删**，
恢复时会话和文件一起原路返回。回收站 15 天自动清空。

**它在哪**：

```
源码（可改）   <repo>
已安装（生效） <DSH_HOME>\profiles\desktop\local\dsh-session-cleaner
运行时数据     <DSH_HOME>\dsh-session-cleaner\trash\
               ├─ items\<sessionId>\      会话日志目录（整体 rename 过来）
               ├─ files\<sessionId>\      用户勾选删除的产出文件
               └─ meta\<sessionId>.json   快照：原路径、记账槽位、缓存行、置顶、文件清单
```

---

## 1. 项目血缘（改之前先知道这个）

本插件是基于 **jackxiao17/dsh-session-cleaner v0.7.7**（MIT）改的。
作者本人的 README 只描述行为，不描述内部实现，所以这里补上。

另外三个被参考过实现的项目（都只看思路，没有整包复制）：

| 项目 | 借鉴了什么 |
|---|---|
| `hshh603/dsh-session-purge` | `present` 之外的写作工具识别方式：`write`/`edit` 的参数名是 `file_path`，`str_replace_editor` 是 `path` |
| `xohmai/dsh-session-delete` | 删完补发 `ctx.emit("api-session/removed", id)`，避免侧栏留僵尸行 |
| `hkkz9522/dsh-session-manager` | 反例：它的 issue #53 暴露了「首帧解压超 1 MiB 就崩」，我们改成只读头尾帧绕开 |

---

## 2. 架构：两个半边

DSH 插件分 host（Node 进程内）和 client（浏览器里）两半，靠 HTTP 路由通信。

```
lib/index.js    ~2400 行   宿主半：所有文件操作、路径校验、回收站
lib/client.js   ~1700 行   浏览器半：菜单项、悬浮球、三个弹窗、语言包
```

**hook 的服务**（`inject` 数组，写在 `lib/index.js` 顶部）：

```js
export const inject = ["webServer", "workspaceRegistry", "sessions", "agents", "dshHomePath"];
```

- `webServer` —— 注册 `/session-cleaner/api/*` 路由
- `workspaceRegistry` —— 摘工作区记账、置顶、归档标记（部分要走内部状态机）
- `sessions` / `agents` —— 删活会话前先 cancel + dispose
- `dshHomePath` —— 定位 `~/.dsh`（用户装到了 `<DSH_HOME>`，所以**绝不能硬编码**）

**客户端 hook 的 slot**（`lib/client.js` 末尾的 `apply`）：

| slot | 用途 |
|---|---|
| `sidebar.workspaces.session.menu.item` | 「⋯」菜单里的红色「删除」 |
| `shell.overlay` | 悬浮球、toast、删除确认、回收站、会话管理 |
| ~~`sidebar.footer.action`~~ | **已移除**，原来那个撑满宽度的按钮遮挡界面 |

> ⚠️ `sidebar.workspaces` 是 **single 洞**，已被官方 WorkspaceBrowser 独占。
> **插件无法往侧栏里插一个自定义折叠分组**，这一点查过官方 `contract/slots.ts`，
> 别再往这个方向想。能做到「侧栏入口 + 全屏面板」就已经是上限。

---

## 3. 删除一次，到底动了哪些地方

按执行顺序（**顺序本身就是设计，别随便调换**）：

```
1. teardownLive()           取消进行中的 turn、dispose agent、flush 会话
2. captureSession()         快照：原目录、工作区槽位、投影缓存原文、置顶、归档、定时任务
3. previewSession()         读日志算出「交付物 / 中间产物」清单
4. writeMeta(prepared)      ⚠️ 先写快照，再动文件——崩溃才能对账
5. extractSession()         rename 目录 → 回收站；随后立即复核原路径已消失
6. storeSelectedFiles()     ⚠️ 必须在 5 成功之后。反过来会「文件没了、会话还在」
7. writeMeta(trashed)       更新快照为完成态
```

对应地，**恢复**是反向：先搬回子会话 → 主会话 → 还原投影缓存/置顶/归档/记账槽位
→ 再把 `files/<id>/` 里的文件搬回原路径。

**回收站条目结构**（`meta/<id>.json`）：

```jsonc
{
  "version": 3,
  "id": "session-xxx",
  "originalDir": "<DSH_HOME>\\sessions\\<project>\\session-xxx",
  "workspaceId": "...", "workspaceAnchorId": "...",   // 用来插回侧栏原位置
  "projcacheRow": "…原文…",                            // 恢复时原样写回
  "wasPinned": false, "wasArchived": false,
  "schedules": [ … ],                                  // 只抄录不删（宿主不能原样重建）
  "files": [ { "original": "…", "stored": "…", "bytes": 1234 } ],
  "descendants": [ … ],                                // 子智能体，各自一份快照
  "stage": "prepared" | "trashed" | "incomplete"
}
```

`stage` 是崩溃安全的核心：启动时 `reconcileTrash()` 按它决定「补完 / 回滚 / 收编孤儿」。

---

## 4. 已经踩过的坑（**下一个 AI 请逐条读完再动手**）

### 4.1 ⚠️ Hook 不能写在 early return 之后

**症状**：点「会话管理」按钮没反应；面板根本不出现（错误边界把它收起来了）。

**原因**：我写了

```js
if (!open) return null;          // ← 提前返回
const groups = useMemo(…);       // ← Hook 在它后面！Hook 数量随 open 变化
```

React 直接报 #310（"Rendered fewer hooks than expected"）。

**规则**：任何 `useState` / `useEffect` / `useMemo` / `useRef` 都必须在**所有
条件返回之前**。纯计算不要用 `useMemo`，直接写 IIFE 就行：

```js
const groups = (() => { … })();
```

**自检**：仓库里有 `hook-check.mjs`，改完 client.js 跑一遍：

```powershell
node hook-check.mjs
```

它会扫出「early return 之后还有 Hook」的位置。已知例外：`DeleteSessionMenuItem`
里的 `useMenuOpenState`（原版代码，触发条件几乎恒假，没有改动）。

### 4.2 ⚠️ 改完必须打一次接口，别让用户当测试员

**症状**：会话管理整个空白。

**原因**：我加了 `isBlank: !hasUserMessage` 却忘了声明 `let hasUserMessage = true;`，
`/list` 直接 500，前端 `setItems([])` 就空了。

**规则**：host 端改完，重启 DSH 后立刻：

```powershell
$base = "http://127.0.0.1:<当前端口>/session-cleaner/api"
Invoke-WebRequest "$base/health" -UseBasicParsing
Invoke-WebRequest "$base/list" -Method POST -ContentType "application/json" -Body '{}' -UseBasicParsing
```

端口号在运行时上下文里的 `Web GUI URL` 里。

### 4.3 ⚠️ 标题：日志里最后一条 `session/title` 才是权威（2026-11-08 重做）

**症状**：面板标题和你自己改的名字对不上。基线实测：166 条里 **19 条**不一致，
全是「首句截断」或更早那版自动标题。

**根因**：旧写法是「解压头 6 帧 + 从末尾往前最多回退 160 帧」。但最后一条标题
大多落在**第 6–10 帧**（重命名晚的在第 848 帧），160 帧的窗口从尾巴往前根本
够不到，于是悄悄退回头 6 帧里的第一版——**方向错了，不是扫得不够深**。

**现在的做法：两级，以日志为准。**

| 级 | 来源 | 代价 |
|---|---|---|
| 1 | 本地解压：`readHeaderAndTitle` 从末尾一直扫到第 6 帧，取最后一条 `session/title` | 实测冷启动 284 ms（166 会话、并发 16）；`mtime:size` 命中后 0 |
| 2 | 宿主投影缓存：**只补**「日志里压根没有 title 事件」的空位 | 0 |

**为什么不用 `sessionQuery.readTitleSnapshots`（重点，别重犯）**：

2026-11-08 实测：把它放进主路径后，`/list` 从 3.2 s 涨到 **4.1 s**，第二次打开
还是 3.8 s。原因是它内部要重扫整个持久化清单并冷读每个日志
（`readColdSessionLog`），比本地并发解压更慢，而且没有跨调用缓存。标题准确率
确实 100%，但把 160 帧那个 bug 修好之后本地解压同样 100%，所以这条路径净亏，
已从主路径移除（代码里留了「试过但不用」的注释）。

将来非要用（例如本地没有日志可读），死守两条（xohmai 的实战教训）：

1. **必须批量一次传全部 id**。逐条调用是准平方级——**20 个会话 60 秒都跑不完**。
2. **返回的 `title` 是 `SessionTitleSnapshot` 对象，不是字符串**，要解包成
   `.title.title`；对象直接流到客户端会变成 React 子节点（Minified #31）。

**磁盘缓存**：`<dshHome>/dsh-session-cleaner/cache/titles.json`，键是
`mtime:size`。日志只会追加，键不变就说明标题没变；这样 DSH 重启后第一次打开
面板也是毫秒级。读失败、写失败、文件损坏一律当「没有缓存」继续跑。

**标题听谁的**：听日志。用户改名时 DSH 会追加一条 `session/title`，最后一条就是
他看到的那个名字。投影缓存可能落后（实测 166 条里 9 条是旧值），所以它只用来
「填空」，绝不用来覆盖日志。

**别再做的事**：不要自己写「正文抽取」猜标题；不要把 snapshot 对象直接回前端。

### 4.4 ⚠️ 列表性能：串行解压是唯一的瓶颈（2026-11-08 实测）

**症状**：打开「会话管理」要等 3 秒多。响应只有 37 KB，不是网慢。

拆解（本机 181 个日志、64 MB）：

| 做法 | 耗时 |
|---|---|
| 只 `readFile`、不解压 | 71 ms |
| 串行解压全部日志找标题 | 3162 ms |
| 8 路并发解压 | 1668 ms |
| 本地解压 + 16 路并发 + 磁盘缓存 | **实测：冷 284 ms，热 80–93 ms** |

规则：

- 会话目录枚举串行（很便宜），**读 header 一律并发 16 路**（`mapLimit`）。
- 列表**不重复读同一个 header**：`listAllSessionDirs()` 一次读到的
  `header` / `artifact` 直接传给后面的行拼装。
- 空会话判据用文件体积：`>= 2 KB` 的会话必然发过消息，**连头 6 帧都不解**；
  只有几百字节的小文件才读头部确认（`hasUserMessage`）。
- 标题和 `bytes`（目录体积）都走同一个并发池。

**上千个会话会怎样**：路径是线性的，不是平方级。1000 个会话 = 1000 次 header 读
（并发 16）+ 1000 次缓存查询；磁盘缓存热时几百毫秒内，不会「加载半小时」。
真正的平方级陷阱只有一条：**逐条调用 `readTitleSnapshots`**。

**这一节最重要的教训**：优化前后必须**实测**。我第一版把「批量问宿主」放在
主路径——逻辑上更「正统」，实测却把 3.2 s 变成 4.1 s。**看起来更聪明的路径，
可能更慢。**

### 4.5 ⚠️ 启动时不要抢磁盘

回收站的崩溃对账和过期清理，改成**启动后 15 秒**才跑（`STARTUP_SETTLE_MS`），
两个定时器都 `unref()`。对账本来就是「下次启动时」的补救动作，晚 15 秒没有
任何正确性代价，但 DSH 启动瞬间有几十个插件在抢 I/O，这一步能少一条启动长尾。

**不要**在插件挂载时去扫描全部会话、预热标题缓存——那是把「打开面板才付的钱」
挪到「每次启动都付」。

### 4.6 ⚠️ 单帧解压上限：别用 1 MiB

DSH 的会话日志是**多帧 zstd 拼接**。`zstdDecompress(frame, { maxOutputLength: 1MiB })`
在单帧解压后超过 1 MiB 时抛 `ERR_BUFFER_TOO_LARGE`。如果外层是 `catch { continue }`，
**那一帧里的标题就被静默跳过了**——2026-11-08 排查标题问题时顺手修掉了这一处。

- 上游 hkk 的 [#53](https://github.com/hkkz9522/dsh-session-manager/issues/53) 就卡在这，**它会让整个删除面板不可用**
- 我们现在：头 6 帧用 `MAX_HEADER_BYTES`（1 MiB，只需要 header），
  倒扫标题用 `MAX_FRAME_BYTES`（16 MiB）。本机最大日志 2.3 MB、最大单帧 106 KB，余量足够
- 解压失败一律 `continue`，**单条坏会话不影响其他**

### 4.7 ⚠️ 子智能体不能出现在列表里

`origin: "subagent"` / 有 `parentSession` 的会话是父会话内部的执行单元，
DSH 侧栏从来不显示，用户也从没见过它们的名字（都是「你是资料核查员…」）。

**列表要过滤**（`listSessionsForManager` 里 `if (item.parentSession) continue`），
但**删除时要级联**（`collectDescendants`，深度 8）。

### 4.8 ⚠️ 空会话不要过滤，要标出来

只有几百字节、从没发过 `user/message` 的会话是纯垃圾，但**不要自动隐藏**——
用户要能看见并一次清掉。现在返回 `isBlank` 字段，前端打 `[空会话]` 标签，
底部有「选中 N 个空会话」。

判据：`info.size >= 2048 || 头部帧里出现 "user/message"`。
**不要用 header.blank 字段**——它经常是 undefined。

### 4.9 ⚠️ "交付物"和"中间产物"必须分开

用户原话：「它实际产出有 17 个文件，而我实际机器人交给我的交付物只有两个，
剩下的十几个我不知道它是什么东西来的」。

- **交付物** = 日志里 `tool/call` 且 `data.name === "present"`，
  参数 `{"files":[{"path":"…","description":"…"}]}`
- **中间产物** = `write` / `edit` / `str_replace_editor` 动过的其余文件

两组都列、都默认勾选（用户要求全删干净），但交付物**红色加粗 + `[交付物]` 标签**，
中间产物普通颜色 + `[中间产物]` 标签，交付物排在前面。

### 4.10 ⚠️ 文件要搬进回收站，不能 rm

早期版本直接 `rm` 了，用户反问「我删掉的会话，回头又要有用，文件怎么办」。
现在 `storeSelectedFiles` 把文件 `rename` 到 `trash/files/<sessionId>/`，
`meta.files` 记原路径，恢复时 `restoreStoredFiles` 搬回（目标已存在则跳过，不覆盖）。
跨盘才降级成 `copyFile + rm`。

### 4.11 ⚠️ 删除顺序不能反

曾经写成「先删文件 → 再搬会话目录」。如果搬目录失败（Windows 文件被占用），
**文件已经没了、会话还在**，是最坏的结果。现在的顺序见第 3 节。

### 4.12 已知限制（没修，不是忘了）

| 限制 | 说明 |
|---|---|
| `im:xxx` 会话删不掉 | `assertSessionId` 拒绝冒号。装了飞书/企微/钉钉这类 IM 插件才会遇到 |
| 批量删除不处理文件 | 逐个解压日志太慢。面板里已注明「要清文件请单个删」 |
| 大批量慢 | 一次最多 100 个，串行执行 |
| 定时任务只抄录不删 | 宿主的 `schedule` 服务不支持原样重建任务，删了回不来 |
| 标题大文件可能不准 | 超过 24 MB 的日志只读头部（不整文件倒扫），标题停在第 6 帧版本；这个结果会被磁盘缓存记住 |

---

## 5. 改动后的标准自检流程

```powershell
cd <repo>

# 1. 语法
node --check lib/index.js
node --check lib/client.js

# 2. 能否被 import
node -e "import('./lib/index.js').then(()=>console.log('ok'))"

# 3. Hook 顺序
node hook-check.mjs

# 4. 标题读取（用真实会话，路径自己换）
node t6.mjs

# 5. 部署：local 和 node_modules 两处都要写。
#    pnpm 会认为 file: 依赖“已经是最新”而跳过复制——只改 local 等于没改。
$P = "<DSH_HOME>\profiles\desktop"
Copy-Item "lib\index.js"  "$P\local\dsh-session-cleaner\lib\index.js" -Force
Copy-Item "lib\client.js" "$P\local\dsh-session-cleaner\lib\client.js" -Force
Copy-Item "lib\index.js"  "$P\node_modules\dsh-session-cleaner\lib\index.js" -Force
Copy-Item "lib\client.js" "$P\node_modules\dsh-session-cleaner\lib\client.js" -Force
# 复核两处哈希一致（True 才算部署成功）
(Get-FileHash "$P\local\dsh-session-cleaner\lib\index.js").Hash -eq `
(Get-FileHash "$P\node_modules\dsh-session-cleaner\lib\index.js").Hash

# 6. 重启 DSH 后实测耗时（端口取运行时上下文里的 Web GUI URL）
$base = "http://127.0.0.1:<端口>/session-cleaner/api"
Measure-Command { Invoke-WebRequest "$base/list" -Method POST -ContentType "application/json" -Body '{}' -UseBasicParsing } |
  Select-Object TotalMilliseconds
```

**验收标准**（2026-11-08 基线，166 个会话）：

- **标题**：与「日志里最后一条 `session/title`」逐条一致。基线 19 条错 → **实测 0 条错**（166/166）。
- **`/list`**：**实测冷启动 284 ms、热 80–93 ms**（基线 3202 ms）。
  冷启动 = 删掉 `cache/titles.json` 后第一次；热 = 之后的每一次（含 DSH 重启后）。
- 对比方法：把 `/list` 返回的 `title` 和「全量解压每个日志取最后一条 title」
  逐条比，脚本见交接日志第 21 节。**不要只数错误条数，要打印具体哪几条**，
  否则分不清「面板错」还是「你的对照脚本错」——这个坑我踩过。

**host 端改动必须重启 DSH**（Loader 按包名缓存已导入的模块）；
**client 端改动**理论上 HMR 能热更，但实测不一定，稳妥起见也重启。

---

## 6. 目录结构

```
dsh-session-cleaner/
├─ lib/
│  ├─ index.js          宿主半（全部文件操作）
│  └─ client.js         浏览器半（UI + 语言包，中英双语）
├─ locale/              插件市场详情页文案
├─ package.json         dsh.bundle.patch + dsh.client.inject
├─ cordis.patch.yml     insert 指令
├─ icon.svg
├─ hook-check.mjs       ← 新增：Hook 顺序自检
├─ DEVELOPMENT.md       ← 新增：本文档
├─ README.md            原版 README（未改动）
└─ scripts/             原版的发版 / 验证台脚本
```

---

## 7. 给下一个 AI 的三句话

1. **改完先跑 `hook-check.mjs` 和 `node --check`，再重启，再打 `/list` 接口**——
   这个项目里 90% 的「界面打不开」都是 Hook 或未定义变量，不是 DSH 的问题。
2. **别动删除顺序和第 3 节的七步**，那是崩溃安全的基础。
3. **标题别再自己扫帧了**：先问 `sessionProjections` / `sessionProjectionCache`
   （与侧栏同源、0 解压），再批量问 `sessionQuery.readTitleSnapshots(ids)`，
   最后才本地解压。详见 4.3。
