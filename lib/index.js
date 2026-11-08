/**
 * dsh-session-cleaner — Host half.
 *
 * Cordis plugin that adds a true "delete" for DSH sessions, reachable from
 * the sidebar session "..." menu via the client half (lib/client.js).
 *
 * Two-step lifecycle (the client uses both; nothing disappears irreversibly
 * without a second, explicit action):
 *   delete → move the session into this plugin's own recycle bin (reversible)
 *   purge  → permanently remove a binned session and everything it left behind
 *
 * A session's descendants move with it. DSH cascades agent disposal from a
 * parent to its children, but a child session's log directory, workspace
 * accounting and projection-cache row survive the parent on their own, so the
 * plugin discovers them the way the host does — a stored header carrying
 * `origin: 'subagent'` and `parentSession: <id>` — and takes the whole family
 * to the bin, back again, or out for good together.
 *
 * Live-session policy (v0.2.0 and later): a session whose agent is running a
 * turn is NOT refused. The running turn is cancelled, the agent fiber is
 * disposed with a bounded wait, and the session entry is flushed and detached
 * so every connected client drops its row (session/disposed). Deleting a live
 * session therefore ends an in-flight answer; the conversation stays
 * recoverable from the bin.
 *
 * What moving one session to the bin removes:
 *   1. the session artifact directory  <dshHome>/sessions/<proj>/<id>/
 *      renamed into <dshHome>/dsh-session-cleaner/trash/items/<id>/ (same-volume
 *      rename, atomic), never copied.
 *   2. workspace accounting   workspaceRegistry: the owning record's ordered
 *      sessionIds slot is detached, the id is dropped from the global
 *      archivedSessionIds set AND from pinnedSessionIds — a dangling pin would
 *      otherwise outlive the session it names.
 *   3. the projection cache row   <dshHome>/storages/session_projcache/
 *      sessions/<id>.json, plus any <id>.json.bak.* left behind by the host's
 *      backup-and-skip path. Removed through the host's own cache service when
 *      it exposes one, then verified on disk.
 *   4. schedules bound to the session, removed through the host `schedule`
 *      service so a timer cannot fire into a session that now lives in the bin.
 *
 * Every one of 1-4 is snapshotted into trash/meta/<id>.json (artifact
 * directory, workspace id/path + slot index, projection-cache row verbatim,
 * pin state, bound schedule records) so a restore puts the session back where
 * it was: same directory, same sidebar position, same cache row, same pin,
 * same timers. A session's descendants are snapshotted inside the same record
 * and their directories live under the bin item's `.children/`.
 *
 * Purging a binned session deletes the artifact directory and the snapshot,
 * re-checks the projection cache and the schedule service, and removes the
 * session's project directory once it is empty.
 *
 * Crash safety: the bin writes its metadata record BEFORE moving files and
 * rewrites it afterwards, so a crash can never leave an invisible directory in
 * the bin; startup reconciliation repairs either half of that pair.
 *
 * File mutations are restricted to verified session directories; every
 * destructive step re-validates the path shape immediately before acting.
 */
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";

export const name = "dsh-session-cleaner";

export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "dshHomePath"
];

const API_PREFIX = "/session-cleaner/api";
const zstdDecompressAsync = promisify(zstdDecompress);

function safeErrorMessage(error) {
  if (error === null || error === undefined) return `<nullish:${typeof error}>`;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
    if (typeof error.code === "string" && error.code.length > 0) return `[code=${error.code}]`;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** Pull one service out of the Cordis ctx, tolerating direct property fallbacks. */
function getService(ctx, name) {
  try {
    const value = typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    if (value !== undefined) return value;
  } catch { /* fall through to the legacy direct property */ }
  return ctx && ctx[name];
}

// ───────────────────────── 会话标识与目录校验 ─────────────────────────

export function assertSessionId(id) {
  if (typeof id !== "string" || id.trim() === "" || id === "." || id === ".."
    || /[\\/\x00-\x1f<>:"|?*]/.test(id) || /[. ]$/.test(id)) {
    throw Object.assign(new Error("sessionId 必须是合法的会话标识，不能包含路径或特殊目录名"), { code: "bad-request" });
  }
  return id;
}

/** Mirror of DSH's session-segment encoding: the host writes one session
 * directory per id under <sessions>/<projectKey(cwd)>/ using `encodeSegment`
 * (dsh-session-persistence-jsonl). Safe code units stay literal — so a normal
 * `session-<uuid>` id is its own directory name — while `/`, `\`, `:`, `~`,
 * control units and the whole segments `.` / `..` become `~XXXX`. The project
 * level uses a DIFFERENT encoder (`projectKey`, the `--…--` form); this one is
 * for the session level only.
 */
export function encodeSessionSegment(id) {
  assertSessionId(id);
  if (id === ".") return "~002E";
  if (id === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + id.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** Only an actual <sessions>/<project>/<session> directory may be mutated.
 * Neither level may be a symlink/junction. Re-checked immediately before
 * every destructive step.
 */
export async function assertSessionDirectory(root, directory, id, { allowMissing = false } = {}) {
  assertSessionId(id);
  if (typeof root !== "string" || typeof directory !== "string") {
    throw new Error("无法验证会话目录，已停止文件操作");
  }
  const base = resolve(root);
  const target = resolve(directory);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.length !== 2 || parts.some(p => p === ".." || p === "." || p === "")
    || ![id, encodeSessionSegment(id)].includes(parts[1])) {
    throw new Error("会话目录超出允许范围，已停止文件操作");
  }
  const canonicalRoot = await realpath(base);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") return target;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("会话目录不能是符号链接、junction 或普通文件");
    }
    const canonical = await realpath(current);
    const child = relative(canonicalRoot, canonical);
    if (isAbsolute(child) || child === "" || child.split(sep).includes("..")) {
      throw new Error("会话目录解析到了允许范围之外");
    }
  }
  return target;
}

// ───────────────────────── Zstd 帧扫描（只读头帧） ─────────────────────────
// Direct port of DSH's frame layout contract: concatenated checksummed frames,
// boundaries computed from the frame header itself (never a magic-byte guess).

const ZSTD_MAGIC = 0xfd2fb528;

export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUint32LE(offset) != ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUint8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Filenames tried in order to locate a session's durable artifact. */
export const ARTIFACT_NAMES = [
  "session.v4.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.jsonl.zstd",
  "session.jsonl"
];
const MAX_HEADER_BYTES = 1024 * 1024;
/** 单帧解压上限。日志帧里可能夹着很大的工具输出，1 MiB 的旧上限会让那种帧
 * 解压失败被 catch 跳过——跳过就等于漏掉那一帧里的标题。本机最大日志 2.3 MB，
 * 16 MiB 留足余量。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function parseHeader(content) {
  const newline = content.indexOf("\n");
  if (newline < 0) throw new Error("会话工件缺少完整头行");
  const header = JSON.parse(content.slice(0, newline));
  assertSessionId(header?.id);
  return header;
}

/** 从一段日志文本里取最后一条 session/title。 */
function lastTitleIn(text) {
  let found;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== "object") continue;
    if (event.type === "session/title"
      && event.data && typeof event.data.title === "string" && event.data.title.trim() !== "") {
      found = event.data.title.trim();
    }
  }
  return found;
}

/** 从一段日志文本里取出会话头与标题。 */
function parseHeaderAndTitle(text) {
  let header;
  let title;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== "object") continue;
    if (header === undefined && event.type === "session") header = event;
    // 取**最后一个** title：DSH 第一次盖自动标题、之后重命名都会再写一条，
    // 用户看到的永远是最后那条。这里不 break，让后面的覆盖前面的。
    if (event.type === "session/title"
      && event.data && typeof event.data.title === "string" && event.data.title.trim() !== "") {
      title = event.data.title.trim();
    }
  }
  if (header === undefined) throw new Error("会话工件缺少头行");
  assertSessionId(header.id);
  return { header, title };
}

/** 一次把会话头、标题、以及「有没有真正聊过」读出来。
 *
 * 标题是 `session/title` 事件，但它的位置不固定：短会话落在第 5 帧，长会话里
 * 用户重命名会追加到**很后面**（实测一个 939 帧的会话，重命名在第 848 帧）。
 * 所以固定读前 N 帧永远不够。这里直接读整个文件算帧边界（只读不解压），
 * 然后只解压**头 6 帧 + 尾 8 帧**：头帧给 header，尾帧给最后一次重命名。
 *
 * 大文件（> MAX_SCAN_BYTES）不读全文，退回只读头部——此时标题可能停在自动
 * 命名那个版本，但不会因为一个 30MB 的会话把面板拖死。
 */
const TITLE_HEAD_FRAMES = 6;
const MAX_SCAN_BYTES = 24 * 1024 * 1024;

/** 读会话头（和可选的最新标题）。
 *
 * `scanTitle` 为 false 时只读文件头：调用方已经用宿主投影缓存拿到标题了，
 * 这里只需要 header 和「有没有真的聊过」，没必要把整个日志解一遍。
 *
 * ⚠️ 标题回退范围曾经是「从末尾往前最多 160 帧」，实测 181 个会话里有 30 个的
 * 最后一条标题落在第 6–10 帧（或会话中段），160 帧的窗口根本够不到它，于是
 * 悄悄退回第一版自动标题（用户看到的「首句截断」）——这就是「面板标题和实际
 * 改的名字对不上」的根因。现在改成一直扫到第 6 帧（头 6 帧已单独解过），
 * 代价由 mtime 缓存和宿主缓存吸收。
 */
export async function readHeaderAndTitle(path, { scanTitle = true } = {}) {
  await assertRegularFile(path);
  const info = await lstat(path);
  if (!path.endsWith(".zstd")) {
    const text = await readFile(path, "utf8");
    const got = parseHeaderAndTitle(text);
    return { header: got.header, title: got.title, hasUserMessage: /"type"\s*:\s*"user\/message"/.test(text) };
  }

  const tinyEnough = info.size <= MAX_SCAN_BYTES;
  const buf = tinyEnough && scanTitle
    ? await readFile(path)
    : await readHeadBytes(path, MAX_HEADER_BYTES * 8);

  let frames = [];
  try { ({ frames } = scanZstdFrames(buf)); } catch { frames = []; }
  if (frames.length === 0) throw new Error("会话工件没有可读的 zstd 帧");

  const decompress = async (frame, limit = MAX_FRAME_BYTES) =>
    (await zstdDecompressAsync(buf.subarray(frame.start, frame.end), { maxOutputLength: limit })).toString("utf8");

  const headFrames = frames.slice(0, TITLE_HEAD_FRAMES);
  const headTexts = [];
  for (const frame of headFrames) {
    try { headTexts.push(await decompress(frame, MAX_HEADER_BYTES)); } catch { break; }
  }
  const got = parseHeaderAndTitle(headTexts.join("\n"));

  let title = got.title;
  // 从末尾往前找最后一次重命名，一直回溯到第 6 帧（头 6 帧上面已经解过）。
  // 找到即停；绝大多数会话的最后一条标题就在开头几帧，倒扫会一路回溯到那里。
  if (scanTitle && tinyEnough && frames.length > TITLE_HEAD_FRAMES) {
    for (let i = frames.length - 1; i >= TITLE_HEAD_FRAMES; i--) {
      let text;
      try { text = await decompress(frames[i]); } catch { continue; }
      const found = lastTitleIn(text);
      if (found !== undefined) { title = found; break; }
    }
  }
  // 空会话判定用文件体积：从没发过消息的会话只有几百字节
  const hasUserMessage = info.size >= 2048 || headTexts.join("\n").includes('"user/message"');
  return { header: got.header, title, hasUserMessage };
}

/** 只读文件开头 N 字节（大文件用的降级路径）。 */
async function readHeadBytes(path, limit) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("会话工件必须是普通文件，不能是符号链接");
}

/** Header-only read: first zstd frame (or first line for plain JSONL). */
export async function readSessionHeader(path) {
  await assertRegularFile(path);
  const handle = await open(path, "r");
  try {
    let buffer = Buffer.alloc(0);
    while (buffer.length < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - buffer.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, buffer.length);
      if (bytesRead === 0) break;
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      if (path.endsWith(".zstd")) {
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length) {
          const frame = frames[0];
          const decoded = await zstdDecompressAsync(buffer.subarray(frame.start, frame.end), { maxOutputLength: MAX_HEADER_BYTES });
          return parseHeader(decoded.toString("utf8"));
        }
      } else if (buffer.includes(10)) {
        return parseHeader(buffer.toString("utf8"));
      }
    }
    throw new Error("会话头行不完整或超过大小限制");
  } finally {
    await handle.close();
  }
}

// ───────────────────────── 会话信息统计（弹窗展示用） ─────────────────────────

/** 解出整个日志（多帧 zstd 或纯 JSONL），供轮次/消息统计。 */
async function decompressArtifact(path, { maxOutputLength = 512 * 1024 * 1024 } = {}) {
  const bytes = await readFile(path);
  if (!path.toLowerCase().endsWith(".zstd")) {
    return { text: bytes.toString("utf8") };
  }
  const { frames } = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error("会话日志没有可读的 Zstd 帧");
  const parts = [];
  for (const frame of frames) {
    parts.push(await zstdDecompressAsync(bytes.subarray(frame.start, frame.end), { maxOutputLength }));
  }
  return { text: Buffer.concat(parts).toString("utf8") };
}

async function findArtifactPath(dir) {
  for (const filename of ARTIFACT_NAMES) {
    const path = join(dir, filename);
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) return path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

// ───────────────────────── 产出文件（AI 交付物）识别 ─────────────────────────
// 只读不改：从会话日志里找出 Agent 用写作工具落进工作目录的文件，供删除前
// 由用户在界面上逐条勾选。插件本身从不主动删这些文件——一律要前端显式提交，
// 且提交后在宿主端重新扫描一遍复核，前端伪造不了删除范围。

/** 写作工具的路径参数名。write/edit 用 file_path，Minimal 预设的
 * str_replace_editor 用 path。apply_patch 是多文件补丁格式，不在此列：
 * 没有单一路径参数，强行解析会误判，因此一律不碰。
 */
const WRITE_TOOL_PATHS = {
  write: ["file_path", "path"],
  edit: ["file_path", "path"],
  create_file: ["file_path", "path"],
  str_replace_editor: ["path", "file_path"]
};

/** child 是否严格位于 parent 之内（Windows 下忽略大小写）。 */
function isInsideDir(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string" || parent === "" || child === "") return false;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  if (process.platform !== "win32") return child.startsWith(withSep);
  return child.toLowerCase().startsWith(withSep.toLowerCase());
}

/** 路径比较用的归一化键：Windows 大小写不敏感。 */
function pathKey(value) {
  const text = String(value);
  return process.platform === "win32" ? text.toLowerCase() : text;
}

/** 限并发地跑一个异步映射，保持输入顺序。
 *
 * 会话列表在真实机器上可能是几百到几千条。逐条 `await`（读 header、stat、
 * 算目录体积）会串成一条长链，面板就越用越慢；这里把并发压在 16 路，
 * SSD/HDD 都不会被打满，也不会跟宿主启动抢 I/O。
 */
async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await mapper(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

/** 列表/扫描的并发度。 */
const LIST_CONCURRENCY = 16;

/** 从已解压的日志文本里分出「交付物」与「其他改动文件」。
 *
 * 交付物 = Agent 用 `present` 明确交给用户的文件（带 description），就是用户
 * 在对话末尾真正收到的那几个。其他改动 = write/edit/str_replace_editor 动过的
 * 文件，多数是中间脚本、临时产物、反复改写的旧版本。
 * 实测一个会话可能写了 17 个文件但只交付 2 个——不分层用户根本认不出来。
 */
const PRESENT_TOOL = "present";

function collectProducedFiles(text, cwd) {
  const delivered = new Map();
  const modified = new Map();
  const toAbs = (raw) => {
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const value = raw.trim();
    if (isAbsolute(value)) return value;
    return typeof cwd === "string" && cwd !== "" ? resolve(cwd, value) : undefined;
  };

  for (const line of text.split("\n")) {
    if (line === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== "object" || event.type !== "tool/call") continue;
    const data = event.data ?? {};
    const tool = data.name;
    if (typeof tool !== "string") continue;
    let args;
    try { args = JSON.parse(typeof data.arguments === "string" ? data.arguments : "{}"); } catch { continue; }
    if (args === null || typeof args !== "object") continue;

    if (tool === PRESENT_TOOL) {
      const list = Array.isArray(args.files) ? args.files : [];
      for (const entry of list) {
        const abs = toAbs(entry && entry.path);
        if (abs === undefined) continue;
        const key = pathKey(abs);
        const description = entry && typeof entry.description === "string" ? entry.description : "";
        const prev = delivered.get(key);
        if (prev === undefined) delivered.set(key, { path: abs, description, ops: 1 });
        else {
          prev.ops += 1;
          if (description !== "") prev.description = description;
        }
      }
      continue;
    }

    const keys = WRITE_TOOL_PATHS[tool];
    if (keys === undefined) continue;
    const raw = keys.map(k => args[k]).find(v => typeof v === "string" && v.trim() !== "");
    const abs = toAbs(raw);
    if (abs === undefined) continue;
    const key = pathKey(abs);
    const prev = modified.get(key);
    if (prev === undefined) modified.set(key, { path: abs, ops: 1 });
    else prev.ops += 1;
  }

  // 交付过的文件不再算「其他改动」
  for (const key of delivered.keys()) modified.delete(key);
  return { delivered: [...delivered.values()], modified: [...modified.values()] };
}

/** 把候选路径分成「可删」与「跳过（附原因）」。
 * 只有真实路径严格落在会话 cwd 内、且不在 DSH 数据目录内的普通文件才可删。
 */
async function classifyProducedFiles(rows, cwd, home) {
  const allowed = [];
  const refused = [];
  if (typeof cwd !== "string" || cwd === "") {
    for (const row of rows) refused.push({ path: row.path, reason: "会话未记录工作目录，无法确认归属" });
    return { allowed, refused };
  }
  let realCwd;
  try { realCwd = await realpath(cwd); }
  catch {
    for (const row of rows) refused.push({ path: row.path, reason: "会话工作目录已不存在，无法校验归属" });
    return { allowed, refused };
  }
  let realHome = home;
  try { realHome = await realpath(home); } catch { /* 家目录不存在则不可能包含任何存在的文件 */ }
  for (const row of rows) {
    let info;
    try { info = await lstat(row.path); }
    catch { refused.push({ path: row.path, reason: "文件已不存在" }); continue; }
    if (info.isSymbolicLink()) { refused.push({ path: row.path, reason: "是符号链接，已跳过" }); continue; }
    if (!info.isFile()) { refused.push({ path: row.path, reason: "不是普通文件，已跳过" }); continue; }
    let real;
    try { real = await realpath(row.path); }
    catch { refused.push({ path: row.path, reason: "无法解析真实路径，已跳过" }); continue; }
    if (!isInsideDir(realCwd, real)) { refused.push({ path: row.path, reason: "不在该会话的工作目录内，已跳过" }); continue; }
    if (typeof realHome === "string" && realHome !== "" && isInsideDir(realHome, real)) {
      refused.push({ path: row.path, reason: "位于 DSH 数据目录内，已跳过" }); continue;
    }
    allowed.push({ path: real, displayPath: row.path, bytes: info.size, ops: row.ops, description: row.description });
  }
  return { allowed, refused };
}

/** 从日志统计弹窗要展示的信息：cwd/轮次/用户消息/工具调用/最后活动。
 * 单行解析失败就跳过该行（尽力而为，不影响删除主流程）。
 */
async function sessionInfo(artifactPath) {
  const { text } = await decompressArtifact(artifactPath);
  let header;
  let title;
  let turns = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let firstTime;
  let lastTime;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj === null || typeof obj !== "object") continue;
    if (header === undefined && obj.type === "session") { header = obj; continue; }
    if (typeof obj.time === "number") {
      if (firstTime === undefined) firstTime = obj.time;
      lastTime = obj.time;
    }
    switch (obj.type) {
      case "session/title":
        if (obj.data && typeof obj.data.title === "string" && obj.data.title.trim() !== "") title = obj.data.title.trim();
        break;
      case "turn/start":
        turns += 1;
        break;
      case "user/message":
        if (obj.data && obj.data.source && obj.data.source.kind === "user") userMessages += 1;
        break;
      case "tool/call":
        toolCalls += 1;
        break;
      default:
        break;
    }
  }
  return {
    cwd: header && typeof header.cwd === "string" ? header.cwd : undefined,
    createdAt: header && typeof header.createdAt === "number" ? header.createdAt : undefined,
    title: title || undefined,
    turns,
    userMessages,
    toolCalls,
    firstTime,
    lastTime
  };
}

/** 取文本块的纯文本（与 session-lib.mjs 的 textFromContent 同一约定）。 */
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
  }
  return out.join("\n").trim();
}

/** 把一条助手消息的 content 拆成「正文」与「思考」两部分。
 *
 * 真实日志里助手消息的 content 是块数组，块的种类不止 text：模型只思考、
 * 只调工具、或者被 503 打断时，整条消息可能**一个 text 块都没有**。
 * 只看 text 会把这种轮次解析成空白，用户点开就是一片白（实测踩到过）。
 * 思考块的字段名按版本可能是 thinking / text，两个都认。
 */
function blocksOf(content) {
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const texts = [];
  const thinks = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      texts.push(block.text);
    } else if (block.type === "reasoning") {
      const value = typeof block.thinking === "string" ? block.thinking
        : typeof block.text === "string" ? block.text : "";
      if (value.trim() !== "") thinks.push(value);
    }
  }
  return { text: texts.join("\n").trim(), thinking: thinks.join("\n").trim() };
}

/** 从 assistant/attempt 的流里取失败原因（503、超时、取消…）。
 * 失败轮次不会产生 assistant/message，只有 attempt 里那个 finish 帧说明原因。
 */
function attemptFailure(data) {
  const stream = data && data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (const item of stream) {
    const chunk = item && item.chunk;
    if (chunk === null || typeof chunk !== "object") continue;
    if (chunk.type !== "finish") continue;
    const reason = chunk.reason;
    if (reason === null || typeof reason !== "object" || reason.kind !== "error") continue;
    const failure = reason.failure;
    const message = failure && (failure.message || failure.code);
    return typeof message === "string" && message.trim() !== "" ? message.trim().slice(0, 240) : "模型调用失败";
  }
  return undefined;
}

function collapseText(text, max = 500) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 长回复中间省略：保留开头与结尾，切点尽量落在换行边界上（Markdown 结构不被切碎）。 */
function elideMiddle(text, max = 1200, head = 700, tail = 300) {
  const t = String(text).trim();
  if (t.length <= max) return t;
  let h = t.slice(0, head);
  const hCut = h.lastIndexOf("\n");
  if (hCut > head * 0.5) h = h.slice(0, hCut);
  let tl = t.slice(-tail);
  const tCut = tl.indexOf("\n");
  if (tCut !== -1 && tCut < tail * 0.5) tl = tl.slice(tCut + 1);
  return h + "\n\n……（中间内容省略）……\n\n" + tl;
}

// ───────────────────────── 通用小工具 ─────────────────────────

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

// ───────────────────────── 插件主体 ─────────────────────────

export function apply(ctx) {
  try {
    const buildId = "dsh-session-cleaner v0.7.7";
    if (typeof ctx?.logger?.info === "function") ctx.logger.info(buildId);
    else if (typeof console !== "undefined" && console?.info) console.info(buildId);
  } catch (_) { /* ignore logging failures */ }

  const service = name => getService(ctx, name);
  const homePath = service("dshHomePath");
  if (typeof homePath !== "function") {
    ctx?.logger?.warn?.("session-cleaner: dshHomePath 服务不可用，插件功能停用");
    return;
  }

  /** Per-id operation queue so a double-click cannot start two deletions.
   * Every path that touches one session (delete / trash / restore / detail /
   * permanent delete) goes through the SAME key, so a restore can never
   * interleave with the permanent delete of the same session.
   */
  const operations = new Map();
  const mutate = (id, operation) => {
    const pending = (operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}).finally(() => {
      if (operations.get(id) === settled) operations.delete(id);
    });
    operations.set(id, settled);
    return pending;
  };

  /** Batch slot: a batch takes this key first and each id's key second. A
   * single-session operation never takes the batch key, so the order
   * batch → id cannot deadlock. The key cannot collide with a session id:
   * assertSessionId rejects colons. */
  const BATCH_KEY = "::batch::";

  const mutateBatch = (operation) => mutate(BATCH_KEY, operation);

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024) throw Object.assign(new Error("请求体超过 64 KiB"), { code: "body-too-large" });
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  /** Every header-verified artifact directory for one session id.
   *
   * Discovery mirrors the host's own path computation exactly
   * (`sessionDir()` = <sessions>/<projectKey(cwd)>/<encodeSegment(id)>,
   * `generationLogFilename()` = the ARTIFACT_NAMES list), so no host service is
   * consulted: `resolveLog` no longer exists in current builds, and `locate()`
   * needs the stored header's `cwd` to name the project segment — passing an
   * id alone resolves to `_no-cwd` and points at a directory that is not there.
   * The disk pass also sees a second copy of one id, which the host's own
   * resolver refuses to disambiguate.
   */
  const scanSessionDirs = async (sessionId) => {
    assertSessionId(sessionId);
    const root = homePath("sessions");
    if (typeof root !== "string") throw new Error("无法定位 DSH sessions 目录");
    const found = new Set();
    const tryRead = async (dir) => {
      try { await assertSessionDirectory(root, dir, sessionId); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      for (const filename of ARTIFACT_NAMES) {
        try {
          const header = await readSessionHeader(join(dir, filename));
          if (header.id !== sessionId) throw new Error("会话工件 header id 与请求不一致");
          return resolve(dir);
        } catch (error) {
          // 没有这个工件文件就试下一个名字；其余错误（损坏帧、JSON 非法、
          // id 不一致）立即抛出，绝不把读不动的目录交给 rm
          if (error.code === "ENOENT") continue;
          throw error;
        }
      }
      return undefined;
    };
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      for (const candidate of [encodeSessionSegment(sessionId), sessionId]) {
        const dir = await tryRead(join(root, proj.name, candidate));
        if (dir !== undefined) found.add(dir);
      }
    }
    return [...found];
  };

  /** Every session on disk as { id, dir, artifact, header, parentSession }.
   *
   * One pass feeds "where is this session", "which sessions descend from it" and
   * "what does the host already know about it": each log header is read once and
   * kept, together with the artifact filename, so the list view never has to
   * read the same header (or readdir the same directory) a second time.
   *
   * 目录枚举本身是串行 readdir（很便宜），读 header 才并发：会话总数可能上千，
   * 串行 open/read 会把面板拖到十几秒。
   */
  const listAllSessionDirs = async () => {
    const root = homePath("sessions");
    if (typeof root !== "string") throw new Error("无法定位 DSH sessions 目录");
    const dirs = [];
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
      let entries;
      try { entries = await readdir(join(root, proj.name), { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        dirs.push(resolve(join(root, proj.name, entry.name)));
      }
    }
    const rows = await mapLimit(dirs, LIST_CONCURRENCY, async (dir) => {
      let header;
      let artifact;
      for (const filename of ARTIFACT_NAMES) {
        const candidate = join(dir, filename);
        try { header = await readSessionHeader(candidate); artifact = candidate; break; }
        // ENOENT: 换下一个名字；其它错误（坏帧、JSON 非法）直接放弃这个目录，
        // 绝不因为一个坏会话中断整次扫描。
        catch { break; }
      }
      if (header === undefined || typeof header.id !== "string") return undefined;
      return {
        id: header.id,
        dir,
        artifact,
        header,
        parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined
      };
    });
    return rows.filter(row => row !== undefined);
  };

  /** Every descendant of one session, in stable order.
   *
   * The host decides parentage the same way: a session whose stored header
   * carries `origin: 'subagent'` and `parentSession: <id>` is that session's
   * child (dsh-session-persistence-jsonl's own children query filters exactly
   * those two fields). Subagents nest, so the walk is transitive with a depth
   * cap; a session already in the bin has no directory on disk and is therefore
   * not re-discovered.
   */
  const collectDescendants = async (rootId, { maxDepth = 8 } = {}) => {
    const all = await listAllSessionDirs();
    const byParent = new Map();
    for (const item of all) {
      if (typeof item.parentSession !== "string" || item.parentSession === "") continue;
      const list = byParent.get(item.parentSession) ?? [];
      list.push(item);
      byParent.set(item.parentSession, list);
    }
    const out = [];
    const seen = new Set([rootId]);
    let frontier = [rootId];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next = [];
      for (const parent of frontier) {
        for (const child of byParent.get(parent) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          out.push(child);
          next.push(child.id);
        }
      }
      frontier = next;
    }
    return out;
  };

  /** The session's artifact directory, or undefined when it has none.
   *
   * Two verified copies of one id is a corrupt layout the host itself refuses
   * to resolve (`duplicate JSONL session id appears in multiple project
   * directories`). Refuse as well: deleting the first copy would leave the
   * other behind and report success.
   */
  const sessionDirOf = async (sessionId) => {
    const dirs = await scanSessionDirs(sessionId);
    if (dirs.length === 0) return undefined;
    if (dirs.length > 1) {
      throw Object.assign(
        new Error("发现同一会话的多个日志目录，已停止操作。请先清理多余的目录再重试：\n" + dirs.join("\n")),
        { code: "duplicate-session-dirs", dirs }
      );
    }
    return dirs[0];
  };

  const dirSize = async (dir) => {
    let total = 0;
    const walk = async (current) => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const child = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child);
        else {
          try { total += (await lstat(child)).size; } catch { /* racing file: ignore */ }
        }
      }
    };
    try { await walk(dir); } catch { /* unreadable dir: report what we got */ }
    return total;
  };

  /** Refuse-active gate removed in v0.2.0: a live agent is now torn down
   * (see teardownLive) after the user confirms in the UI — the dialog warns
   * that the in-flight answer will be ended. */

  const detachFromWorkspaces = async (sessionId) => {
    const registry = service("workspaceRegistry");
    let detached = 0;
    if (!registry || typeof registry.list !== "function") return detached;
    for (const entity of registry.list()) {
      const ids = entity?.sessionIds;
      if (Array.isArray(ids) && ids.includes(sessionId) && typeof entity.detachSession === "function") {
        await entity.detachSession(sessionId);
        detached++;
      }
    }
    return detached;
  };

  /** Registry-global state mutation, serialized on the host's own operation
   * queue so a concurrent host write cannot interleave with ours. The mutator
   * returns the next state, or undefined to leave it alone.
   */
  const mutateGlobalState = async (mutator) => {
    const registry = service("workspaceRegistry");
    if (!registry || typeof registry.enqueueOperation !== "function"
      || typeof registry.requireState !== "function" || typeof registry.setState !== "function") return false;
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (!isRecord(state)) return;
      const next = mutator(state);
      if (next !== undefined && next !== state) await registry.setState(next);
    });
    return true;
  };

  /** Drop the id from the registry-global archived set (durable, serialized). */
  const unarchiveSession = async (sessionId) => mutateGlobalState((state) => {
    if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(sessionId)) return undefined;
    return { ...state, archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId) };
  });

  /** Where the id sits in the registry-global pin order, or undefined. */
  const pinnedIndexOf = (sessionId) => {
    try {
      const pinned = service("workspaceRegistry")?.pinnedSessionIds;
      if (pinned === undefined || pinned === null) return undefined;
      const index = Array.from(pinned).indexOf(sessionId);
      return index === -1 ? undefined : index;
    } catch { return undefined; }
  };

  /** Unpin one session. The pin set is registry-global, so a deleted session
   * must not keep a pin: it would outlive the session it names. */
  const clearPinnedSession = async (sessionId) => {
    const registry = service("workspaceRegistry");
    if (registry && typeof registry.unpinSession === "function") {
      try { await registry.unpinSession(sessionId); } catch { /* fall back to the state patch */ }
      if (pinnedIndexOf(sessionId) === undefined) return true;
    }
    return mutateGlobalState((state) => {
      if (!Array.isArray(state.pinnedSessionIds) || !state.pinnedSessionIds.includes(sessionId)) return undefined;
      return { ...state, pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId) };
    });
  };

  /** Put a pin back where it was: the host prepends new pins, so simply
   * re-pinning would move a restored session to the front of the pin list. */
  const restorePinnedSession = async (sessionId, index) => {
    const at = Number.isInteger(index) && index >= 0 ? index : 0;
    const registry = service("workspaceRegistry");
    if (registry && typeof registry.pinSession === "function") {
      try { await registry.pinSession(sessionId); } catch { /* fall back to the state patch */ }
      if (pinnedIndexOf(sessionId) === at) return true;
    }
    return mutateGlobalState((state) => {
      const list = Array.isArray(state.pinnedSessionIds)
        ? state.pinnedSessionIds.filter(id => id !== sessionId)
        : [];
      list.splice(Math.min(at, list.length), 0, sessionId);
      return { ...state, pinnedSessionIds: list };
    });
  };

  /** The workspace record that owns this session, plus the anchor needed to
   * put it back later.
   *
   * `entity.sessionIds` is a filtered projection rebuilt on every access (it
   * drops ids the host's header index cannot resolve), so its index is not a
   * durable position. The id of the session that followed is: it stays stable
   * and `insertSessionBefore(id, anchor)` can relocate by anchor.
   */
  const captureWorkspaceSlot = async (sessionId) => {
    const slot = { workspaceId: undefined, workspacePath: undefined, index: undefined, anchorId: null, wasLast: false };
    try {
      for (const entity of (service("workspaceRegistry")?.list?.() ?? [])) {
        const ids = entity?.sessionIds;
        if (!Array.isArray(ids)) continue;
        const index = ids.indexOf(sessionId);
        if (index === -1) continue;
        slot.workspaceId = entity.id;
        slot.workspacePath = entity.path;
        slot.index = index;
        const anchor = ids[index + 1];
        slot.anchorId = typeof anchor === "string" && anchor !== sessionId ? anchor : null;
        slot.wasLast = slot.anchorId === null;
        break;
      }
    } catch { /* best-effort */ }
    return slot;
  };

  /** Put a restored session back into its workspace, at the slot it occupied.
   *
   * `attachSession` prepends, so the anchor session that used to follow it is
   * re-inserted in front of; a session that was last goes back to the end.
   * If the anchor is gone (deleted meanwhile) the session simply stays at the
   * head — the position is reported as not restored rather than guessed.
   */
  const restoreWorkspaceSlot = async (meta, sessionId) => {
    const result = { attached: false, positionRestored: false, error: undefined };
    const registry = service("workspaceRegistry");
    if (!registry) { result.error = "workspaceRegistry 服务不可用"; return result; }

    let entity;
    try {
      if (typeof meta.workspaceId === "string" && typeof registry.get === "function") {
        try { entity = registry.get(meta.workspaceId); } catch { entity = undefined; }
      }
      if (entity === undefined && typeof meta.workspacePath === "string") {
        for (const candidate of (registry.list?.() ?? [])) {
          if (candidate?.path === meta.workspacePath) { entity = candidate; break; }
        }
      }
    } catch (error) { result.error = safeErrorMessage(error); return result; }

    if (entity === undefined || typeof entity.attachSession !== "function") {
      result.error = "找不到原工作区";
      return result;
    }
    try {
      await entity.attachSession(sessionId);
      result.attached = true;
    } catch (error) {
      result.error = safeErrorMessage(error);
      return result;
    }

    if (typeof entity.insertSessionBefore !== "function") return result;
    const anchor = typeof meta.workspaceAnchorId === "string" && meta.workspaceAnchorId !== sessionId
      ? meta.workspaceAnchorId
      : undefined;
    if (anchor === undefined && meta.workspaceWasLast !== true) return result;
    try {
      // anchor 省略 = 追加到末尾（删除前它就是该工作区最后一条）
      await entity.insertSessionBefore(sessionId, anchor);
      result.positionRestored = true;
    } catch (error) {
      // 锚点会话可能已被删掉：停在头部即可，不再猜位置
      ctx?.logger?.warn?.("session-cleaner: 槽位还原失败，会话停在侧栏顶部: " + safeErrorMessage(error));
    }
    return result;
  };

  /** Whether the id currently sits in the registry-global archived set. */
  const isArchivedSession = (sessionId) => {
    try {
      const registry = service("workspaceRegistry");
      const archived = registry?.archivedSessionIds;
      if (archived !== undefined && archived !== null) return Array.from(archived).includes(sessionId);
      const state = typeof registry?.requireState === "function" ? registry.requireState() : undefined;
      return Array.isArray(state?.archivedSessionIds) && state.archivedSessionIds.includes(sessionId);
    } catch { return false; }
  };

  /** Put a restored session back into the archived set (the host appends). */
  const archiveSessionFlag = async (sessionId) => mutateGlobalState((state) => {
    const list = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
    if (list.includes(sessionId)) return undefined;
    return { ...state, archivedSessionIds: [...list, sessionId] };
  });

  // ───────────────────── 绑定该会话的定时任务 ─────────────────────
  // 宿主 schedule 服务（DSH 0.2.2-rc.1 起）：
  //   catalog() 列全部（含已结束）；list({active,limit,offset}) 只做分页，**不再支持
  //   sessionId 过滤**；edit({id,action:"delete"}) 删单条（旧的 schedule.delete 已移除）；
  //   stopSessionTasks(sessionId) 停掉投递到该会话的全部进行中任务。
  // 任务归属改为显式的 target.sessionId（involvedSessionIds 只是通知对象），
  // 老格式行可能还带顶层 sessionId，两种都要认。
  // 注意：任务**不能**原样重建（create 只接受选择器、强制新 id、清空发送历史），
  // 所以回收站这一步只抄录不删除——删除不可逆，而"移入回收站"必须可逆。
  // 宿主对"会话已不存在"的到期任务只记一条 warn，不会重建会话。

  const scheduleService = () => {
    try { return service("schedule"); } catch { return undefined; }
  };

  /** 任务是否投递/绑定到该会话（新格式看 target.sessionId，老格式看顶层 sessionId）。 */
  const scheduleTargetsSession = (entry, sessionId) => {
    if (!entry || typeof entry !== "object") return false;
    return entry.target?.sessionId === sessionId || entry.sessionId === sessionId;
  };

  /** 该会话当前的定时任务（含已结束的历史行），只读。 */
  const listSessionSchedules = async (sessionId) => {
    const schedule = scheduleService();
    if (!schedule || typeof schedule !== "object") return { supported: false, records: [] };
    try {
      if (typeof schedule.catalog === "function") {
        const all = await schedule.catalog();
        return { supported: true, records: (all ?? []).filter(entry => scheduleTargetsSession(entry, sessionId)) };
      }
      // 旧宿主没有 catalog()：list() 可能返回数组或分页对象，统一在前端过滤。
      if (typeof schedule.list === "function") {
        const page = await schedule.list({});
        const items = Array.isArray(page) ? page : (page?.items ?? []);
        return { supported: true, records: items.filter(entry => scheduleTargetsSession(entry, sessionId)) };
      }
    } catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 读取定时任务失败: " + safeErrorMessage(error));
    }
    return { supported: false, records: [] };
  };

  /** 彻底删除该会话时清掉它的定时任务：进行中的交给宿主自己的
   * stopSessionTasks（宿主归档会话时走的就是它），剩下的历史行逐条 edit(delete)。
   */
  const purgeSessionSchedules = async (sessionId) => {
    const schedule = scheduleService();
    if (!schedule || typeof schedule !== "object") return { removed: 0, supported: false, error: undefined };
    let removed = 0;
    let supported = false;
    let error;

    if (typeof schedule.stopSessionTasks === "function") {
      supported = true;
      const before = await listSessionSchedules(sessionId);
      const active = before.records.filter(record => record.status === "active").length;
      try {
        await schedule.stopSessionTasks(sessionId);
        removed += active;
      } catch (cause) { error = safeErrorMessage(cause); }
    }

    const canDeleteOne = typeof schedule.edit === "function" || typeof schedule.delete === "function";
    if (canDeleteOne) {
      supported = true;
      const left = await listSessionSchedules(sessionId);
      for (const record of left.records) {
        if (typeof record?.id !== "string" || record.id === "") continue;
        try {
          const result = typeof schedule.edit === "function"
            ? await schedule.edit({ id: record.id, action: "delete" }, sessionId)
            : await schedule.delete({ sessionId, id: record.id });
          if (result?.deleted === true) removed++;
        } catch (cause) { error ??= safeErrorMessage(cause); }
      }
    }
    return { removed, supported, error };
  };

  /** The projection-cache document path for one session, shape-checked. */
  const projcachePaths = (sessionId) => {
    assertSessionId(sessionId);
    const storages = homePath("storages");
    if (typeof storages !== "string") return undefined;
    const sessionsRoot = resolve(storages, "session_projcache", "sessions");
    const target = resolve(sessionsRoot, `${sessionId}.json`);
    const rel = relative(sessionsRoot, target);
    if (isAbsolute(rel) || rel.split(sep).length !== 1 || rel !== `${sessionId}.json`) {
      throw new Error("投影缓存路径超出允许范围，已停止清理");
    }
    return { sessionsRoot, target };
  };

  /** The host's already-open projection-cache domain table, if reachable.
   * The domain stores one document per session (`per-record` layout), so
   * `table.delete(key)` really removes
   * <dshHome>/storages/session_projcache/sessions/<id>.json — and it keeps the
   * host's in-memory table in step with the disk. `ctx.storageDomain.get(name)`
   * returns the instance the host service already opened (it is not opened
   * again here: `open()` would throw `already-open`).
   */
  const projcacheDomainTable = () => {
    try {
      const domain = service("storageDomain")?.get?.("session_projcache");
      if (domain && typeof domain.table === "function") {
        const table = domain.table("sessions");
        if (table && typeof table.delete === "function") return table;
      }
    } catch { /* domain closed / not mounted */ }
    return undefined;
  };

  /** Ask the host's projection-cache service to drop one record, so its
   * in-memory table and the durable document agree instead of only the file
   * disappearing under a table that still holds the record.
   *
   * Three faces are tried in order of how directly the host owns the record:
   * the storage domain table, a public `remove` (no current build has one),
   * then the cache service's own table. Whatever happens, the caller removes
   * the file afterwards — that is the part that survives a restart.
   *
   * A domain `delete` answers `false` when the record is not in the table it
   * loaded, which means it did NOT touch the disk: that is not a success, so
   * the walk continues. (A record written by another process after boot is
   * exactly that case — the file removal below is what actually clears it.)
   *
   * `markClean` cancels a pending write-behind checkpoint of the live session,
   * which would otherwise re-create the record moments after we drop it.
   */
  const dropProjectionCacheRecord = async (sessionId, liveSession) => {
    const cache = service("sessionProjectionCache");
    if (liveSession !== undefined && liveSession !== null && typeof cache?.markClean === "function") {
      try { cache.markClean(liveSession); } catch { /* best-effort */ }
    }
    const table = projcacheDomainTable();
    if (table !== undefined) {
      try {
        const removed = await table.delete(sessionId);
        if (removed !== false) return true;
      } catch { /* fall through */ }
    }
    if (!cache || typeof cache !== "object") return false;
    if (typeof cache.remove === "function") {
      try { await cache.remove(sessionId); return true; } catch { /* fall through to the service table */ }
    }
    if (typeof cache.requireTable === "function") {
      try {
        const own = cache.requireTable();
        if (own && typeof own.delete === "function") {
          const removed = await own.delete(sessionId);
          if (removed !== false) return true;
        }
      } catch { /* fall through to the file */ }
    }
    return false;
  };

  /** Remove the projection-cache document for one session, plus any
   * `<id>.json.bak.<stamp>` copy the host's backup-and-skip path left behind.
   * The service call comes first (memory stays coherent); the file removal is
   * the authority, so a build without a usable removal API still ends clean.
   * The domain path deletes the file itself, so "did anything go away" is the
   * union of both attempts — not just whether we personally ran a rm.
   */
  const removeProjectionCacheRow = async (sessionId, liveSession) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) return { removed: false, backups: 0, viaService: false };
    const viaService = await dropProjectionCacheRecord(sessionId, liveSession);

    let fileRemoved = false;
    let existedOnDisk = false;
    try {
      const info = await lstat(paths.target);
      if (!info.isSymbolicLink() && info.isFile()) {
        existedOnDisk = true;
        await rm(paths.target, { force: true });
        fileRemoved = true;
      }
    } catch (error) {
      // ENOENT 有两种情况：本来就没有，或者域表那一步已经把它删掉了
      if (error.code !== "ENOENT") throw error;
    }

    let backups = 0;
    try {
      for (const entry of await readdir(paths.sessionsRoot)) {
        if (!entry.startsWith(`${sessionId}.json.bak.`)) continue;
        if (relative(paths.sessionsRoot, resolve(paths.sessionsRoot, entry)).split(sep).length !== 1) continue;
        const info = await lstat(join(paths.sessionsRoot, entry)).catch(() => undefined);
        if (info === undefined || info.isSymbolicLink() || !info.isFile()) continue;
        await rm(join(paths.sessionsRoot, entry), { force: true });
        backups++;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { removed: viaService || fileRemoved, backups, viaService, existedOnDisk };
  };

  /** End-of-life for in-memory state: cancel a running turn, dispose the
   * agent fiber (bounded in case teardown stalls), flush and detach the
   * session entry so every connected client drops the row. Every step is
   * best-effort with bounded waits.
   */
  const teardownLive = async (sessionId) => {
    const agents = service("agents");
    const sessions = service("sessions");
    let agent = undefined;
    try { agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined; } catch { agent = undefined; }
    let session = undefined;
    try { session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : undefined; } catch { session = undefined; }

    if (agent !== undefined && agent !== null) {
      // Stop any running turn (disposed-kind suppresses re-wake), then quiesce
      // the agent's own fiber with a hard 3s bound.
      try { if (typeof agent.cancel === "function") agent.cancel({ kind: "disposed" }); } catch { /* best-effort */ }
      if (typeof agent.scope?.dispose === "function") {
        await Promise.race([agent.scope.dispose(), delay(3000)]);
      }
      // Drop the zombie from the registry so a later session.create/open with
      // the same id cannot resurrect it.
      try { agents?.store?.delete?.(sessionId); } catch { /* best-effort */ }
    }

    let detached = false;
    if (session !== undefined && session !== null) {
      // Flush buffered events to disk first so the retirement drain is a no-op.
      try { if (typeof sessions.flush === "function") await sessions.flush(session); } catch { /* best-effort */ }
      try {
        const entry = sessions?.store?.get?.(sessionId);
        if (entry !== undefined && typeof entry.detach === "function") {
          entry.detach();
          await delay(200); // let the write-behind retirement settle
          detached = true;
        }
      } catch { /* best-effort */ }
    }
    if (!detached) {
      // Cold or already-detached session: emit explicitly so every connected
      // client drops the row. 两个事件名都发一次：不同 DSH 版本认的不是同一个，
      // 发错的那个会被客户端忽略，无害；发对的那个立刻把行摘掉，避免留下
      // 点进去 404 的僵尸行。
      try { ctx.emit("session/disposed", { id: sessionId }); } catch { /* best-effort */ }
    }
    // 无论 live 与否都补一次 removed 广播，覆盖"宿主不发 disposed"的老/新版本
    try { ctx.emit("api-session/removed", sessionId); } catch { /* best-effort */ }
    return {
      wasLiveAgent: agent !== undefined && agent !== null,
      wasLiveSession: session !== undefined && session !== null,
      // handed to the projection-cache cleanup: markClean() needs the session
      // object itself (the host keys its dirty map by object, not by id)
      liveSession: session
    };
  };

  // 旧版有一个"不进回收站直接物理删除"的 /delete 端点与一个 /status 查询端点：
  // 客户端从来不调用它们，而 /delete 是唯一会删投影缓存行的路径，读代码的人
  // 很容易据此以为"删除"覆盖了缓存行。两者已移除：删除只走回收站，
  // 彻底删除在回收站里做，缓存/记账/置顶/定时任务的清理也就都在同一条链上。

  // ───────────────────────── 回收站 ─────────────────────────
  // 「删除」把会话目录整体搬进 <dshHome>/dsh-session-cleaner/trash/items/<id>/，
  // 快照写在 trash/meta/<id>.json：原目录、工作区与槽位序号、投影缓存行原文、
  // 置顶状态、绑定该会话的定时任务。恢复时逐项还原，彻底删除才物理清除。
  // 保留期 15 天（用户定的）。启动后延后一会儿再对账，之后每 6 小时清一次过期项
  // ——DSH 长期不重启也不会让回收站无限长大。

  const TRASH_RETENTION_DAYS = 15;
  const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** 启动后等这么久再碰磁盘：错开宿主自身的启动 I/O 高峰。 */
  const STARTUP_SETTLE_MS = 15 * 1000;
  /** A record written before the move: files may not be in the bin yet. */
  const META_STAGE_PREPARED = "prepared";
  /** A record whose files are in the bin and complete. */
  const META_STAGE_TRASHED = "trashed";
  /** A record repaired by startup reconciliation: the directory is in the bin
   * but its snapshot (original path and friends) is gone. */
  const META_STAGE_INCOMPLETE = "incomplete";

  const trashRoots = () => ({
    items: join(homePath("dsh-session-cleaner"), "trash", "items"),
    meta: join(homePath("dsh-session-cleaner"), "trash", "meta"),
    // 用户勾选删除的产出文件也搬进来（不是 rm），恢复时原路搬回
    files: join(homePath("dsh-session-cleaner"), "trash", "files")
  });

  const itemDirOf = (sessionId) => join(trashRoots().items, sessionId);
  const metaPathOf = (sessionId) => join(trashRoots().meta, `${sessionId}.json`);

  const readMeta = async (sessionId) => {
    try {
      const parsed = JSON.parse(await readFile(metaPathOf(sessionId), "utf8"));
      if (!isRecord(parsed) || parsed.id !== sessionId) return undefined;
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };

  const writeMeta = async (meta) => {
    const { meta: metaRoot } = trashRoots();
    await mkdir(metaRoot, { recursive: true });
    const temp = join(metaRoot, `${meta.id}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(meta, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, metaPathOf(meta.id));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  const removeMeta = async (sessionId) => {
    await rm(metaPathOf(sessionId), { force: true });
  };

  const readProjcacheRow = async (sessionId) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) return null;
    try {
      const info = await lstat(paths.target);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      return await readFile(paths.target, "utf8");
    } catch { return null; }
  };

  /** Write a snapshot of the projection-cache document back. The file is the
   * authority (it survives a restart); the host's own table is updated too
   * when it exposes one, so the running process agrees with the disk. */
  const writeProjcacheRow = async (sessionId, content) => {
    const paths = projcachePaths(sessionId);
    if (paths === undefined) throw new Error("无法定位投影缓存目录");
    await mkdir(paths.sessionsRoot, { recursive: true });
    const temp = `${paths.target}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, paths.target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    // 内存侧同步：优先走宿主存储域的表（同一个实例），拿不到再用缓存服务自己的表
    const record = (() => { try { return JSON.parse(content)?.record; } catch { return undefined; } })();
    if (isRecord(record)) {
      const table = projcacheDomainTable();
      if (table !== undefined && typeof table.put === "function") {
        try { await table.put(sessionId, record); return; } catch { /* fall through */ }
      }
      const cache = service("sessionProjectionCache");
      if (cache && typeof cache.requireTable === "function") {
        try {
          const own = cache.requireTable();
          if (own && typeof own.put === "function") await own.put(sessionId, record);
        } catch (error) {
          ctx?.logger?.warn?.("session-cleaner: 投影缓存内存回写失败（文件已还原）: " + safeErrorMessage(error));
        }
      }
    }
  };

  const listTrash = async () => {
    const { meta: metaRoot } = trashRoots();
    let files;
    try { files = await readdir(metaRoot); }
    catch (error) { if (error.code === "ENOENT") return { items: [], totalBytes: 0 }; throw error; }
    const items = [];
    let totalBytes = 0;
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(metaRoot, file), "utf8"));
        if (!isRecord(parsed) || typeof parsed.id !== "string") continue;
        totalBytes += Number(parsed.bytes) || 0;
        // 列表只回展示用的字段：子会话的回溯快照（含投影缓存行原文）很占体积，
        // 恢复/彻底删除都直接读 meta，不走这里。
        const descendants = Array.isArray(parsed.descendants)
          ? parsed.descendants.filter(isRecord).map(child => ({
            id: child.id,
            title: child.title,
            bytes: child.bytes,
            cwd: child.cwd
          }))
          : [];
        // 列表只回展示字段：投影缓存行原文（projcacheRow）可能很大，恢复/彻底
        // 删除都直接从 meta 文件读，不经这里。去掉它，避免条目一多响应就膨胀。
        const { projcacheRow: _droppedProjcacheRow, ...display } = parsed;
        items.push({ ...display, descendants });
      } catch { /* 跳过损坏的 meta */ }
    }
    return { items, totalBytes };
  };

  /** Everything one session leaves behind, captured before anything moves.
   *
   * The same shape is used for the session being deleted and for every
   * descendant discovered under it, so a restore can put each one back and a
   * permanent delete can finish each one off.
   */
  /** 删除前预览：这个会话产出了哪些文件、各自多大、哪些会被跳过。
   * 纯只读，不改任何东西；用户据此逐条勾选要不要一并删。
   */
  const previewSession = async (sessionId) => {
    assertSessionId(sessionId);
    const dir = await sessionDirOf(sessionId);
    if (dir === undefined) throw Object.assign(new Error("找不到该会话的日志目录"), { code: "session-not-found" });
    const artifact = await findArtifactPath(dir);
    if (artifact === undefined) throw Object.assign(new Error("找不到会话日志文件"), { code: "session-not-found" });
    const { text } = await decompressArtifact(artifact, { maxOutputLength: 256 * 1024 * 1024 });
    let cwd;
    let title;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event === null || typeof event !== "object") continue;
      if (cwd === undefined && event.type === "session" && typeof event.cwd === "string") cwd = event.cwd;
      if (title === undefined && event.type === "session/title" && event.data
        && typeof event.data.title === "string" && event.data.title.trim() !== "") title = event.data.title.trim();
      if (cwd !== undefined && title !== undefined) break;
    }
    const home = homePath();
    const raw = collectProducedFiles(text, cwd);
    const deliveredRes = await classifyProducedFiles(raw.delivered, cwd, home);
    const modifiedRes = await classifyProducedFiles(raw.modified, cwd, home);
    const delivered = deliveredRes.allowed.map(f => ({ ...f, source: "present" }));
    const modified = modifiedRes.allowed.map(f => ({ ...f, source: "modified" }));
    return {
      sessionId,
      cwd: cwd ?? null,
      title: title ?? null,
      delivered,
      modified,
      refused: [...deliveredRes.refused, ...modifiedRes.refused],
      totalBytes: [...delivered, ...modified].reduce((n, f) => n + f.bytes, 0)
    };
  };

  /** 把用户勾选的产出文件**搬进回收站**（不是删），恢复会话时原路搬回。
   *
   * 只认本轮 plan 里出现过的路径（delivered + modified），前端提交的字符串
   * 仅当作「选择意图」，伪造不了范围。搬前 realpath 复核，搬后确认原位置
   * 真的空了——绝不返回「报成功但文件还在」。
   *
   * 调用时机：必须在会话目录已经成功搬走之后。反过来一旦搬目录失败，用户
   * 就会丢掉交付物却留着会话。
   */
  const storeSelectedFiles = async (sessionId, plan, requested) => {
    const wanted = Array.isArray(requested) ? requested.filter(p => typeof p === "string" && p !== "") : [];
    const stored = [];
    const refused = [];
    let bytes = 0;
    if (wanted.length === 0) return { stored, refused, bytes };

    const pool = [
      ...((plan && plan.delivered) || []),
      ...((plan && plan.modified) || [])
    ];
    const allowed = new Map(pool.map(f => [pathKey(f.path), f]));
    const { files: filesRoot } = trashRoots();
    const storeDir = join(filesRoot, sessionId);
    const seen = new Set();

    for (const raw of wanted) {
      const key = pathKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = allowed.get(key) ?? allowed.get(pathKey(resolve(String(raw))));
      if (hit === undefined) {
        refused.push({ path: raw, reason: "不在本次扫描的清单内，已跳过" });
        continue;
      }
      let real;
      try { real = await realpath(hit.path); }
      catch { refused.push({ path: hit.path, reason: "文件已不存在" }); continue; }
      if (pathKey(real) !== pathKey(hit.path)) {
        refused.push({ path: hit.path, reason: "真实路径在扫描后发生变化，已跳过" }); continue;
      }

      await mkdir(storeDir, { recursive: true });
      const target = join(storeDir, `${randomBytes(4).toString("hex")}-${basename(real)}`);
      try {
        await rename(real, target);
      } catch (error) {
        if (error.code !== "EXDEV") { refused.push({ path: real, reason: safeErrorMessage(error) }); continue; }
        // 跨盘（工作区在别的盘）：复制后删源，失败则回滚目标
        try {
          await copyFile(real, target);
          await rm(real, { force: false });
        } catch (copyError) {
          await rm(target, { force: true }).catch(() => {});
          refused.push({ path: real, reason: safeErrorMessage(copyError) });
          continue;
        }
      }
      const stillThere = await lstat(real).then(() => true).catch(() => false);
      if (stillThere) { refused.push({ path: real, reason: "搬移后原文件仍然存在" }); continue; }
      stored.push({ original: real, stored: target, bytes: hit.bytes, source: hit.source });
      bytes += hit.bytes;
    }
    return { stored, refused, bytes };
  };

  /** 恢复时把搬走的文件原路搬回；目标位置已有同名文件就跳过并报告。 */
  const restoreStoredFiles = async (entries) => {
    const restored = [];
    const skipped = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry)) continue;
      const original = entry.original;
      const storedFile = entry.stored;
      if (typeof original !== "string" || typeof storedFile !== "string") continue;
      const existed = await lstat(storedFile).then(() => true).catch(() => false);
      if (!existed) { skipped.push({ original, reason: "回收站里的文件已不存在" }); continue; }
      const occupied = await lstat(original).then(() => true).catch(() => false);
      if (occupied) { skipped.push({ original, reason: "目标位置已有同名文件，未覆盖" }); continue; }
      try {
        await mkdir(dirname(original), { recursive: true });
        try {
          await rename(storedFile, original);
        } catch (error) {
          if (error.code !== "EXDEV") throw error;
          await copyFile(storedFile, original);
          await rm(storedFile, { force: true });
        }
        restored.push(original);
      } catch (error) {
        skipped.push({ original, reason: safeErrorMessage(error) });
      }
    }
    return { restored, skipped };
  };

  // ───────────────────── 标题：先用宿主自己的，再自己解压 ─────────────────────

  /** 宿主投影缓存里的标题，和侧栏 `api-session.list` 完全同源。
   *
   * 出处（照抄，不是自创）：
   *   · 官方 `api-session.list` 的 projectionsFor()：
   *       live 会话 → ctx.sessionProjections.cachedSnapshot(session)
   *       冷会话   → ctx.sessionProjectionCache.cachedSnapshot(header)
   *                  ?? cachedPredecessorTitle(header)
   *   · xohmai/dsh-session-delete 的 cachedTitleFor()：补上两处实测坑
   *       - 旧格式会话的 header 没有 isSeeded（undefined），投影缓存的 identity
   *         匹配永远不等，于是每次重启都退回全量解压 → 这里归一成 false
   *       - snapshot miss 时再试 predecessor，最后才放弃
   *
   * 服务缺失（旧版宿主 / 没挂投影缓存）时返回 undefined，调用方回退本地解压，
   * 不会因为宿主版本不同把面板弄挂。
   */
  const titleFromHostCache = (header) => {
    if (!isRecord(header) || typeof header.id !== "string") return undefined;
    const meta = header.isSeeded === undefined ? { ...header, isSeeded: false } : header;

    // live 会话的标题在内存里：最新，且完全免费
    try {
      const sessions = service("sessions");
      const live = sessions && typeof sessions.get === "function" ? sessions.get(header.id) : undefined;
      const projections = service("sessionProjections");
      if (live !== undefined && projections && typeof projections.cachedSnapshot === "function") {
        const block = projections.cachedSnapshot(live);
        if (block && isRecord(block.values) && typeof block.values.title === "string") return block.values.title;
      }
    } catch { /* 服务实现差异按 miss 处理 */ }

    const cache = service("sessionProjectionCache");
    if (!cache) return undefined;
    try {
      if (meta.isSeeded !== true && typeof cache.cachedSnapshot === "function") {
        const block = cache.cachedSnapshot(meta, 0, ["title"]);
        if (block && isRecord(block.values) && typeof block.values.title === "string") return block.values.title;
      }
      if (typeof cache.cachedPredecessorTitle === "function") {
        const pred = cache.cachedPredecessorTitle(meta, 0);
        if (pred && isRecord(pred.values) && typeof pred.values.title === "string") return pred.values.title;
      }
    } catch { /* miss */ }
    return undefined;
  };

  // ⚠️ 试过但**不用**：sessionQuery.readTitleSnapshots(ids) 批量折叠标题。
  //
  // 2026-11-08 实测（166 个会话 / 181 个日志 / 64 MB）：一次批量调用把 /list
  // 从 3.2 秒推到 4.1 秒，第二次打开还是 3.8 秒——它内部要重扫整个持久化清单
  // 并冷读每个会话日志（readColdSessionLog），比本地并发解压更慢，而且没有
  // 跨调用缓存。标题准确率确实是 100%，但把「本地兜底扫到第 6 帧」修好之后，
  // 本地解压同样 100%，所以这条路径净亏。
  //
  // xohmai/dsh-session-delete 用它，是因为它没有成熟的本地解压兜底；我们有，
  // 而且 mtime:size 缓存能把二次打开压到几十毫秒。真要重新启用，务必：
  //   · 只批量调用一次（逐条调用是准平方级，20 个会话 60 秒都跑不完）；
  //   · 返回的 title 是 SessionTitleSnapshot 对象，要解包成 `.title.title`，
  //     否则对象流到客户端会变成 React 子节点（Minified #31）。

  /** 标题缓存：id → { key, title }，key = `mtime:size`。
   *
   * 日志只会追加，键不变就说明标题没变。除了内存，还落一份盘
   * （`<dshHome>/dsh-session-cleaner/cache/titles.json`），这样 DSH 重启后
   * 第一次打开面板也是毫秒级；否则 166 个会话要重新解压一遍（约 1.5 秒）。
   * 缓存只做加速：读失败、写失败、文件损坏一律当成「没有缓存」继续跑。
   */
  const localTitleCache = new Map();
  let titleCacheLoaded = false;
  let titleCacheDirty = false;
  const titleCacheFile = () => join(homePath("dsh-session-cleaner"), "cache", "titles.json");

  const loadTitleCache = async () => {
    if (titleCacheLoaded) return;
    titleCacheLoaded = true;
    try {
      const parsed = JSON.parse(await readFile(titleCacheFile(), "utf8"));
      if (!isRecord(parsed)) return;
      for (const [id, entry] of Object.entries(parsed)) {
        if (!isRecord(entry) || typeof entry.key !== "string") continue;
        localTitleCache.set(id, { key: entry.key, title: typeof entry.title === "string" ? entry.title : null });
      }
    } catch { /* 没有缓存 / 文件损坏：当空缓存 */ }
  };

  let titleCacheSaving = false;

  const saveTitleCache = async () => {
    // 并发两次 /list 时只让一个写盘；写盘期间新增的条目靠 while 再补一轮。
    if (titleCacheSaving) return;
    titleCacheSaving = true;
    try {
      while (titleCacheDirty) {
        titleCacheDirty = false;
        const file = titleCacheFile();
        await mkdir(dirname(file), { recursive: true });
        const payload = {};
        for (const [id, entry] of localTitleCache) payload[id] = entry;
        const tmp = file + ".tmp";
        await writeFile(tmp, JSON.stringify(payload), "utf8");
        await rename(tmp, file);
      }
    } catch { /* 写不进去不影响功能，下次再说 */ }
    finally { titleCacheSaving = false; }
  };

  const localTitle = async (item) => {
    if (typeof item.artifact !== "string") return undefined;
    let info;
    try { info = await lstat(item.artifact); } catch { return undefined; }
    const key = `${info.mtimeMs}:${info.size}`;
    const cached = localTitleCache.get(item.id);
    if (cached !== undefined && cached.key === key) return cached.title ?? undefined;
    let title;
    try {
      const got = await readHeaderAndTitle(item.artifact);
      title = typeof got.title === "string" ? got.title : undefined;
    } catch { title = undefined; }
    localTitleCache.set(item.id, { key, title: title ?? null });
    titleCacheDirty = true;
    return title;
  };

  /** 会话总览（批量删除面板用）：两级取标题 + 并发元数据。
   *
   * 第一级 本地解压：日志里的最后一条 `session/title` 就是用户改名时写下的
   *   那一条，权威；带 mtime:size 缓存，同一个日志只解一次。
   * 第二级 宿主投影缓存：只用来补「日志里压根没有 title」的空位
   *   （缓存可能略旧，绝不覆盖日志）。
   *
   * 子智能体不列：它们是父会话内部的执行单元，DSH 的侧栏从来不显示，用户
   * 也从没见过它们的名字（都是一句"你是资料核查员…"）。列出来只会造成
   * 「一堆看不懂的东西」。删父会话时它们仍然会被级联带走。
   * 排序按会话创建时间倒序（最近的在上），与侧栏习惯一致。
   */
  const listSessionsForManager = async () => {
    await loadTitleCache();
    const all = await listAllSessionDirs();
    const visible = all.filter(item => typeof item.parentSession !== "string");

    // 一级：本地解压（权威 + mtime:size 缓存）。
    // 为什么本地优先、而不是先问宿主：见上面那段「试过但不用」。实测本地
    // 并发 + 缓存，首次约 1.5 秒、二次几十毫秒；而日志里的最后一条 title
    // 就是用户改名时写下的那一条，正是他要的「实际名字」。
    const titles = new Map();
    await mapLimit(visible, LIST_CONCURRENCY, async (item) => {
      const title = await localTitle(item);
      if (title !== undefined) titles.set(item.id, title);
    });

    // 二级：日志里根本没有 title 事件的会话，才问宿主投影缓存补空。
    // 缓存可能是略旧的值，所以只用来填空、绝不覆盖日志。
    const missing = visible.filter(item => !titles.has(item.id));
    if (missing.length > 0) {
      for (const item of missing) {
        const title = titleFromHostCache(item.header);
        if (title !== undefined) titles.set(item.id, title);
      }
    }

    const out = await mapLimit(visible, LIST_CONCURRENCY, async (item) => {
      let bytes = 0;
      try { bytes = await dirSize(item.dir); } catch { /* 读不动当 0 */ }
      let updatedAt;
      let hasUserMessage = true;
      if (typeof item.artifact === "string") {
        try {
          const info = await lstat(item.artifact);
          updatedAt = info.mtimeMs;
          // 空会话判据：>= 2 KB 的会话必然发过消息，连头 6 帧都不用解；
          // 只有几百字节的小文件才读一遍头部确认。
          if (info.size < 2048) {
            const got = await readHeaderAndTitle(item.artifact, { scanTitle: false });
            if (typeof got.hasUserMessage === "boolean") hasUserMessage = got.hasUserMessage;
          }
        } catch { /* 文件刚好消失：按无时间处理，不影响其余行 */ }
      }
      return {
        id: item.id,
        title: titles.get(item.id) ?? null,
        cwd: typeof item.header.cwd === "string" ? item.header.cwd : null,
        bytes,
        createdAt: typeof item.header.createdAt === "number" ? item.header.createdAt : null,
        updatedAt: updatedAt ?? item.header.createdAt ?? null,
        isBlank: !hasUserMessage,
        isSubagent: false,
        parentSession: null
      };
    });
    out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    await saveTitleCache();
    return out;
  };

  const captureSession = async (sessionId, knownDir) => {
    // 已知目录（后代扫描刚验证过）就不必再全盘找一遍
    const dir = knownDir !== undefined ? knownDir : await sessionDirOf(sessionId);
    const bytes = dir !== undefined ? await dirSize(dir) : 0;
    let info = {};
    let projcacheRow = null;
    if (dir !== undefined) {
      try {
        const artifactPath = await findArtifactPath(dir);
        if (artifactPath !== undefined) info = await sessionInfo(artifactPath);
      } catch (error) { ctx?.logger?.warn?.("session-cleaner: 会话信息解析失败: " + safeErrorMessage(error)); }
      try { projcacheRow = await readProjcacheRow(sessionId); } catch { /* best-effort */ }
    }
    const slot = await captureWorkspaceSlot(sessionId);
    const wasArchived = await isArchivedSession(sessionId);
    const pinIndex = pinnedIndexOf(sessionId);
    const schedules = await listSessionSchedules(sessionId);
    return {
      id: sessionId,
      originalDir: dir !== undefined ? resolve(dir) : undefined,
      workspaceId: slot.workspaceId,
      workspacePath: slot.workspacePath,
      workspaceIndex: slot.index,
      workspaceAnchorId: slot.anchorId,
      workspaceWasLast: slot.wasLast,
      bytes,
      cwd: info.cwd,
      title: info.title,
      turns: info.turns ?? 0,
      userMessages: info.userMessages ?? 0,
      toolCalls: info.toolCalls ?? 0,
      lastTime: info.lastTime,
      projcacheRow,
      wasArchived,
      wasPinned: pinIndex !== undefined,
      pinIndex,
      schedules: schedules.records,
      schedulesSupported: schedules.supported
    };
  };

  /** Take one captured session out of DSH: drop its accounting traces and move
   * its directory into the bin. `targetDir` is where the directory goes.
   * Returns what actually happened so the caller can report it.
   */
  const extractSession = async (snapshot, targetDir, liveSession) => {
    const { id } = snapshot;
    const workspacesDetached = await detachFromWorkspaces(id);
    await unarchiveSession(id);
    await clearPinnedSession(id);
    let filesMoved = false;
    if (typeof snapshot.originalDir === "string") {
      await assertSessionDirectory(homePath("sessions"), snapshot.originalDir, id);
      await mkdir(dirname(targetDir), { recursive: true });
      await rm(targetDir, { recursive: true, force: true });
      await rename(snapshot.originalDir, targetDir);
      // 防「假成功」：再确认原路径真的不在了。Windows 上文件被占用时
      // rename 可能表面成功而留下残影，这种情况一律按失败上报，绝不当成删掉。
      if (await existsDir(snapshot.originalDir)) {
        throw Object.assign(
          new Error("目录移动后原位置仍然存在，删除未生效：" + snapshot.originalDir),
          { code: "move-not-effective" }
        );
      }
      filesMoved = true;
    }
    const cache = await removeProjectionCacheRow(id, liveSession);
    return { filesMoved, workspacesDetached, cache };
  };

  /** Put one captured session back: directory, projection cache, workspace slot
   * at its original position, pin and archive flag. `fromDir` is where the
   * session's directory currently sits (the bin item, or the parent item's
   * `.children/` folder for a descendant).
   */
  const reinstateSession = async (snapshot, fromDir) => {
    const { id } = snapshot;
    let filesRestored = false;
    let restoredTo;
    if (typeof snapshot.originalDir === "string") {
      const root = homePath("sessions");
      const target = resolve(snapshot.originalDir);
      await assertSessionDirectory(root, target, id, { allowMissing: true });
      try {
        await lstat(target);
        throw Object.assign(new Error("目标位置已存在同名会话目录，无法恢复: " + target), { code: "target-exists" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(fromDir, target);
      filesRestored = true;
      restoredTo = target;
    }
    let cacheRestored = false;
    if (typeof snapshot.projcacheRow === "string") {
      try { await writeProjcacheRow(id, snapshot.projcacheRow); cacheRestored = true; }
      catch (error) { ctx?.logger?.warn?.("session-cleaner: 投影缓存行写回失败: " + safeErrorMessage(error)); }
    }
    const slot = await restoreWorkspaceSlot(snapshot, id);
    if (!slot.attached) {
      ctx?.logger?.warn?.("session-cleaner: 记账挂回失败: " + (slot.error ?? "未知原因"));
    }
    let archivedRestored = false;
    let pinRestored = false;
    if (snapshot.wasArchived === true) archivedRestored = await archiveSessionFlag(id);
    else if (snapshot.wasPinned === true) pinRestored = await restorePinnedSession(id, snapshot.pinIndex);
    return {
      sessionId: id,
      attached: slot.attached,
      positionRestored: slot.positionRestored,
      filesRestored,
      cacheRestored,
      archivedRestored,
      pinRestored,
      restoredTo,
      ...(slot.attached ? {} : { warning: typeof restoredTo === "string"
        ? "会话已恢复到磁盘，但未能挂回侧栏（原工作区可能已删除）。文件位置: " + restoredTo
        : "该会话没有磁盘文件，已恢复记账与缓存记录。" })
    };
  };

  /** Finish one captured session off for good: its bin directory (handled by
   * the caller), plus every trace it left — cache row and backups, schedules,
   * and the project directory once it is empty. */
  const finishOffSession = async (snapshot) => {
    const { id } = snapshot;
    const notes = [];
    // 当初搬进回收站的产出文件，彻底删除时才真正销毁
    try {
      await rm(join(trashRoots().files, id), { recursive: true, force: true });
    } catch (error) { notes.push("产出文件清理失败: " + safeErrorMessage(error)); }
    try {
      const cache = await removeProjectionCacheRow(id);
      if (cache.removed || cache.backups > 0) {
        notes.push(`补清投影缓存${cache.backups > 0 ? `（含 ${cache.backups} 个备份）` : ""}`);
      }
    } catch (error) { notes.push("投影缓存清理失败: " + safeErrorMessage(error)); }
    try {
      const schedules = await purgeSessionSchedules(id);
      if (schedules.removed > 0) notes.push(`清除 ${schedules.removed} 个定时任务`);
      if (schedules.error !== undefined) notes.push("定时任务部分失败: " + schedules.error);
    } catch (error) { notes.push("定时任务清理失败: " + safeErrorMessage(error)); }
    if (await removeEmptyProjectDir(snapshot.originalDir)) notes.push("已删空的工程目录");
    return notes;
  };

  const trashSession = async (sessionId, filesToDelete) => {
    assertSessionId(sessionId);
    const live = await teardownLive(sessionId);

    const snapshot = await captureSession(sessionId);
    // 产出文件清单必须在日志还在地盘上时算好；真正删除放到会话目录搬走成功
    // 之后——顺序反过来的话，搬目录失败就会「文件没了、会话还在」。
    // 单删且没勾任何文件时不必扫描（省掉一次全量解压）。
    const producedPlan = (Array.isArray(filesToDelete) && filesToDelete.length > 0)
      ? await previewSession(sessionId)
      : { files: [] };
    // 子会话一起处理：宿主的父 agent 销毁会级联 dispose 子 agent，但子会话的
    // 日志、记账、缓存行不会自己消失。发现顺序即快照顺序，恢复时按同序还原。
    const descendants = [];
    for (const child of await collectDescendants(sessionId)) {
      descendants.push(await captureSession(child.id, child.dir));
    }

    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    await mkdir(itemsRoot, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    const childrenRoot = join(itemsRoot, sessionId, ".children");
    const baseMeta = {
      version: 3,
      id: sessionId,
      originalDir: snapshot.originalDir,
      workspaceId: snapshot.workspaceId,
      workspacePath: snapshot.workspacePath,
      workspaceIndex: snapshot.workspaceIndex,
      workspaceAnchorId: snapshot.workspaceAnchorId,
      workspaceWasLast: snapshot.workspaceWasLast,
      deletedAt: Date.now(),
      bytes: snapshot.bytes,
      cwd: snapshot.cwd,
      title: snapshot.title,
      turns: snapshot.turns,
      userMessages: snapshot.userMessages,
      toolCalls: snapshot.toolCalls,
      lastTime: snapshot.lastTime,
      projcacheRow: snapshot.projcacheRow,
      wasArchived: snapshot.wasArchived,
      wasPinned: snapshot.wasPinned,
      pinIndex: snapshot.pinIndex,
      schedules: snapshot.schedules,
      schedulesSupported: snapshot.schedulesSupported,
      descendants
    };

    // 先写快照再搬文件：中途崩溃只会留下"快照说文件该在回收站但还在原位"，
    // 启动对账能认出来并回滚；反过来（先搬后写）会留下看不见的孤儿目录。
    await rm(join(itemsRoot, sessionId), { recursive: true, force: true });
    await removeMeta(sessionId);
    await writeMeta({ ...baseMeta, stage: META_STAGE_PREPARED, filesMoved: false });

    const extracted = await extractSession(snapshot, join(itemsRoot, sessionId), live.liveSession);
    // 会话目录已安全搬走，此时才动用户的产出文件（失败也只会少删，不会多删）
    const fileResult = await storeSelectedFiles(sessionId, producedPlan, filesToDelete);
    const childResults = [];
    for (const child of descendants) {
      const targetDir = typeof child.originalDir === "string"
        ? join(childrenRoot, child.id)
        : join(childrenRoot, `${child.id}.nofiles`);
      childResults.push({ id: child.id, ...(await extractSession(child, targetDir)) });
    }
    await writeMeta({ ...baseMeta, files: fileResult.stored, stage: META_STAGE_TRASHED, filesMoved: extracted.filesMoved });

    return {
      sessionId,
      trashed: true,
      filesMoved: extracted.filesMoved,
      bytes: snapshot.bytes,
      workspacesDetached: extracted.workspacesDetached,
      cacheRemoved: extracted.cache.removed,
      cacheBackupsRemoved: extracted.cache.backups,
      cacheViaService: extracted.cache.viaService,
      schedulesKept: snapshot.schedules.length,
      schedulesSupported: snapshot.schedulesSupported,
      descendants: childResults.map(r => ({ sessionId: r.id, filesMoved: r.filesMoved })),
      descendantsCount: childResults.length,
      wasPinned: snapshot.wasPinned,
      wasArchived: snapshot.wasArchived,
      wasLiveAgent: live.wasLiveAgent,
      wasLiveSession: live.wasLiveSession,
      // 产出文件处理结果：删掉了哪些、跳过了哪些（附原因）、释放了多少字节
      filesStored: fileResult.stored,
      filesRefused: fileResult.refused,
      filesBytes: fileResult.bytes
    };
  };

  const restoreSession = async (sessionId) => {
    assertSessionId(sessionId);
    const meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });

    // 启动对账收编的孤儿：目录在回收站里，但删除时的快照没了，原路径不可知
    if (meta.stage === META_STAGE_INCOMPLETE) {
      throw Object.assign(
        new Error("这一项缺少删除时的快照，无法确定原路径，只能彻底删除：" + (meta.incomplete ?? "")),
        { code: "incomplete-item" }
      );
    }

    const itemDir = itemDirOf(sessionId);

    // 崩溃窗口：快照写了但文件还没搬走（stage=prepared）。原位仍在就说明
    // 这次删除其实没发生，撤掉残留快照即可，不算一次恢复。
    if (meta.stage === META_STAGE_PREPARED || meta.filesMoved !== true) {
      const stillThere = typeof meta.originalDir === "string" && await existsDir(resolve(meta.originalDir));
      if (stillThere && !(await existsDir(itemDir))) {
        await removeMeta(sessionId);
        return {
          sessionId,
          restored: false,
          recovered: true,
          message: "该会话从未离开原位，已清除回收站里的残留记录。"
        };
      }
    }

    const hasFiles = typeof meta.originalDir === "string";
    if (hasFiles && !(await existsDir(itemDirOf(sessionId)))) {
      throw Object.assign(new Error("回收站数据不完整：会话目录缺失"), { code: "session-not-found" });
    }

    // 子会话先从 .children/ 里搬回原位（父会话的项目录是它们的容器，
    // 不能先把容器搬走），父会话最后回位，然后清掉空容器。
    const childResults = [];
    for (const child of Array.isArray(meta.descendants) ? meta.descendants : []) {
      if (!isRecord(child) || typeof child.id !== "string") continue;
      const childDir = join(itemDirOf(sessionId), ".children", child.id);
      if (typeof child.originalDir === "string" && !(await existsDir(childDir))) {
        throw Object.assign(
          new Error("回收站数据不完整：子会话目录缺失（" + child.id + "）"),
          { code: "session-not-found" }
        );
      }
      childResults.push(await reinstateSession(child, childDir));
    }

    const main = await reinstateSession(meta, itemDirOf(sessionId));
    // 把当初勾选搬走的产出文件原路搬回（这一步失败不影响会话本身已恢复）
    const filesResult = await restoreStoredFiles(meta.files);
    await rm(itemDirOf(sessionId), { recursive: true, force: true });

    // 定时任务从未被搬动，这里只回报它们仍在（宿主不允许原样重建任务）
    const schedules = await listSessionSchedules(sessionId);

    await removeMeta(sessionId);

    return {
      ...main,
      filesRestored: filesResult.restored.length,
      filesSkipped: filesResult.skipped,
      schedulesKept: schedules.records.length,
      archived: meta.wasArchived === true,
      pinned: meta.wasPinned === true,
      descendants: childResults.map(r => ({ sessionId: r.sessionId, filesRestored: r.filesRestored })),
      descendantsCount: childResults.length
    };
  };

  /** Permanently remove binned sessions: the artifact directory, the snapshot,
   * any surviving projection-cache document (plus its backups), any schedule
   * still bound to the session, and the project directory once it is empty.
   * A binned session that carried descendants takes every one of them with it.
   */
  const deleteFromTrash = async (ids) => {
    const { items: itemsRoot } = trashRoots();
    const itemsRootResolved = resolve(itemsRoot);
    const results = [];
    let freedBytes = 0;
    for (const id of ids) {
      assertSessionId(id);
      const itemDir = resolve(itemsRoot, id);
      const rel = relative(itemsRootResolved, itemDir);
      if (rel.split(sep).length !== 1 || rel !== id) {
        throw new Error("回收站路径超出允许范围，已停止删除");
      }
      // 快照与存在性都放在锁内重新读：读锁外的话，"刚被恢复的那一项"会被
      // 当成还在回收站里，于是它的投影缓存行与定时任务被误清。
      try {
        const entry = await mutate(id, async () => {
          const meta = await readMeta(id);
          const itemExists = await existsDir(itemDir);
          if (!itemExists && meta === undefined) {
            return {
              sessionId: id,
              deleted: false,
              skipped: true,
              reason: "回收站里已经没有这一项（可能已被恢复或已被删除）"
            };
          }
          const notes = [];
          await rm(itemDir, { recursive: true, force: true });
          await removeMeta(id);
          freedBytes += Number(meta?.bytes) || 0;

          // 主会话：缓存行 / 定时任务 / 空工程目录
          notes.push(...await finishOffSession(meta ?? { id }));
          // 子会话逐个收尾（目录已随主项一起 rm 掉）
          let descendantsPurged = 0;
          for (const child of Array.isArray(meta?.descendants) ? meta.descendants : []) {
            if (!isRecord(child) || typeof child.id !== "string") continue;
            const childNotes = await finishOffSession(child);
            if (childNotes.length > 0) notes.push(`${child.id}: ${childNotes.join("；")}`);
            descendantsPurged++;
          }

          return {
            sessionId: id,
            deleted: true,
            descendantsPurged,
            ...(notes.length ? { notes } : {})
          };
        });
        results.push(entry);
      } catch (error) {
        results.push({ sessionId: id, deleted: false, error: safeErrorMessage(error) });
      }
    }
    return { results, freedBytes };
  };

  const emptyTrash = async () => {
    const { items } = await listTrash();
    return deleteFromTrash(items.map(item => item.id));
  };

  const searchTrash = async (keyword) => {
    const { items: itemsRoot } = trashRoots();
    const needle = keyword.toLowerCase();
    const { items } = await listTrash();
    const matches = {};
    for (const meta of items) {
      let count = typeof meta.title === "string" && meta.title.toLowerCase().includes(needle) ? 1 : 0;
      try {
        const artifact = await findArtifactPath(join(itemsRoot, meta.id));
        if (artifact !== undefined) {
          const { text: logText } = await decompressArtifact(artifact, { maxOutputLength: 256 * 1024 * 1024 });
          // 只搜「用户提问 + 助手正文输出」：思考块、工具调用噪声不算对话内容
          let spoken = "";
          for (const line of logText.split("\n")) {
            if (line === "") continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (e === null || typeof e !== "object" || !e.data) continue;
            if (e.type === "user/message" && e.data.source && e.data.source.kind === "user") {
              spoken += "\n" + textFromContent(e.data.content);
            } else if (e.type === "assistant/message") {
              // 助手文本在 data.message.content（真实日志结构，与 cmdDetail 同源）
              spoken += "\n" + textFromContent(e.data.message ? e.data.message.content : undefined);
            }
            if (spoken.length > 5 * 1024 * 1024) break;
          }
          const lower = spoken.toLowerCase();
          let idx = 0;
          let hits = 0;
          while ((idx = lower.indexOf(needle, idx)) !== -1 && hits < 10000) { hits++; idx += needle.length; }
          count += hits;
        }
      } catch { /* 日志读不出来就只算标题命中 */ }
      if (count > 0) matches[meta.id] = count;
    }
    return { keyword, scanned: items.length, matches };
  };

  /** 会话的工程目录（<sessions>/<项目段>/）在最后一个会话离开后一并删掉。 */
  const removeEmptyProjectDir = async (originalDir) => {
    if (typeof originalDir !== "string" || originalDir === "") return false;
    const root = homePath("sessions");
    if (typeof root !== "string") return false;
    const projectDir = dirname(resolve(originalDir));
    const rel = relative(resolve(root), projectDir);
    if (isAbsolute(rel) || rel === "" || rel.includes("..") || rel.split(sep).length !== 1) return false;
    try {
      if ((await readdir(projectDir)).length > 0) return false;
      await rmdir(projectDir);
      return true;
    } catch { return false; }
  };

  const purgeExpiredTrash = async () => {
    const { items } = await listTrash();
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const expired = items.filter(item => typeof item.deletedAt !== "number" || item.deletedAt < cutoff);
    if (expired.length === 0) return { removed: 0 };
    const result = await deleteFromTrash(expired.map(item => item.id));
    const removed = result.results.filter(r => r.deleted).length;
    ctx?.logger?.info?.(`session-cleaner: 回收站自动清理 ${removed} 条超过 ${TRASH_RETENTION_DAYS} 天的会话`);
    return { removed };
  };

  /** 下次自动清理的时刻，供面板展示（启动跑一次，之后按间隔跑）。 */
  let nextPurgeAt = Date.now() + TRASH_PURGE_INTERVAL_MS;

  const runRetentionPurge = async () => {
    try { return await purgeExpiredTrash(); }
    catch (error) {
      ctx?.logger?.warn?.("session-cleaner: 回收站过期清理失败: " + safeErrorMessage(error));
      return { removed: 0 };
    } finally {
      nextPurgeAt = Date.now() + TRASH_PURGE_INTERVAL_MS;
    }
  };

  function existsDir(path) {
    return lstat(path).then(info => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
  }

  /** 回收站内查看对话记录：解压日志按事件流还原每轮提问（与黑窗口 d N 同源）。 */
  const trashDetail = async (sessionId) => {
    assertSessionId(sessionId);
    const meta = await readMeta(sessionId);
    if (meta === undefined) throw Object.assign(new Error("回收站里没有这个会话"), { code: "session-not-found" });
    const { items: itemsRoot } = trashRoots();
    const result = {
      sessionId,
      title: meta.title,
      cwd: meta.cwd,
      turns: meta.turns ?? 0,
      userMessages: meta.userMessages ?? 0,
      toolCalls: meta.toolCalls ?? 0,
      bytes: meta.bytes ?? 0,
      lastTime: meta.lastTime,
      deletedAt: meta.deletedAt,
      questions: []
    };
    if (typeof meta.originalDir !== "string") return result; // 无磁盘文件的空白会话
    const artifact = await findArtifactPath(join(itemsRoot, sessionId));
    if (artifact === undefined) return result;
    try {
      const { text } = await decompressArtifact(artifact);
      // 解析逻辑与 session-lib.mjs 的 cmdDetail 同源：
      //   助手文本在 e.data.message.content（不是 e.data.content！），
      //   轮次优先取 e.data.turn，一轮内多条助手消息取最后一条。
      let turnCounter = 0;
      const questions = [];
      let pendingTools = 0;
      let openQuestion;
      let lastAssistant = undefined;
      let lastAssistantModel = undefined;
      let lastThinking = undefined;
      let lastFailure = undefined;
      const flushTurn = () => {
        if (openQuestion !== undefined) {
          openQuestion.toolCalls = pendingTools;
          openQuestion.assistantReply = lastAssistant ? elideMiddle(lastAssistant, 20000, 12000, 6000) : "";
          if (lastAssistantModel !== undefined) openQuestion.model = lastAssistantModel;
          // 没有正文时把「为什么没有」如实告诉用户：模型报错？只思考没结论？
          // 还是压根没记录？三种情况分开标，不留一片空白让人以为点不开。
          if (openQuestion.assistantReply === "") {
            if (lastFailure !== undefined) openQuestion.failure = lastFailure;
            else if (lastThinking !== undefined) openQuestion.thinking = elideMiddle(lastThinking, 1500, 1000, 400);
            else openQuestion.noReply = true;
          }
          questions.push(openQuestion);
          openQuestion = undefined;
        }
        pendingTools = 0;
        lastAssistant = undefined;
        lastAssistantModel = undefined;
        lastThinking = undefined;
        lastFailure = undefined;
      };
      for (const line of text.split("\n")) {
        if (line === "") continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e === null || typeof e !== "object") continue;
        switch (e.type) {
          case "turn/start":
            flushTurn();
            turnCounter += 1;
            break;
          case "user/message": {
            if (!e.data || !e.data.source || e.data.source.kind !== "user") break;
            const questionText = textFromContent(e.data.content);
            if (questionText === "") break;
            openQuestion = {
              turn: typeof e.data.turn === "number" ? e.data.turn : (turnCounter || undefined),
              time: typeof e.time === "number" ? e.time : undefined,
              question: collapseText(questionText, 500),
              toolCalls: 0,
              assistantReply: ""
            };
            break;
          }
          case "assistant/message": {
            const msg = e.data && e.data.message;
            const parts = blocksOf(msg ? msg.content : undefined);
            if (parts.thinking !== "") lastThinking = parts.thinking;
            if (parts.text !== "") {
              lastAssistant = parts.text;
              // 模型名挂在 message.source.model（真实日志结构，如 "deepseek-flash"）
              if (msg && msg.source && typeof msg.source.model === "string" && msg.source.model !== "") {
                lastAssistantModel = msg.source.model;
              }
              if (openQuestion !== undefined && typeof e.data.turn === "number" && openQuestion.turn === undefined) {
                openQuestion.turn = e.data.turn;
              }
            }
            break;
          }
          case "assistant/attempt": {
            // 失败轮次没有 assistant/message，原因只在 attempt 的 finish 帧里
            const failure = attemptFailure(e.data);
            if (failure !== undefined) lastFailure = failure;
            break;
          }
          case "tool/call":
            pendingTools += 1;
            break;
          default:
            break;
        }
      }
      flushTurn();
      result.questions = questions;
    } catch (error) {
      result.parseError = safeErrorMessage(error);
      ctx?.logger?.warn?.("session-cleaner: 回收站对话记录解析失败: " + safeErrorMessage(error));
    }
    return result;
  };

  /** 启动对账：把回收站的两半（items/ 与 meta/）对齐，修掉崩溃留下的中间态。
   *
   *  - stage=prepared（快照已写、文件还没搬完）按"全有或全无"处理：
   *    该会话连同它的子会话，每一个都进了回收站 → 升级为 trashed；
   *    只要还有一个留在原位 → 整次删除没发生，把已搬走的逐个搬回原位并撤掉快照
   *  - trashed 但原位又出现（恢复的最后一步崩溃）→ 撤掉快照
   *  - 有目录、没有快照（旧版本或异常中断的孤儿）→ 造一条 stage=incomplete 的快照，
   *    让它至少可见、可彻底删除，而不是永远占着磁盘又显示不出来
   *  - 残留的 .tmp 快照 → 删掉
   */
  const reconcileTrash = async () => {
    const { items: itemsRoot, meta: metaRoot } = trashRoots();
    const report = { repaired: 0, rolledBack: 0, adopted: 0, tempRemoved: 0 };

    let metaFiles = [];
    try { metaFiles = await readdir(metaRoot); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const file of metaFiles) {
      if (file.endsWith(".tmp")) {
        await rm(join(metaRoot, file), { force: true }).catch(() => {});
        report.tempRemoved++;
        continue;
      }
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      let meta;
      try { meta = JSON.parse(await readFile(join(metaRoot, file), "utf8")); }
      catch { continue; }
      if (!isRecord(meta) || typeof meta.id !== "string") continue;

      const descendants = Array.isArray(meta.descendants) ? meta.descendants.filter(isRecord) : [];
      const itemDir = itemDirOf(id);
      const binDirOf = (childId) => join(itemDir, ".children", childId);

      // 每个成员各自"在回收站里"还是"还在原位"
      const members = [
        { id, originalDir: meta.originalDir, binDir: itemDir },
        ...descendants.map(child => ({
          id: child.id,
          originalDir: child.originalDir,
          binDir: binDirOf(child.id)
        }))
      ].filter(m => typeof m.id === "string");
      const state = [];
      for (const m of members) {
        state.push({
          ...m,
          inBin: await existsDir(m.binDir),
          atHome: typeof m.originalDir === "string" && await existsDir(resolve(m.originalDir))
        });
      }

      if (meta.stage === META_STAGE_PREPARED || meta.filesMoved !== true) {
        const allInBin = state.every(m => m.inBin || typeof m.originalDir !== "string");
        if (allInBin) {
          await writeMeta({ ...meta, stage: META_STAGE_TRASHED, filesMoved: true });
          report.repaired++;
        } else {
          // 整次删除没发生：把已搬进回收站的逐个搬回原位。复用恢复逻辑，
          // 连同投影缓存行、侧栏记账、置顶/归档一起还原——否则会留下
          // "文件回来了、却从侧栏消失且标题丢失"的半坏状态。
          for (const m of state) {
            if (!m.inBin) continue;
            const snapshot = m.id === id ? meta : descendants.find(d => d.id === m.id);
            if (!isRecord(snapshot)) continue;
            await reinstateSession(snapshot, m.binDir).catch(() => {});
          }
          await removeMeta(id);
          report.rolledBack++;
        }
      } else if (!(await existsDir(itemDir)) && typeof meta.originalDir === "string"
        && await existsDir(resolve(meta.originalDir))) {
        // 文件已经搬回原位，快照却没删掉（恢复的最后一步崩溃）
        await removeMeta(id);
        report.rolledBack++;
      }
    }

    let itemDirs = [];
    try {
      itemDirs = (await readdir(itemsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => entry.name);
    } catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const id of itemDirs) {
      try { assertSessionId(id); } catch { continue; }
      if (await readMeta(id) !== undefined) continue;
      const bytes = await dirSize(itemDirOf(id)).catch(() => 0);
      await writeMeta({
        version: 3,
        id,
        stage: META_STAGE_INCOMPLETE,
        filesMoved: true,
        deletedAt: Date.now(),
        bytes,
        incomplete: "缺少删除时的快照（异常中断留下的），无法确定原路径，只能彻底删除"
      });
      report.adopted++;
    }

    if (report.repaired + report.rolledBack + report.adopted + report.tempRemoved > 0) {
      ctx?.logger?.info?.("session-cleaner: 回收站对账 → 修复 " + report.repaired
        + " / 回滚 " + report.rolledBack + " / 收编孤儿 " + report.adopted
        + " / 清临时 " + report.tempRemoved);
    }
    return report;
  };

  // 启动对账与过期清理都延后，不跟宿主启动抢磁盘。
  //
  // 崩溃对账本来就是「下次启动时」的补救动作，晚 15 秒没有任何正确性代价；
  // 但 DSH 启动瞬间已经有几十个插件在抢 I/O，这一步能实打实少一条启动长尾。
  // 两个定时器都 unref：它们不该把 Node 进程钉在活着状态。
  ctx.effect(() => {
    const kickoff = setTimeout(() => {
      reconcileTrash().catch(() => {});
      runRetentionPurge().catch(() => {});
    }, STARTUP_SETTLE_MS);
    if (typeof kickoff?.unref === "function") kickoff.unref();
    const timer = setInterval(() => { void runRetentionPurge(); }, TRASH_PURGE_INTERVAL_MS);
    if (typeof timer?.unref === "function") timer.unref();
    return () => { clearTimeout(kickoff); clearInterval(timer); };
  }, "session-cleaner: trash reconciliation and retention");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";
        let body = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); }
            catch { return send(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (req.method === "GET" && path === "/health") {
          return send(res, 200, { ok: true, result: { plugin: name } });
        }
        // 删除前预览产出文件（纯只读，供前端勾选）
        if (req.method === "POST" && path === "/preview") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => previewSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        // 批量删除面板：会话总览（只读，不解压日志）
        if (req.method === "POST" && path === "/list") {
          const items = await listSessionsForManager();
          return send(res, 200, { ok: true, result: { items } });
        }
        // 批量删除：只删会话记录（含子代理树），绝不碰工作区文件
        if (req.method === "POST" && path === "/trash/batch") {
          const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [];
          const ids = Array.from(new Set(
            rawIds.filter(x => typeof x === "string" && x.trim() !== "").map(x => x.trim())
          ));
          if (ids.length === 0) return send(res, 400, { ok: false, error: "sessionIds 必须是非空数组", code: "bad-request" });
          if (ids.length > 100) return send(res, 400, { ok: false, error: "一次最多删除 100 个会话", code: "bad-request" });
          for (const id of ids) assertSessionId(id);
          const result = await mutateBatch(async () => {
            const done = [];
            for (const id of ids) {
              try {
                await trashSession(id, []);
                done.push({ sessionId: id, ok: true });
              } catch (error) {
                done.push({ sessionId: id, ok: false, error: safeErrorMessage(error) });
              }
            }
            return { results: done, deleted: done.filter(d => d.ok).length, failed: done.filter(d => !d.ok).length };
          });
          return send(res, 200, { ok: true, result });
        }
        // 单会话操作：全部走同一个会话锁（同一 id 的"恢复"与"彻底删除"不会交错）
        if (req.method === "POST" && path === "/trash") {
          assertSessionId(sessionId);
          // files 只接受字符串数组；宿主端会重新扫描核对，前端伪造的范围无效
          const files = Array.isArray(body.files) ? body.files : [];
          const result = await mutate(sessionId, () => trashSession(sessionId, files));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/list") {
          const result = await listTrash();
          return send(res, 200, {
            ok: true,
            result: {
              ...result,
              retentionDays: TRASH_RETENTION_DAYS,
              nextPurgeAt,
              schedulesSupported: scheduleService() !== undefined
            }
          });
        }
        if (req.method === "POST" && path === "/trash/search") {
          const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
          if (keyword === "") return send(res, 400, { ok: false, error: "keyword 必填", code: "bad-request" });
          const result = await searchTrash(keyword);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/detail") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => trashDetail(sessionId));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/restore") {
          assertSessionId(sessionId);
          const result = await mutate(sessionId, () => restoreSession(sessionId));
          return send(res, 200, { ok: true, result });
        }
        // 批量操作：先占批量位，再逐条占各自的会话位（batch → id，无死锁）
        if (req.method === "POST" && path === "/trash/delete") {
          const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [sessionId];
          const ids = Array.from(new Set(rawIds.filter(id => typeof id === "string" && id.trim() !== "").map(id => id.trim())));
          if (ids.length === 0) return send(res, 400, { ok: false, error: "sessionIds 必须是非空数组", code: "bad-request" });
          for (const id of ids) assertSessionId(id);
          const result = await mutateBatch(() => deleteFromTrash(ids));
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/trash/empty") {
          const result = await mutateBatch(() => emptyTrash());
          return send(res, 200, { ok: true, result });
        }
        return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
      } catch (error) {
        ctx?.logger?.warn?.("session-cleaner: api error: " + safeErrorMessage(error));
        const status = error?.code === "bad-request" || error?.code === "body-too-large" ? 400
          : error?.code === "session-not-found" ? 404
          : error?.code === "session-active" || error?.code === "duplicate-session-dirs" || error?.code === "incomplete-item" ? 409
          : 500;
        return send(res, status, { ok: false, error: safeErrorMessage(error), ...(typeof error?.code === "string" ? { code: error.code } : {}) });
      }
    }
  }), "session-cleaner: http api");
}
