/**
 * dsh-session-cleaner — Client half.
 *
 * 三块能力：
 *   1. 侧栏会话 `···` 菜单里的红色「删除」项 → 确认后移入回收站；
 *   2. 侧栏底部「会话回收站」按钮（与会话管理同款位置/适配）→ 面板：
 *      标题与正文搜索、工作区筛选、排序、恢复、彻底删除（单条/批量/清空）；
 *   3. shell.overlay 确认框（菜单关闭后仍存活，自带深浅色主题）。
 *
 * No build step: DSH loads this file as a Cordis client bundle via the
 * dsh.client declaration in package.json.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-cleaner",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    const NS = "session-cleaner";
    const API = "/session-cleaner/api";

    // apply(ctx) 时挂上的宿主上下文引用，供恢复后刷新侧栏、删除后清主视图用。
    let hostCtx = undefined;

    const zh = {
      "menu.delete": "删除",
      "dialog.loading": "正在读取会话信息…",
      "dialog.retention": "回收站保留 15 天，之后自动清除。",
      "trash.nextPurge": "下次自动清理 {time}",
      "dialog.cancel": "取消",
      "dialog.error": "操作失败：{message}",
      "dialog.close": "关闭",
      "toast.trashed": "会话已删除至回收站",
      "toast.filesDeleted": "（已删 {n} 个产出文件）",
      "toast.trashFailed": "移入回收站失败：{message}",
      "confirm.title": "删除对话",
      "confirm.session": "会话",
      "confirm.cwd": "工作目录",
      "confirm.noFiles": "这个会话没有产出文件，直接删除即可。",
      "confirm.filesTitle": "产出文件 {n} 个，共 {size}",
      "confirm.selectAll": "全选",
      "confirm.deselectAll": "全不选",
      "confirm.ops": "写入 {n} 次",
      "confirm.fileWarning": "文件会一起搬进回收站，恢复会话时原路搬回；取消勾选的文件留在原处。",
      "confirm.selectedBytes": "将删除 {size} 的文件",
      "confirm.skipped": "已跳过 {n} 项（不可删除）",
      "confirm.deliveredTag": "交付物",
      "confirm.modifiedTag": "中间产物",
      "confirm.previewFailed": "读取产出文件失败：{message}。下面只会删除会话记录，不动任何文件。",
      "confirm.delete": "删除对话",
      "confirm.deleting": "删除中…",
      "manager.title": "会话管理",
      "manager.back": "返回",
      "manager.untitled": "（无标题）",
      "manager.countInDay": "{n} 个会话",
      "manager.blankTag": "空会话",
      "manager.selectBlank": "选中 {n} 个空会话",
      "manager.hint": "勾选要删除的会话。批量删除只删会话记录（含子代理），不碰工作区里的文件；要连文件一起清，请用侧栏行菜单单个删除。",
      "manager.empty": "没有会话。",
      "manager.loading": "读取中…",
      "manager.subagent": "子代理",
      "manager.selectAll": "全选",
      "manager.deselectAll": "全不选",
      "manager.selected": "已选 {n} 项",
      "manager.deleteSelected": "删除所选",
      "manager.confirmDelete": "确定删除所选的 {n} 个会话？它们会进入回收站，15 天内可恢复。",
      "manager.deleting": "删除中…",
      "manager.done": "已删除 {n} 个会话",
      "info.title": "会话名称",
      "info.cwd": "工作目录",
      "info.turns": "对话轮次",
      "info.userMessages": "用户消息",
      "info.toolCalls": "工具调用",
      "info.size": "大小",
      "info.lastActive": "最后活动",
      "unit.turns": "轮",
      "unit.messages": "条",
      "unit.calls": "次",
      "unit.items": "项",
      "trash.title": "已删除会话",
      "trash.count": "共 {n} 项 · 占用 {size}",
      "trash.search": "搜索标题，或勾选后搜正文内容",
      "trash.searchContent": "搜正文",
      "trash.searching": "正在搜索正文…",
      "trash.workspaceAll": "全部工作区",
      "trash.sortDeleted": "删除时间",
      "trash.sortTitle": "标题",
      "trash.sortSize": "大小",
      "trash.sortTurns": "轮次",
      "trash.restore": "恢复",
      "trash.purge": "彻底删除",
      "trash.selectAll": "全选",
      "trash.deselectAll": "全不选",
      "trash.selected": "已选 {n} 项",
      "trash.restoreSelected": "恢复所选",
      "trash.purgeSelected": "彻底删除所选",
      "trash.emptyBin": "清空回收站",
      "trash.confirmPurge": "确认彻底删除所选 {n} 项？此操作不可恢复。",
      "trash.confirmEmpty": "确认清空回收站（共 {n} 项）？此操作不可恢复。",
      "trash.confirmRestore": "恢复 {n} 个会话到原工作区？",
      "trash.deletedTag": "已删除",
      "trash.confirm": "确认",
      "trash.restored": "已恢复到侧栏",
      "trash.restoredArchived": "已恢复到归档列表",
      "trash.restoredMixed": "已恢复（部分回到归档列表）",
      "trash.purged": "已彻底删除",
      "trash.emptyDone": "回收站已清空",
      "trash.deletedAt": "删除于",
      "trash.emptyState": "回收站是空的",
      "trash.searchHit": "{n} 处匹配",
      "trash.searchNone": "没有匹配的内容",
      "trash.restoreWarning": "恢复后原工作区可能已变化，若侧栏未出现请稍候或刷新。",
      "trash.viewLog": "查看对话记录",
      "sort.asc": "升序",
      "sort.desc": "降序",
      "detail.back": "返回",
      "detail.title": "对话记录",
      "detail.questions": "提问记录（共 {n} 条）",
      "detail.failed": "这一轮没有回复，模型报错：{message}",
      "detail.thinkingOnly": "这一轮只有思考过程，没有最终回复（点开看思考）",
      "detail.noReply": "（这一轮没有记录到助手回复）",
      "detail.turn": "第 {n} 轮",
      "detail.tools": "工具 {n} 次",
      "detail.noQuestions": "这个会话没有提问记录（可能是空白会话或子代理会话）。",
      "detail.loading": "正在读取对话记录…"
    };
    const en = {
      "menu.delete": "Delete",
      "dialog.loading": "Loading session info…",
      "dialog.retention": "The recycle bin keeps sessions for 15 days, then clears them automatically.",
      "trash.nextPurge": "next auto-purge {time}",
      "dialog.cancel": "Cancel",
      "dialog.error": "Operation failed: {message}",
      "dialog.close": "Close",
      "toast.trashed": "Session moved to recycle bin",
      "toast.filesDeleted": "({n} produced file(s) deleted)",
      "toast.trashFailed": "Failed to move to recycle bin: {message}",
      "confirm.title": "Delete conversation",
      "confirm.session": "Session",
      "confirm.cwd": "Working directory",
      "confirm.noFiles": "This session produced no files. Deleting it will just remove the record.",
      "confirm.filesTitle": "{n} produced file(s), {size} total",
      "confirm.selectAll": "Select all",
      "confirm.deselectAll": "Deselect all",
      "confirm.ops": "written {n}x",
      "confirm.fileWarning": "Files move into the recycle bin together with the session and come back if you restore it. Files you uncheck stay where they are.",
      "confirm.selectedBytes": "{size} of files will be deleted",
      "confirm.skipped": "{n} item(s) skipped (not deletable)",
      "confirm.deliveredTag": "delivered",
      "confirm.modifiedTag": "intermediate",
      "confirm.previewFailed": "Could not read produced files: {message}. Only the session record will be deleted; no files will be touched.",
      "confirm.delete": "Delete conversation",
      "confirm.deleting": "Deleting…",
      "manager.title": "Manage sessions",
      "manager.back": "Back",
      "manager.untitled": "(untitled)",
      "manager.countInDay": "{n} session(s)",
      "manager.blankTag": "empty",
      "manager.selectBlank": "Select {n} empty session(s)",
      "manager.hint": "Tick the sessions to delete. Batch delete removes the session record (and its subagents) only — files in your workspace are left alone. To clean files too, delete a single session from its row menu.",
      "manager.empty": "No sessions.",
      "manager.loading": "Loading…",
      "manager.subagent": "subagent",
      "manager.selectAll": "Select all",
      "manager.deselectAll": "Deselect all",
      "manager.selected": "{n} selected",
      "manager.deleteSelected": "Delete selected",
      "manager.confirmDelete": "Delete {n} selected session(s)? They go to the recycle bin and can be restored within 15 days.",
      "manager.deleting": "Deleting…",
      "manager.done": "Deleted {n} session(s)",
      "info.title": "Session",
      "info.cwd": "Workspace",
      "info.turns": "Turns",
      "info.userMessages": "User messages",
      "info.toolCalls": "Tool calls",
      "info.size": "Size",
      "info.lastActive": "Last activity",
      "unit.turns": "turns",
      "unit.messages": "messages",
      "unit.calls": "calls",
      "unit.items": "items",
      "trash.title": "Recycle bin",
      "trash.count": "{n} items · {size}",
      "trash.search": "Search titles, or check the box to search content",
      "trash.searchContent": "Search content",
      "trash.searching": "Searching content…",
      "trash.workspaceAll": "All workspaces",
      "trash.sortDeleted": "Deleted time",
      "trash.sortTitle": "Title",
      "trash.sortSize": "Size",
      "trash.sortTurns": "Turns",
      "trash.restore": "Restore",
      "trash.purge": "Delete forever",
      "trash.selectAll": "Select all",
      "trash.deselectAll": "Deselect all",
      "trash.selected": "{n} selected",
      "trash.restoreSelected": "Restore selected",
      "trash.purgeSelected": "Delete selected forever",
      "trash.emptyBin": "Empty recycle bin",
      "trash.confirmPurge": "Permanently delete the selected {n} item(s)? This cannot be undone.",
      "trash.confirmEmpty": "Empty the recycle bin ({n} items)? This cannot be undone.",
      "trash.confirmRestore": "Restore {n} session(s) to their original workspace?",
      "trash.deletedTag": "deleted",
      "trash.confirm": "Confirm",
      "trash.restored": "Restored to sidebar",
      "trash.restoredArchived": "Restored to the archive",
      "trash.restoredMixed": "Restored (some into the archive)",
      "trash.purged": "Deleted forever",
      "trash.emptyDone": "Recycle bin emptied",
      "trash.deletedAt": "Deleted",
      "trash.emptyState": "The recycle bin is empty",
      "trash.searchHit": "{n} hits",
      "trash.searchNone": "No matching content",
      "trash.restoreWarning": "The original workspace may have changed; if the session does not appear, wait or refresh.",
      "trash.viewLog": "View conversation",
      "sort.asc": "Ascending",
      "sort.desc": "Descending",
      "detail.back": "Back",
      "detail.title": "Conversation log",
      "detail.questions": "Questions ({n})",
      "detail.failed": "No reply this turn; model error: {message}",
      "detail.thinkingOnly": "Only reasoning this turn, no final reply (click to expand)",
      "detail.noReply": "(no assistant reply recorded for this turn)",
      "detail.turn": "Turn {n}",
      "detail.tools": "{n} tool calls",
      "detail.noQuestions": "No questions recorded (this may be a blank or subagent session).",
      "detail.loading": "Loading conversation…"
    };

    const formatBytes = (bytes) => {
      if (!Number.isFinite(bytes) || bytes < 0) return "?";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    };

    const formatTime = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      try {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      } catch { return "—"; }
    };

    /** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前，超过一周退回具体日期。 */
    const relativeTime = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
      const diff = Date.now() - ms;
      if (diff < 0) return formatTime(ms);
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return "刚刚";
      if (minutes < 60) return minutes + " 分钟前";
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + " 小时前";
      const days = Math.floor(hours / 24);
      if (days < 7) return days + " 天前";
      return formatTime(ms);
    };

    /** 分组用的日期键（本地时区）。 */
    const dayKeyOf = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    };

    /** 日期分组的标题文案：今天 / 昨天 / 2026 年 11 月 5 日。 */
    const dayLabelOf = (key) => {
      if (key === "") return "未知日期";
      if (key === dayKeyOf(Date.now())) return "今天";
      if (key === dayKeyOf(Date.now() - 86400000)) return "昨天";
      return key.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1 年 $2 月 $3 日");
    };

    const callApi = (path, payload) => fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then((r) => r.json());

    const refreshSidebar = async () => {
      // 恢复回来的会话不是 live 的，宿主不会主动推 added，必须拉一次 baseline 列表；
      // 工作区状态由宿主的推送流维护（workspaces 服务没有 refresh 方法），无从也无需刷。
      try { if (hostCtx?.sessions?.refresh) await hostCtx.sessions.refresh(); } catch { /* best-effort */ }
    };

    // ───────────────────────── 主题探测（不依赖 DSH 变量） ─────────────────────────

    function detectTheme() {
      try {
        // DSH 的主题呈现器把当前配色写在 body[data-ds-dark-theme] 上
        // （设置里 light/dark/system 三选一，只有 system 才跟随系统），
        // 属性在不在就是权威信号；先看它，避免"系统深色 + 应用内浅色"被误判。
        const body = document.body;
        if (body) {
          if (body.hasAttribute("data-ds-dark-theme")) return "dark";
          // 主题已投影（内联了 --dsw-alias-* 令牌）但属性缺席 ⇒ 明确是浅色，
          // 不必再猜；否则继续用下面的兜底判断。
          if (body.style.getPropertyValue("--dsw-alias-label-primary") !== "") return "light";
        }
      } catch { /* fall through */ }
      try {
        const color = getComputedStyle(document.body).color || "";
        const parts = color.match(/\d+(?:\.\d+)?/g);
        if (parts && parts.length >= 3) {
          const luminance = 0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2]);
          if (luminance > 160) return "dark";
          if (luminance < 96) return "light";
        }
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (mq) return mq.matches ? "dark" : "light";
      } catch { /* fall through */ }
      return "light";
    }

    function useTheme() {
      const [theme, setTheme] = useState(() => detectTheme());
      useEffect(() => {
        const listener = () => setTheme(detectTheme());
        const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (mq) {
          if (typeof mq.addEventListener === "function") mq.addEventListener("change", listener);
          else if (typeof mq.addListener === "function") mq.addListener(listener);
        }
        // 设置里手动切换主题时，DSH 只改 body 上的属性，不会触发媒体查询
        const observer = typeof MutationObserver === "function" && document.body
          ? new MutationObserver(listener)
          : null;
        if (observer) observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "style"] });
        return () => {
          if (mq) {
            if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", listener);
            else if (typeof mq.removeListener === "function") mq.removeListener(listener);
          }
          if (observer) observer.disconnect();
        };
      }, []);
      return theme;
    }

    const paletteFor = (theme) => theme === "dark" ? {
      layer: "rgba(0,0,0,.55)",
      panel: "#232326",
      panelBorder: "rgba(255,255,255,.14)",
      shadow: "0 8px 28px rgba(0,0,0,.5)",
      text: "#f1f1f3",
      secondary: "#a9a9b2",
      danger: "#f0616d",
      success: "#5ad197",
      btnBorder: "rgba(255,255,255,.2)",
      rowBorder: "rgba(255,255,255,.1)",
      inputBg: "#1b1b1e",
      user: "#7ab0ff",
      model: "#5ad197",
      turn: "#b99cf5"
    } : {
      layer: "rgba(0,0,0,.4)",
      panel: "#ffffff",
      panelBorder: "rgba(0,0,0,.12)",
      shadow: "0 8px 28px rgba(0,0,0,.18)",
      text: "#1f2328",
      secondary: "#67707c",
      danger: "#d92d20",
      success: "#1a7f37",
      btnBorder: "rgba(0,0,0,.16)",
      rowBorder: "rgba(0,0,0,.08)",
      inputBg: "#ffffff",
      user: "#1a6bed",
      model: "#1a7f37",
      turn: "#7c4ddb"
    };

    /** 极简 Markdown 渲染（无构建环境，手写常用子集）：
     *  代码块/行内代码/标题/加粗/无序与有序列表/引用/链接。
     */
    function renderMarkdown(src, palette) {
      const inline = (text, keyPrefix) => {
        const nodes = [];
        const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g;
        let last = 0;
        let m;
        let n = 0;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) nodes.push(text.slice(last, m.index));
          const tok = m[0];
          if (tok.startsWith("`")) {
            nodes.push(h("code", { key: keyPrefix + "-i" + n++ }, tok.slice(1, -1)));
          } else if (tok.startsWith("**")) {
            nodes.push(h("strong", { key: keyPrefix + "-b" + n++ }, tok.slice(2, -2)));
          } else {
            const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
            nodes.push(h("span", { key: keyPrefix + "-l" + n++, style: { textDecoration: "underline", wordBreak: "break-all" } }, mm[1] + "（" + mm[2] + "）"));
          }
          last = m.index + tok.length;
        }
        if (last < text.length) nodes.push(text.slice(last));
        return nodes;
      };
      const blocks = [];
      const lines = String(src).split("\n");
      const isBlockStart = (line) => /^\s*(```|#{1,4}\s|[-*]\s+|\d+[.)]\s+|>\s?)/.test(line);
      let i = 0;
      let key = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") { i++; continue; }
        if (/^\s*```/.test(line)) {
          const code = [];
          i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
          if (i < lines.length) i++;
          blocks.push(h("pre", { key: "k" + key++ }, h("code", null, code.join("\n"))));
          continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          blocks.push(h("div", { key: "k" + key++, style: { fontWeight: 700, fontSize: level <= 2 ? 15 : 13.5, margin: "8px 0 4px" } }, inline(heading[2], "h" + key)));
          i++;
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
          blocks.push(h("div", { key: "k" + key++, style: { margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 } },
            items.map((item, j) => h("div", { key: j, style: { display: "flex", gap: 6 } },
              h("span", { style: { color: palette.secondary } }, "•"),
              h("span", { style: { flex: 1 } }, inline(item, "li" + key + "-" + j))
            ))
          ));
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
          blocks.push(h("div", { key: "k" + key++, style: { margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 } },
            items.map((item, j) => h("div", { key: j, style: { display: "flex", gap: 6 } },
              h("span", { style: { color: palette.secondary } }, String(j + 1) + "."),
              h("span", { style: { flex: 1 } }, inline(item, "ol" + key + "-" + j))
            ))
          ));
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
          blocks.push(h("blockquote", { key: "k" + key++, style: { margin: "6px 0", padding: "2px 10px", borderLeft: "3px solid " + palette.rowBorder } }, inline(quote.join("\n"), "q" + key)));
          continue;
        }
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
        blocks.push(h("p", { key: "k" + key++, style: { margin: "4px 0" } }, inline(para.join("\n"), "p" + key)));
      }
      return blocks;
    }

    // ───────────────────────── 轻提示（toast）与直接移入回收站 ─────────────────────────
    // 「删除」不再有二次确认弹窗：点菜单即移入回收站（可恢复），成功/失败用
    // 顶部轻提示反馈。toast 状态走模块级 store，Toast 组件常驻 shell.overlay。

    let toastState = null; // { text, kind, at }
    const toastListeners = new Set();
    let toastTimer = null;
    const toastStore = {
      show(text, kind) {
        toastState = { text, kind, at: Date.now() };
        toastListeners.forEach(l => l());
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toastState = null;
          toastListeners.forEach(l => l());
        }, 2600);
      },
      subscribe(listener) { toastListeners.add(listener); return () => toastListeners.delete(listener); },
      getSnapshot: () => toastState
    };
    const useToastState = () => useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

    // ───────────────────────── 删除前确认：产出文件勾选 ─────────────────────────
    // 会话本身进回收站可恢复，但工作目录里的产出文件删了就回不来，所以有产出
    // 文件时必须先列清单让人勾选；没有文件就直接删，保持原来的一步到位。

    let pendingDelete = null; // { sessionId, title, cwd, files[], refused[], totalBytes }
    const pendingListeners = new Set();
    const pendingStore = {
      show(data) { pendingDelete = data; pendingListeners.forEach(l => l()); },
      clear() { pendingDelete = null; pendingListeners.forEach(l => l()); },
      subscribe(listener) { pendingListeners.add(listener); return () => pendingListeners.delete(listener); },
      getSnapshot: () => pendingDelete
    };
    const usePendingDelete = () => useSyncExternalStore(pendingStore.subscribe, pendingStore.getSnapshot, pendingStore.getSnapshot);

    async function performTrash(sessionId, t, files) {
      try {
        const r = await callApi("/trash", { sessionId, files: Array.isArray(files) ? files : [] });
        if (r && r.ok) {
          // 主视图不用手动清：宿主 dispose 会话后推 api-session/removed，
          // 客户端自动删掉列表行并退掉主视图的作用域（0.2.1-rc.3 起如此）。
          const removed = Array.isArray(r.result && r.result.filesDeleted) ? r.result.filesDeleted.length : 0;
          const suffix = removed > 0 ? " " + t("toast.filesDeleted").replace("{n}", String(removed)) : "";
          toastStore.show(t("toast.trashed") + suffix, "success");
          // 主动拉一次基线列表：不依赖宿主是否推送 removed 帧，
          // 避免侧栏留下点进去 404 的僵尸行。
          await refreshSidebar();
          return true;
        }
        toastStore.show("✕ " + t("toast.trashFailed").replace("{message}", (r && r.error) || "unknown"), "error");
        return false;
      } catch (error) {
        toastStore.show("✕ " + t("toast.trashFailed").replace("{message}", String(error)), "error");
        return false;
      }
    }

    /** 点菜单：先问宿主这个会话产出了哪些文件，然后**一律弹确认框**。
     * 没有产出文件时弹的是纯确认（"确定删除这个会话？"），绝不点一下就没。
     */
    async function beginTrash(sessionId, t) {
      let preview = null;
      let note = "";
      try {
        const r = await callApi("/preview", { sessionId });
        if (r && r.ok) preview = r.result;
        else note = (r && r.error) || "读取产出文件失败";
      } catch (error) {
        note = String(error);
      }
      const files = Array.isArray(preview && preview.files) ? preview.files : [];
      const refused = Array.isArray(preview && preview.refused) ? preview.refused : [];
      pendingStore.show({
        sessionId,
        title: (preview && preview.title) || null,
        cwd: (preview && preview.cwd) || null,
        totalBytes: (preview && preview.totalBytes) || 0,
        files,
        refused,
        note: preview ? "" : note
      });
    }

    // ───────────────────────── 样式（结构层，颜色走内联） ─────────────────────────

    const CSS = `
.scl-layer{position:fixed;inset:0;z-index:11000;display:flex;align-items:center;justify-content:center}
.scl-panel{position:relative;width:480px;max-width:92vw;max-height:82vh;overflow:auto;border-radius:10px;padding:18px 20px;font-size:13px;line-height:18px}
.scl-panelSmall{width:380px}
.scl-close{position:absolute;top:8px;right:8px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;cursor:pointer;font-size:16px;line-height:1;padding:0}
.scl-close:hover{background:rgba(127,127,127,.18)}
.scl-close:disabled{opacity:.45;cursor:default}
.scl-title{margin:0 30px 12px 0;font-size:15px;font-weight:600}
.scl-info{display:flex;flex-direction:column;gap:5px;margin:2px 0 4px}
.scl-infoRow{display:flex;gap:12px}
.scl-infoLabel{flex:0 0 66px}
.scl-infoValue{flex:1;word-break:break-all}
.scl-reminders{margin-top:12px;padding-top:10px}
.scl-warn,.scl-error{margin:5px 0 0;word-break:break-all}
.scl-ok{margin:10px 0 0}
.scl-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.scl-btn{min-width:76px;min-height:30px;padding:4px 14px;border-radius:7px;border:1px solid transparent;cursor:pointer;font-size:13px}
.scl-btn:disabled{opacity:.55;cursor:default}
.scl-footerSlot{position:relative;width:100%;display:flex}
.scl-footerBtn{flex:1 1 auto;min-width:0;min-height:36px;padding:8px 10px;border:1px solid transparent;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;gap:8px;justify-content:center;align-items:center;text-align:center;display:flex}
/* 底部按钮 1:1 对齐产品侧栏「新会话」按钮（.wtg9ga_newSession）：
 * elevated-fill 底 + floating-hover 悬停 + .5px border-l3 发丝线 + radius-md + 38px 高。
 * 任何主题（含 dsh-ocean-theme 的浅海/深海）都自动同步默认态与悬停态 */
.scl-footerBtn{background:var(--dsw-alias-button-elevated-fill,#ffffff);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));color:var(--dsw-alias-label-primary,#1f2328);border-radius:var(--dsw-radius-md,8px);min-height:38px}
.scl-footerBtn:hover{background:var(--dsw-alias-button-floating-hover,#f1f3f5)}
/* macOS：宿主对「新会话」按钮还叠了一层半透明覆盖（浅色 #ffffff8c / 悬浮 #ffffff4d，深色 #ffffff26 / #ffffff33），
 * 令牌本身只到「不透明白」。不补这组规则，Mac 上就会比原生按钮实一档。规则顺序与宿主 CSS 保持一致，
 * 这样连侧栏收起态那种层叠细节也和原生一模一样。 */
[data-platform=darwin] .scl-footerBtn{background:#ffffff8c}
[data-platform=darwin] .scl-footerBtn:hover{background:#ffffff4d}
[data-platform=darwin] [data-ds-dark-theme] .scl-footerBtn{background:#ffffff26}
[data-platform=darwin] [data-ds-dark-theme] .scl-footerBtn:hover{background:#ffffff33}
.scl-footerBtnRail{flex:0 0 36px;width:36px;min-width:36px;min-height:36px;padding:0}
/* 侧栏收起（rail）时对齐原生「新会话」图标态：无底色，仅悬停着色（同样走产品交互 token） */
.scl-railOnly .scl-footerBtn{background:transparent;border-color:transparent}
.scl-railOnly .scl-footerBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.scl-modalWide{width:640px;max-width:94vw;max-height:82vh;overflow:auto;border-radius:10px;padding:16px 18px;font-size:13px;line-height:18px;display:flex;flex-direction:column}
.scl-modalHeader{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;padding-bottom:12px}
.scl-headLeft{flex:1;min-width:0}
.scl-headTitle{margin:0;font-size:15px;font-weight:600}
.scl-headSub{font-size:12px;margin-top:3px}
.scl-count{font-size:12px}
.scl-controls{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap;align-items:center}
.scl-input{flex:1;min-width:130px;height:28px;box-sizing:border-box;padding:0 8px;border-radius:7px;border:1px solid transparent;font-size:13px;outline:none}
.scl-select{height:28px;box-sizing:border-box;padding:0 6px;border-radius:7px;border:1px solid transparent;font-size:12px;outline:none;cursor:pointer}
.scl-check{display:flex;align-items:center;gap:4px;height:28px;font-size:12px;cursor:pointer;white-space:nowrap}
.scl-tList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px;min-height:120px}
.scl-dateHead{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid;margin-bottom:2px}
.scl-tRow{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid transparent;border-radius:8px}
.scl-tMain{flex:1;min-width:0}
.scl-tTitle{font-weight:600;word-break:break-all;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.scl-tMeta{font-size:12px;margin-top:3px;word-break:break-all}
.scl-tBadge{font-size:11px;font-weight:500;padding:1px 6px;border-radius:8px;background:rgba(127,127,127,.2)}
.scl-tBtns{display:flex;flex-direction:row;gap:6px}
.scl-miniBtn{min-width:56px;min-height:26px;padding:3px 10px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center}
.scl-miniBtn:disabled{opacity:.5;cursor:default}
.scl-batchBar{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;flex-wrap:wrap}
.scl-spacer{flex:1}
.scl-tNotice{font-size:12px;margin:0 0 8px;word-break:break-all}
.scl-notice{font-size:12px;margin:6px 0 0}
.scl-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;min-height:120px}
.scl-sortBtn{height:28px;box-sizing:border-box;min-width:28px;padding:0 6px;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;font-size:12px}
.scl-turn{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid transparent;border-radius:8px;cursor:pointer}
.scl-turn:hover{background:rgba(127,127,127,.07)}
.scl-turnHead{display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap}
.scl-turnBadge{padding:1px 8px;border-radius:999px;font-weight:600;font-size:11px;background:rgba(127,127,127,.16)}
.scl-turnArrow{margin-left:auto;font-size:11px}
.scl-collapsedRow{display:flex;gap:4px;align-items:baseline;min-width:0}
.scl-fade{flex:1;min-width:0;white-space:nowrap;overflow:hidden;-webkit-mask-image:linear-gradient(to right,#000 78%,transparent);mask-image:linear-gradient(to right,#000 78%,transparent)}
.scl-md{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px}
.scl-md pre{margin:6px 0;padding:8px 10px;border-radius:6px;overflow-x:auto;background:rgba(127,127,127,.14);white-space:pre;font-size:12px;line-height:17px}
.scl-md code{font-family:Consolas,"Courier New",monospace;font-size:12px;background:rgba(127,127,127,.16);padding:0 4px;border-radius:4px}
.scl-md pre code{background:transparent;padding:0}
`;

    function injectStyle() {
      try {
        if (document.getElementById("dsh-session-cleaner-style")) return () => {};
        const tag = document.createElement("style");
        tag.id = "dsh-session-cleaner-style";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { try { tag.remove(); } catch { /* ignore */ } };
      } catch { return () => {}; }
    }

    // ───────────────────────── ··· 菜单里的删除项 ─────────────────────────

    function DeleteSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, t } = props;
      // 外层只做条件判断，一个 Hook 都不调——Hook 数量才可能恒定。
      // 曾经的写法把 useMenuOpenState() 放在这个 return 之后，正是「早返回后
      // 还有 Hook」：条件一变，React 直接报 #310，把整个面板干掉。
      if (typeof P.MenuItemButton !== "function" || !P.IconTrashOutlineRegular) return null;
      return h(DeleteSessionMenuInner, { sessionId, useMenuOpenState, t });
    }

    /** 内层：Hook 数量恒定，外层条件怎么变都不影响它。 */
    function DeleteSessionMenuInner({ sessionId, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      return h(P.MenuItemButton, {
        danger: true, // 原生红色菜单项样式：字号/颜色与官方条目完全一致
        icon: h(P.IconTrashOutlineRegular, {}),
        onSelect: () => {
          try { setMenuOpen(false); } catch { /* menu already closing */ }
          beginTrash(sessionId, t);
        },
        children: t("menu.delete")
      });
    }

    // 顶部轻提示：移入回收站的成败反馈（自动消失）
    function TrashToast() {
      const theme = useTheme();
      const palette = paletteFor(theme);
      const toast = useToastState();
      if (!toast) return null;
      return h("div", {
        style: {
          position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 11100,
          background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow,
          color: palette.text, borderRadius: 8, padding: "8px 16px", fontSize: 13,
          display: "flex", alignItems: "center", gap: 8
        },
        role: "status"
      },
        h("span", { style: { color: toast.kind === "error" ? palette.danger : palette.success, fontWeight: 600 } }, toast.kind === "error" ? "✕" : "✓"),
        h("span", null, toast.text)
      );
    }

    // ───────────────────────── 删除对话：产出文件勾选窗 ─────────────────────────
    // 只在这里给用户看「这个会话产出了哪些文件」，默认全勾（用户要求一次清干净），
    // 取消勾选的文件留在原处、不进回收站。

    function DeleteConfirmOverlay({ usePendingDelete: usePending, t }) {
      const data = usePending();
      const theme = useTheme();
      const palette = paletteFor(theme);
      const [checked, setChecked] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      // 全部默认勾选（中间产物也一起清干净是合规的），但交付物在视觉上单独标出来，
      // 提醒「这几个是你真正收到的东西，别顺手删了」。
      useEffect(() => {
        setBusy(false);
        const d = data && Array.isArray(data.delivered) ? data.delivered : [];
        const m = data && Array.isArray(data.modified) ? data.modified : [];
        setChecked(new Set([...d, ...m].map((f) => f.path)));
      }, [data]);
      if (!data) return null;

      const delivered = Array.isArray(data.delivered) ? data.delivered : [];
      const modified = Array.isArray(data.modified) ? data.modified : [];
      const files = [...delivered, ...modified];
      const refused = Array.isArray(data.refused) ? data.refused : [];
      const inputStyle = { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder };
      const toggle = (path) => setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
      const allChecked = files.length > 0 && files.every((f) => checked.has(f.path));
      const checkedBytes = files.filter((f) => checked.has(f.path)).reduce((n, f) => n + (Number(f.bytes) || 0), 0);

      const confirm = async () => {
        setBusy(true);
        const ok = await performTrash(data.sessionId, t, [...checked]);
        setBusy(false);
        if (ok) pendingStore.clear();
      };

      return h("div", {
        className: "scl-layer",
        style: { background: palette.layer, zIndex: 11050 },
        role: "presentation",
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) pendingStore.clear(); }
      },
        h("section", {
          className: "scl-panel",
          style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
          role: "dialog", "aria-modal": "true"
        },
          h("h2", { className: "scl-title", style: { color: palette.text } }, t("confirm.title")),
          h("div", { className: "scl-info", style: { color: palette.secondary } },
            h("div", { className: "scl-infoRow" },
              h("span", { className: "scl-infoLabel" }, t("confirm.session")),
              h("span", { className: "scl-infoValue" }, data.title || data.sessionId)
            ),
            h("div", { className: "scl-infoRow" },
              h("span", { className: "scl-infoLabel" }, t("confirm.cwd")),
              h("span", { className: "scl-infoValue" }, data.cwd || "—")
            )
          ),
          h("div", { className: "scl-reminders", style: { borderTop: "1px solid " + palette.rowBorder } },
            data.note
              ? h("div", { className: "scl-warn", style: { color: palette.warn } },
                  t("confirm.previewFailed").replace("{message}", data.note))
              : null,
            files.length === 0
              ? h("div", { className: "scl-ok", style: { color: palette.secondary } }, t("confirm.noFiles"))
              : h("div", null,
                  h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
                    h("strong", { style: { color: palette.text } },
                      t("confirm.filesTitle").replace("{n}", String(files.length)).replace("{size}", formatBytes(data.totalBytes))),
                    h("button", {
                      type: "button", className: "scl-miniBtn", style: { ...inputStyle, marginLeft: "auto" },
                      disabled: busy,
                      onClick: () => setChecked(allChecked ? new Set() : new Set(files.map((f) => f.path)))
                    }, allChecked ? t("confirm.deselectAll") : t("confirm.selectAll"))
                  ),
                  h("div", { className: "scl-tList", style: { maxHeight: 230, overflow: "auto" } },
                    files.map((f) => h("div", { className: "scl-tRow", key: f.path, style: { borderColor: palette.rowBorder } },
                      h("input", {
                        type: "checkbox", checked: checked.has(f.path),
                        onChange: () => toggle(f.path)
                      }),
                      h("div", { className: "scl-tMain" },
                        h("div", {
                          className: "scl-tTitle",
                          // 交付物：红色 + 加粗，一眼分辨「这是你真正收到的东西」
                          style: f.source === "present"
                            ? { color: palette.danger, fontWeight: 600 }
                            : { color: palette.text }
                        },
                          f.source === "present"
                            ? h("span", { className: "scl-tBadge", style: { color: palette.danger, fontWeight: 700 } }, t("confirm.deliveredTag"))
                            : h("span", { className: "scl-tBadge", style: { color: palette.secondary } }, t("confirm.modifiedTag")),
                          f.displayPath || f.path
                        ),
                        h("div", { className: "scl-tMeta", style: { color: palette.secondary } },
                          [
                            formatBytes(f.bytes),
                            t("confirm.ops").replace("{n}", String(f.ops || 1)),
                            f.description ? String(f.description).slice(0, 70) : null
                          ].filter(Boolean).join(" · "))
                      )
                    ))
                  ),
                  h("div", { className: "scl-warn", style: { color: palette.warn } }, t("confirm.fileWarning")),
                  checked.size > 0
                    ? h("div", { className: "scl-tNotice", style: { color: palette.danger } },
                        t("confirm.selectedBytes").replace("{size}", formatBytes(checkedBytes)))
                    : null
                ),
            refused.length > 0
              ? h("details", { style: { marginTop: 10 } },
                  h("summary", { style: { color: palette.secondary, cursor: "pointer" } },
                    t("confirm.skipped").replace("{n}", String(refused.length))),
                  h("div", { style: { marginTop: 6 } },
                    refused.map((r, i) => h("div", {
                      key: i, style: { color: palette.secondary, fontSize: 12, marginBottom: 3, wordBreak: "break-all" }
                    }, (r.path || "") + " — " + (r.reason || ""))))
                )
              : null
          ),
          h("div", { className: "scl-footer" },
            h("button", {
              type: "button", className: "scl-btn",
              style: { border: "1px solid " + palette.btnBorder, background: "transparent", color: palette.text },
              disabled: busy,
              onClick: () => pendingStore.clear()
            }, t("dialog.cancel")),
            h("button", {
              type: "button", className: "scl-btn scl-btnDanger",
              style: { border: "1px solid " + palette.danger, background: palette.danger, color: "#ffffff" },
              disabled: busy,
              onClick: confirm
            }, busy ? t("confirm.deleting") : t("confirm.delete"))
          )
        )
      );
    }

    // ───────────────────────── 批量删除：会话总览 ─────────────────────────
    // 只删会话记录（含子代理树），不碰工作区文件——文件清理只在单个删除时提供。

    let managerOpen = false;
    const managerListeners = new Set();
    const managerStore = {
      subscribe(listener) { managerListeners.add(listener); return () => managerListeners.delete(listener); },
      getSnapshot: () => managerOpen,
      open() { if (!managerOpen) { managerOpen = true; managerListeners.forEach(l => l()); } },
      close() { if (managerOpen) { managerOpen = false; managerListeners.forEach(l => l()); } }
    };
    const useManagerOpen = () => useSyncExternalStore(managerStore.subscribe, managerStore.getSnapshot, managerStore.getSnapshot);
    // 打开批量面板时先收起回收站面板，避免两个弹窗叠在一起
    const openManager = () => { try { closeTrashUi(); } catch { /* 未初始化时忽略 */ } managerStore.open(); };
    const closeManager = () => managerStore.close();

    function SessionManagerOverlay({ useManagerOpen: useOpen, closeManager: doClose, t }) {
      const open = useOpen();
      const theme = useTheme();
      const palette = paletteFor(theme);
      const [items, setItems] = useState(null);
      const [checked, setChecked] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      const [confirmState, setConfirmState] = useState(null);

      const reload = async () => {
        try {
          const r = await callApi("/list");
          setItems(r && r.ok ? (r.result.items || []) : []);
        } catch { setItems([]); }
      };
      useEffect(() => {
        if (!open) return;
        setItems(null); setChecked(new Set()); setConfirmState(null);
        reload();
      }, [open]);

      if (!open) return null;
      const list = Array.isArray(items) ? items : [];
      const toggle = (id) => setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      const allChecked = list.length > 0 && list.every((it) => checked.has(it.id));
      const selectedBytes = list.filter((it) => checked.has(it.id)).reduce((n, it) => n + (Number(it.bytes) || 0), 0);

      // 按天分组：有会话的日期才出现，最近的在上；每组标题旁一个勾选框。
      // 这里**不能**用 useMemo：它落在 `if (!open) return null` 之后，Hook 数量
      // 会随 open 变化，React 报 #310 并把整个面板干掉（实测：会话管理点不开）。
      const groups = (() => {
        const map = new Map();
        for (const it of list) {
          const key = dayKeyOf(it.updatedAt ?? it.createdAt);
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(it);
        }
        return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
      })();

      const toggleGroup = (groupItems) => setChecked((prev) => {
        const next = new Set(prev);
        const allIn = groupItems.every((it) => next.has(it.id));
        for (const it of groupItems) {
          if (allIn) next.delete(it.id); else next.add(it.id);
        }
        return next;
      });

      const doDelete = async () => {
        setConfirmState(null);
        setBusy(true);
        try {
          const r = await callApi("/trash/batch", { sessionIds: [...checked] });
          if (r && r.ok) {
            toastStore.show(t("manager.done").replace("{n}", String(r.result.deleted ?? 0)), "success");
            setChecked(new Set());
            await reload();
            await refreshSidebar();
          } else {
            toastStore.show("✕ " + ((r && r.error) || "unknown"), "error");
          }
        } catch (error) {
          toastStore.show("✕ " + String(error), "error");
        }
        setBusy(false);
      };

      return h("div", {
        className: "scl-layer",
        style: { background: palette.layer, zIndex: 11040 },
        role: "presentation",
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) doClose(); }
      },
        h("section", {
          className: "scl-modalWide",
          style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
          role: "dialog", "aria-modal": "true"
        },
          h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.rowBorder } },
            h("div", { className: "scl-headLeft" },
              h("h2", { className: "scl-headTitle", style: { color: palette.text } }, t("manager.title")),
              h("div", { className: "scl-headSub", style: { color: palette.secondary } }, t("manager.hint"))
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("button", {
                type: "button", className: "scl-miniBtn",
                style: { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder },
                disabled: busy,
                // 返回 = 回到「已删除会话」列表（从哪里点进来的就回哪里），
                // × 才是彻底关掉。两者功能不能一样。
                onClick: () => { doClose(); try { openTrashUi(); } catch { /* 面板未就绪时忽略 */ } }
              }, "← " + t("manager.back")),
              h("button", {
                type: "button", className: "scl-close", style: { color: palette.secondary, position: "static" },
                disabled: busy, onClick: doClose
              }, "×")
            )
          ),
          items === null
            ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("manager.loading"))
            : h("div", { className: "scl-tList", style: { maxHeight: "52vh", overflow: "auto" } },
                groups.length === 0
                  ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("manager.empty"))
                  : groups.map(([key, groupItems]) => {
                      const allIn = groupItems.every((it) => checked.has(it.id));
                      return h("div", { key: key || "unknown", style: { marginBottom: 10 } },
                        // 日期头：勾一下就选中这一天全部会话（没有会话的日期根本不会出现）
                        h("div", {
                          className: "scl-dateHead",
                          style: { borderColor: palette.rowBorder }
                        },
                          h("input", {
                            type: "checkbox",
                            checked: allIn,
                            onChange: () => toggleGroup(groupItems)
                          }),
                          h("span", { style: { fontWeight: 600, color: palette.text } }, dayLabelOf(key)),
                          h("span", { className: "scl-tBadge", style: { color: palette.secondary } },
                            t("manager.countInDay").replace("{n}", String(groupItems.length)))
                        ),
                        groupItems.map((it) => h("div", { className: "scl-tRow", key: it.id, style: { borderColor: palette.rowBorder } },
                          h("input", { type: "checkbox", checked: checked.has(it.id), onChange: () => toggle(it.id) }),
                          h("div", { className: "scl-tMain" },
                            h("div", { className: "scl-tTitle", style: { color: palette.text } },
                              it.title || t("manager.untitled"),
                              it.isBlank
                                ? h("span", { className: "scl-tBadge", style: { color: palette.secondary } }, t("manager.blankTag"))
                                : null
                            ),
                            // 只显示「最后活动 · 工作目录 · 体积」，session id 不再给用户看
                            h("div", { className: "scl-tMeta", style: { color: palette.secondary } },
                              [
                                relativeTime(it.updatedAt ?? it.createdAt),
                                it.cwd || null,
                                formatBytes(it.bytes)
                              ].filter(Boolean).join(" · "))
                          )
                        ))
                      );
                    })
              ),
          h("div", { className: "scl-batchBar", style: { borderTop: "1px solid " + palette.panelBorder } },
            h("button", {
              type: "button", className: "scl-miniBtn",
              style: { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder },
              disabled: busy || list.length === 0,
              onClick: () => setChecked(allChecked ? new Set() : new Set(list.map((it) => it.id)))
            }, allChecked ? t("manager.deselectAll") : t("manager.selectAll")),
            list.some((it) => it.isBlank)
              ? h("button", {
                  type: "button", className: "scl-miniBtn",
                  style: { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder },
                  disabled: busy,
                  onClick: () => setChecked(new Set(list.filter((it) => it.isBlank).map((it) => it.id)))
                }, t("manager.selectBlank").replace("{n}", String(list.filter((it) => it.isBlank).length)))
              : null,
            checked.size > 0
              ? h("span", { className: "scl-tNotice", style: { color: palette.secondary, margin: 0 } },
                  t("manager.selected").replace("{n}", String(checked.size)) + " · " + formatBytes(selectedBytes))
              : null,
            h("div", { className: "scl-spacer" }),
            h("button", {
              type: "button", className: "scl-miniBtn",
              style: { color: palette.danger, borderColor: palette.rowBorder },
              disabled: busy || checked.size === 0,
              onClick: () => setConfirmState({ message: t("manager.confirmDelete").replace("{n}", String(checked.size)), run: doDelete })
            }, busy ? t("manager.deleting") : t("manager.deleteSelected"))
          ),
          confirmState ? h("div", {
            className: "scl-layer", style: { background: palette.layer, zIndex: 11060 },
            role: "presentation",
            onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) setConfirmState(null); }
          },
            h("section", {
              className: "scl-panel scl-panelSmall",
              style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
              role: "dialog", "aria-modal": "true"
            },
              h("div", { style: { color: palette.text } }, confirmState.message),
              h("div", { className: "scl-footer" },
                h("button", {
                  type: "button", className: "scl-btn",
                  style: { border: "1px solid " + palette.btnBorder, background: "transparent", color: palette.text },
                  disabled: busy, onClick: () => setConfirmState(null)
                }, t("dialog.cancel")),
                h("button", {
                  type: "button", className: "scl-btn scl-btnDanger",
                  style: { border: "1px solid " + palette.danger, background: palette.danger, color: "#ffffff" },
                  disabled: busy, onClick: () => confirmState.run()
                }, t("trash.confirm"))
              )
            )
          ) : null
        )
      );
    }

    // ───────────────────────── 可拖拽的悬浮入口 ─────────────────────────
    // 侧栏底部那个撑满宽度的按钮会盖住别人的界面，改成一个 48px 的小方块：
    // 位置可拖、记在 localStorage、点一下开面板。拖拽用 pointer 事件，
    // 移动超过 2px 才算拖动，否则按点击处理。

    const ENTRY_POS_KEY = "dsh-session-cleaner.entry.position";

    function FloatingEntry({ t }) {
      const theme = useTheme();
      const palette = paletteFor(theme);
      const readPos = () => {
        try {
          const raw = globalThis.localStorage ? localStorage.getItem(ENTRY_POS_KEY) : null;
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed;
          }
        } catch { /* 读不到就用默认位置 */ }
        const w = typeof window !== "undefined" ? window.innerWidth : 1280;
        const hh = typeof window !== "undefined" ? window.innerHeight : 800;
        return { left: Math.max(12, w - 72), top: Math.max(12, hh - 160) };
      };
      const [pos, setPos] = useState(readPos);
      const [dragging, setDragging] = useState(false);
      const dragRef = useRef(null);

      const onPointerDown = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
        setDragging(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 老浏览器忽略 */ }
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const width = typeof window !== "undefined" ? window.innerWidth : 1280;
        const height = typeof window !== "undefined" ? window.innerHeight : 800;
        const left = Math.max(8, Math.min(width - 56, event.clientX - drag.dx));
        const top = Math.max(8, Math.min(height - 56, event.clientY - drag.dy));
        if (Math.abs(left - pos.left) > 2 || Math.abs(top - pos.top) > 2) drag.moved = true;
        setPos({ left, top });
      };
      const finishDrag = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (drag !== null && drag.moved === false) { openTrashUi(); return; }
        try { localStorage.setItem(ENTRY_POS_KEY, JSON.stringify(pos)); } catch { /* 存不下就算了 */ }
      };

      const icon = P.IconArchiveOutlineRegular
        ? h(P.IconArchiveOutlineRegular, { size: 20 })
        : h("span", { style: { fontSize: 17 } }, "🗑");

      return h("div", {
        role: "button",
        tabIndex: 0,
        title: t("trash.title"),
        "aria-label": t("trash.title"),
        style: {
          position: "fixed", left: pos.left, top: pos.top, zIndex: 10900,
          width: 48, height: 48, borderRadius: 14,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: palette.panel,
          border: "1px solid " + palette.panelBorder,
          boxShadow: palette.shadow,
          color: palette.text,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none", touchAction: "none",
          transition: dragging ? "none" : "transform .18s ease, box-shadow .18s ease",
          transform: dragging ? "scale(1.08)" : "scale(1)"
        },
        onPointerDown,
        onPointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: finishDrag,
        onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTrashUi(); } }
      }, icon);
    }

    // ───────────────────────── 侧栏底部「会话回收站」按钮 + 面板 ─────────────────────────

    // 回收站弹窗开关：模块级 store。footer 按钮直接调 openTrashUi()（同模块），
    // 弹窗本体渲染在 shell.overlay 里、经注入的 use hook 读取开关——与
    // 「菜单项 → 确认框」完全同一套已验证机制（居中弹窗、×/Esc/点背景都能关）。
    let trashUiOpen = false;
    const trashUiListeners = new Set();
    const trashUiStore = {
      subscribe(listener) { trashUiListeners.add(listener); return () => trashUiListeners.delete(listener); },
      getSnapshot: () => trashUiOpen,
      open() { if (!trashUiOpen) { trashUiOpen = true; trashUiListeners.forEach(l => l()); } },
      close() { if (trashUiOpen) { trashUiOpen = false; trashUiListeners.forEach(l => l()); } }
    };
    const useTrashUiOpen = () => useSyncExternalStore(trashUiStore.subscribe, trashUiStore.getSnapshot, trashUiStore.getSnapshot);
    const openTrashUi = () => trashUiStore.open();
    const closeTrashUi = () => trashUiStore.close();

    // 面板渲染的错误边界：面板内部出错时只收起弹窗，不拖垮整个界面
    class SclErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { console.error("session-cleaner:", error); } catch { /* ignore */ } }
      render() { return this.state.failed ? null : this.props.children; }
    }

    function TrashFooterAction(props) {
      const { t, openTrashUi: openPanel } = props;
      const wide = props.wide === true;
      try {
        return h("div", {
          className: "scl-footerSlot" + (wide ? "" : " scl-railOnly")
        },
          h("button", {
            type: "button",
            className: "scl-footerBtn" + (wide ? "" : " scl-footerBtnRail"),
            "aria-label": t("trash.title"),
            onClick: () => openPanel()
          },
            h(P.IconArchiveOutlineRegular, { size: wide ? 16 : 18 }),
            wide ? h("span", null, t("trash.title")) : null
          )
        );
      } catch { return null; }
    }

    const footerInjected = () => ({ openTrashUi });

    function RecycleBinOverlay({ useTrashUiOpen, closeTrashUi, t }) {
      const open = useTrashUiOpen();
      const theme = useTheme();
      const palette = paletteFor(theme);
      const [items, setItems] = useState(null);
      const [totalBytes, setTotalBytes] = useState(0);
      const [nextPurgeAt, setNextPurgeAt] = useState(null);
      const [keyword, setKeyword] = useState("");
      const [searchContent, setSearchContent] = useState(false);
      const [contentMatches, setContentMatches] = useState(null);
      const [searching, setSearching] = useState(false);
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [sortKey, setSortKey] = useState("deletedAt");
      const [sortAsc, setSortAsc] = useState(false);
      const [checked, setChecked] = useState(() => new Set());
      const [notice, setNotice] = useState("");
      const [errorText, setErrorText] = useState("");
      const [busy, setBusy] = useState(false);
      const [confirmState, setConfirmState] = useState(null); // {message, run}
      const [detail, setDetail] = useState(null); // null | {loading,id} | {loading:false,.../trash/detail 结果}
      const [expandedTurns, setExpandedTurns] = useState(() => new Set()); // 默认全部折叠
      const busyRef = useRef(false);
      busyRef.current = busy;
      const detailRef = useRef(null);
      detailRef.current = detail;

      useEffect(() => {
        if (!open) return;
        const handler = (event) => {
          if (event.key !== "Escape" || busyRef.current) return;
          event.preventDefault();
          if (detailRef.current) setDetail(null); // 详情页 Esc 先返回列表
          else closeTrashUi();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);

      useEffect(() => {
        // 弹窗常驻（关闭只是返回 null），列表必须每次打开时重新拉取，
        // 否则删除后新进回收站的会话要重启 DSH 才能看到
        if (!open) return;
        let cancelled = false;
        callApi("/trash/list").then((r) => {
          if (cancelled) return;
          if (r && r.ok) { setItems(r.result.items || []); setTotalBytes(r.result.totalBytes || 0); setNextPurgeAt(r.result.nextPurgeAt); }
          else setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "list failed"));
        }).catch((error) => { if (!cancelled) setErrorText(t("dialog.error").replace("{message}", String(error))); });
        return () => { cancelled = true; };
      }, [open]);

      useEffect(() => {
        if (!notice) return;
        const id = setTimeout(() => setNotice(""), 3000);
        return () => clearTimeout(id);
      }, [notice]);

      const refreshList = async () => {
        const r = await callApi("/trash/list");
        if (r && r.ok) { setItems(r.result.items || []); setTotalBytes(r.result.totalBytes || 0); setNextPurgeAt(r.result.nextPurgeAt); }
        setChecked(new Set());
      };

      const workspaces = useMemo(() => {
        const set = new Map();
        for (const item of (items || [])) {
          if (typeof item.cwd === "string" && item.cwd !== "" && !set.has(item.cwd)) set.set(item.cwd, item.cwd);
        }
        return [...set.values()];
      }, [items]);

      const visibleItems = useMemo(() => {
        let list = items || [];
        if (workspaceFilter) list = list.filter(item => item.cwd === workspaceFilter);
        if (contentMatches !== null) {
          list = list.filter(item => contentMatches[item.id] !== undefined);
        } else if (keyword.trim() !== "") {
          const needle = keyword.trim().toLowerCase();
          list = list.filter(item =>
            (typeof item.title === "string" && item.title.toLowerCase().includes(needle)) ||
            (typeof item.cwd === "string" && item.cwd.toLowerCase().includes(needle)));
        }
        const direction = sortAsc ? 1 : -1;
        return [...list].sort((a, b) => {
          if (sortKey === "title") return String(a.title || "").localeCompare(String(b.title || "")) * direction;
          const va = Number(a[sortKey]) || 0;
          const vb = Number(b[sortKey]) || 0;
          return (va - vb) * direction;
        });
      }, [items, workspaceFilter, keyword, contentMatches, sortKey, sortAsc]);

      // 勾选「搜正文」后，输入关键词自动防抖搜索（不再需要额外按钮）
      useEffect(() => {
        if (!searchContent) { setContentMatches(null); return; }
        const kw = keyword.trim();
        if (kw === "") { setContentMatches(null); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
          setSearching(true);
          callApi("/trash/search", { keyword: kw }).then((r) => {
            if (!cancelled && r && r.ok) setContentMatches(r.result.matches || {});
          }).catch(() => { /* 静默：保留上一次结果 */ }).finally(() => {
            if (!cancelled) setSearching(false);
          });
        }, 350);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [keyword, searchContent]);

      const doRestore = async (ids) => {
        // 兼容单条（字符串）与批量（数组）两种入参；接口只收单个 sessionId
        const list = Array.isArray(ids) ? ids : [ids];
        setBusy(true);
        setErrorText("");
        let restoredCount = 0;
        // 删除前处于归档状态的会话，恢复后回到归档列表（不回到侧栏），提示要说准
        let archivedCount = 0;
        try {
          for (const id of list) {
            const r = await callApi("/trash/restore", { sessionId: id });
            if (r && r.ok) {
              restoredCount++;
              if (r.result && r.result.archived === true) archivedCount++;
            } else {
              setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "restore failed"));
              break;
            }
          }
          if (restoredCount > 0) {
            const what = archivedCount === restoredCount ? t("trash.restoredArchived")
              : archivedCount > 0 ? t("trash.restoredMixed")
              : t("trash.restored");
            setNotice(what + (restoredCount > 1 ? " ×" + restoredCount : ""));
            await refreshList();
            await refreshSidebar();
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doPurge = async (ids) => {
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/delete", { sessionIds: ids });
          if (r && r.ok) {
            setNotice(t("trash.purged"));
            setConfirmState(null);
            await refreshList();
          } else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "purge failed"));
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const doEmpty = async () => {
        setBusy(true);
        setErrorText("");
        try {
          const r = await callApi("/trash/empty");
          if (r && r.ok) {
            setNotice(t("trash.emptyDone"));
            setConfirmState(null);
            await refreshList();
          } else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "empty failed"));
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
        } finally {
          setBusy(false);
        }
      };

      const toggleChecked = (id) => {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const openDetail = async (id) => {
        setDetail({ loading: true, id });
        setExpandedTurns(new Set()); // 每次打开默认全部折叠
        try {
          const r = await callApi("/trash/detail", { sessionId: id });
          if (r && r.ok) setDetail({ loading: false, ...r.result });
          else {
            setErrorText(t("dialog.error").replace("{message}", (r && r.error) || "detail failed"));
            setDetail(null);
          }
        } catch (error) {
          setErrorText(t("dialog.error").replace("{message}", String(error)));
          setDetail(null);
        }
      };

      const toggleSelectAllVisible = () => setChecked(visibleItems.length > 0 && visibleItems.every(i => checked.has(i.id)) ? new Set() : new Set(visibleItems.map(i => i.id)));

      const themeInput = { background: palette.inputBg, color: palette.text, border: "1px solid " + palette.btnBorder };

      if (!open) return null;

      if (detail) {
        const d = detail;
        return h("div", {
          className: "scl-layer",
          style: { background: palette.layer },
          role: "presentation",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) setDetail(null);
          }
        },
          h("section", {
            className: "scl-panel scl-modalWide",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "scl-detail-title"
          },
            h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.panelBorder } },
              h("button", {
                type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text, flex: "0 0 auto" },
                disabled: busy, onClick: () => setDetail(null)
              }, "← " + t("detail.back")),
              h("div", { className: "scl-headLeft" },
                h("h2", { id: "scl-detail-title", className: "scl-headTitle", style: { color: palette.text } }, t("detail.title")),
                h("div", { className: "scl-headSub", style: { color: palette.secondary } }, d.title || d.id)
              ),
              h("button", {
                type: "button", className: "scl-close", style: { color: palette.secondary },
                "aria-label": t("dialog.close"), title: t("dialog.close"),
                onClick: closeTrashUi
              }, "\u00d7")
            ),
            d.loading
              ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("detail.loading"))
              : [
                  h("div", { key: "info", className: "scl-info", style: { margin: "0 0 10px" } },
                    [
                      typeof d.cwd === "string" && d.cwd ? ["info.cwd", d.cwd] : null,
                      Number.isFinite(d.turns) ? ["info.turns", d.turns + " " + t("unit.turns")] : null,
                      Number.isFinite(d.userMessages) ? ["info.userMessages", d.userMessages + " " + t("unit.messages")] : null,
                      Number.isFinite(d.toolCalls) ? ["info.toolCalls", d.toolCalls + " " + t("unit.calls")] : null,
                      ["info.size", formatBytes(d.bytes)],
                      Number.isFinite(d.deletedAt) ? ["trash.deletedAt", formatTime(d.deletedAt)] : null
                    ].filter(Boolean).map(([labelKey, value]) => h("div", { className: "scl-infoRow", key: labelKey },
                      h("span", { className: "scl-infoLabel", style: { color: palette.secondary } }, t(labelKey)),
                      h("span", { className: "scl-infoValue", style: { color: palette.text } }, value)
                    ))
                  ),
                  d.parseError ? h("div", { key: "perr", className: "scl-tNotice", style: { color: palette.danger } }, t("dialog.error").replace("{message}", d.parseError)) : null,
                  h("div", { key: "qhead", style: { color: palette.text, fontWeight: 600, margin: "0 0 6px" } }, t("detail.questions").replace("{n}", String((d.questions || []).length))),
                  h("div", { key: "qlist", className: "scl-tList" },
                    (d.questions || []).length === 0
                      ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("detail.noQuestions"))
                      : d.questions.map((q, i) => {
                          const expanded = expandedTurns.has(i);
                          return h("div", {
                            className: "scl-turn", key: i,
                            style: { borderColor: palette.rowBorder },
                            onClick: () => setExpandedTurns((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i); else next.add(i);
                              return next;
                            })
                          },
                            h("div", { className: "scl-turnHead" },
                              h("span", { className: "scl-turnBadge", style: { color: palette.turn } }, t("detail.turn").replace("{n}", String(q.turn ?? i + 1))),
                              h("span", { style: { color: palette.secondary } }, formatTime(q.time)),
                              h("span", { style: { color: palette.secondary } }, t("detail.tools").replace("{n}", String(q.toolCalls || 0))),
                              h("span", { className: "scl-turnArrow", style: { color: palette.secondary } }, expanded ? "▾" : "▸")
                            ),
                            expanded
                              ? [
                                  h("div", { key: "q", className: "scl-md", style: { color: palette.user } }, q.question || "（无文本内容）"),
                                  q.assistantReply
                                    ? h("div", { key: "a", className: "scl-md", style: { color: palette.model } }, renderMarkdown(q.assistantReply, palette))
                                    : q.failure
                                      // 这一轮模型报错（503 / 超时 / 取消）：把原因摆出来，别让人以为插件坏了
                                      ? h("div", { key: "a", className: "scl-warn", style: { color: palette.danger } },
                                          t("detail.failed").replace("{message}", q.failure))
                                      : q.thinking
                                        // 只有思考过程没有最终回复：折叠展示，供判断会话有没有价值
                                        ? h("details", { key: "a", style: { marginTop: 6 } },
                                            h("summary", { style: { color: palette.secondary, cursor: "pointer" } }, t("detail.thinkingOnly")),
                                            h("div", { className: "scl-md", style: { color: palette.secondary, marginTop: 6 } },
                                              renderMarkdown(q.thinking, palette)))
                                        : h("div", { key: "a", className: "scl-tNotice", style: { color: palette.secondary } },
                                            t("detail.noReply"))
                                ]
                              : h("div", { className: "scl-collapsedRow" },
                                  h("span", { className: "scl-fade", style: { color: palette.user } }, q.question || "（无文本内容）")
                                )
                          );
                        })
                  )
                ]
          )
        );
      }

      return h("div", {
        className: "scl-layer",
        style: { background: palette.layer },
        role: "presentation",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !busy) closeTrashUi();
        }
      },
        h("section", {
          className: "scl-panel scl-modalWide",
          style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "scl-trash-title"
        },
        h("div", { className: "scl-modalHeader", style: { borderBottom: "1px solid " + palette.panelBorder } },
          h("div", { className: "scl-headLeft" },
            h("h2", { id: "scl-trash-title", className: "scl-headTitle", style: { color: palette.text } }, t("trash.title")),
            items ? h("div", { className: "scl-headSub", style: { color: palette.secondary } },
              t("trash.count").replace("{n}", String(visibleItems.length)).replace("{size}", formatBytes(totalBytes))
                + " · " + t("dialog.retention")
                + (typeof nextPurgeAt === "number" && Number.isFinite(nextPurgeAt)
                  ? " · " + t("trash.nextPurge").replace("{time}", formatTime(nextPurgeAt))
                  : "")) : null
          ),
          h("button", {
            type: "button", className: "scl-close", style: { color: palette.secondary },
            "aria-label": t("dialog.close"), title: t("dialog.close"),
            disabled: busy, onClick: () => { if (!busy) closeTrashUi(); }
          }, "\u00d7")
        ),
        h("div", { className: "scl-controls" },
          h("input", {
            className: "scl-input", style: themeInput, type: "text",
            placeholder: t("trash.search"), value: keyword,
            onChange: (e) => { setKeyword(e.target.value); if (contentMatches !== null) setContentMatches(null); }
          }),
          h("label", { className: "scl-check", style: { color: palette.secondary } },
            h("input", {
              type: "checkbox", checked: searchContent,
              onChange: (e) => { setSearchContent(e.target.checked); if (!e.target.checked) setContentMatches(null); }
            }),
            t("trash.searchContent")
          ),
          h("select", {
            className: "scl-select", style: themeInput, value: workspaceFilter,
            onChange: (e) => setWorkspaceFilter(e.target.value)
          },
            h("option", { value: "" }, t("trash.workspaceAll")),
            workspaces.map((cwd) => h("option", { key: cwd, value: cwd }, cwd))
          ),
          h("select", {
            className: "scl-select", style: themeInput, value: sortKey,
            onChange: (e) => setSortKey(e.target.value)
          },
            h("option", { value: "deletedAt" }, t("trash.sortDeleted")),
            h("option", { value: "title" }, t("trash.sortTitle")),
            h("option", { value: "bytes" }, t("trash.sortSize")),
            h("option", { value: "turns" }, t("trash.sortTurns"))
          ),
          h("button", {
            type: "button", className: "scl-sortBtn", style: { ...themeInput, color: palette.text },
            title: sortAsc ? t("sort.asc") : t("sort.desc"), onClick: () => setSortAsc(!sortAsc)
          }, sortAsc ? "↑" : "↓")
        ),
        notice ? h("div", { className: "scl-tNotice", style: { color: palette.success } }, notice) : null,
        errorText ? h("div", { className: "scl-tNotice", style: { color: palette.danger } }, errorText) : null,
        items === null
          ? h("div", { className: "scl-empty", style: { color: palette.secondary } }, t("dialog.loading"))
          : h("div", { className: "scl-tList" },
              visibleItems.length === 0
                ? h("div", { className: "scl-empty", style: { color: palette.secondary } },
                    searching ? t("trash.searching")
                      : contentMatches !== null && keyword.trim() !== "" ? t("trash.searchNone")
                        : t("trash.emptyState"))
                : visibleItems.map((item) => {
                    const hits = contentMatches ? contentMatches[item.id] : undefined;
                    const metaBits = [];
                    if (typeof item.cwd === "string" && item.cwd) metaBits.push(item.cwd);
                    if (Number.isFinite(item.turns)) metaBits.push(item.turns + " " + t("unit.turns"));
                    if (Number.isFinite(item.bytes)) metaBits.push(formatBytes(item.bytes));
                    if (Number.isFinite(item.deletedAt)) metaBits.push(t("trash.deletedAt") + " " + formatTime(item.deletedAt));
                    return h("div", {
                      className: "scl-tRow",
                      key: item.id,
                      style: { borderColor: palette.rowBorder, cursor: "pointer" },
                      // 整行都能点开阅读（勾选框除外），不用去找那个小按钮
                      onClick: (event) => {
                        const tag = event && event.target && event.target.tagName;
                        if (tag === "INPUT" || tag === "BUTTON") return;
                        openDetail(item.id);
                      }
                    },
                      h("input", {
                        type: "checkbox", checked: checked.has(item.id),
                        onChange: () => toggleChecked(item.id)
                      }),
                      h("div", { className: "scl-tMain" },
                        h("div", {
                          className: "scl-tTitle",
                          // 已删除的会话：灰色 + 划横线，一眼看出这是回收站里的东西
                          style: { color: palette.secondary, textDecoration: "line-through", opacity: 0.85 }
                        },
                          item.title || item.id,
                          h("span", { className: "scl-tBadge", style: { color: palette.danger, textDecoration: "none" } },
                            t("trash.deletedTag")),
                          hits !== undefined ? h("span", { className: "scl-tBadge", style: { color: palette.secondary, textDecoration: "none" } }, t("trash.searchHit").replace("{n}", String(hits))) : null
                        ),
                        metaBits.length ? h("div", { className: "scl-tMeta", style: { color: palette.secondary } }, metaBits.join(" · ")) : null
                      ),
                      h("div", { className: "scl-tBtns" },
                        h("button", {
                          type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
                          disabled: busy, onClick: () => openDetail(item.id)
                        }, t("trash.viewLog"))
                      )
                    );
                  })
            ),
        h("div", { className: "scl-batchBar", style: { borderTop: "1px solid " + palette.panelBorder } },
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: !items || visibleItems.length === 0,
            onClick: toggleSelectAllVisible
          }, visibleItems.length > 0 && visibleItems.every(i => checked.has(i.id)) ? t("trash.deselectAll") : t("trash.selectAll")),
          checked.size > 0 ? h("span", { className: "scl-tNotice", style: { color: palette.secondary, margin: 0 } }, t("trash.selected").replace("{n}", String(checked.size))) : null,
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: busy || checked.size === 0,
            onClick: () => setConfirmState({
              message: t("trash.confirmRestore").replace("{n}", String(checked.size)),
              run: () => doRestore([...checked])
            })
          }, t("trash.restoreSelected")),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { color: palette.danger, borderColor: palette.rowBorder },
            disabled: busy || checked.size === 0,
            onClick: () => setConfirmState({ message: t("trash.confirmPurge").replace("{n}", String(checked.size)), run: () => doPurge([...checked]) })
          }, t("trash.purgeSelected")),
          h("div", { className: "scl-spacer" }),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { ...themeInput, color: palette.text },
            disabled: busy,
            onClick: () => openManager()
          }, t("manager.title")),
          h("button", {
            type: "button", className: "scl-miniBtn", style: { color: palette.danger, borderColor: palette.rowBorder },
            disabled: busy || !items || items.length === 0,
            onClick: () => setConfirmState({ message: t("trash.confirmEmpty").replace("{n}", String(items.length)), run: doEmpty })
          }, t("trash.emptyBin"))
        )
        ),
        confirmState ? h("div", {
          className: "scl-layer", style: { background: palette.layer, zIndex: 11050 },
          role: "presentation",
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) setConfirmState(null); }
        },
          h("section", {
            className: "scl-panel scl-panelSmall",
            style: { background: palette.panel, border: "1px solid " + palette.panelBorder, boxShadow: palette.shadow, color: palette.text },
            role: "dialog", "aria-modal": "true"
          },
            h("div", { style: { color: palette.text } }, confirmState.message),
            h("div", { className: "scl-footer" },
              h("button", {
                type: "button", className: "scl-btn",
                style: { border: "1px solid " + palette.btnBorder, background: "transparent", color: palette.text },
                disabled: busy,
                onClick: () => setConfirmState(null)
              }, t("dialog.cancel")),
              h("button", {
                type: "button", className: "scl-btn scl-btnDanger",
                style: { border: "1px solid " + palette.danger, background: palette.danger, color: "#ffffff" },
                disabled: busy,
                onClick: () => { const run = confirmState.run; setConfirmState(null); run(); }
              }, t("trash.confirm"))
            )
          )
        ) : null
      );
    }

    // ───────────────────────── 插件入口 ─────────────────────────

    function apply(ctx) {
      hostCtx = ctx;

      ctx.effect(() => injectStyle(), "session-cleaner: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-cleaner: dictionaries");

      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "session-cleaner-delete",
          order: 500,
          locale: NS,
          inject: () => ({})
        }, DeleteSessionMenuItem);
      });

      // 侧栏底部那个撑满宽度的按钮已移除：改成下面的可拖拽悬浮小球，
      // 不再遮挡别人的界面。TrashFooterAction 保留在源码里以便随时切回。

      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-floating-entry",
          locale: NS,
          inject: () => ({})
        }, FloatingEntry);
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-toast",
          locale: NS,
          inject: () => ({})
        }, TrashToast);
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-trash-ui",
          locale: NS,
          inject: () => ({ useTrashUiOpen, closeTrashUi })
        }, RecycleBinOverlay);
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-delete-confirm",
          locale: NS,
          inject: () => ({ usePendingDelete })
        }, DeleteConfirmOverlay);
        yield ctx.slots.register({
          name: "shell.overlay",
          id: "session-cleaner-manager",
          locale: NS,
          inject: () => ({ useManagerOpen, closeManager })
        }, SessionManagerOverlay);
      });
    }

    const inject = ["slots", "locale", "sessions"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
