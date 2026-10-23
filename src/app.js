/* =========================================================
   不许忘！—— 轻便备忘录 前端逻辑
   数据目录结构：
     索引.json              树结构（可删除重建）
     条目/<id>/正文.md       条目内容（文字与媒体混排）
     条目/<id>/媒体/<文件名> 媒体文件
     回收站/回收站.json      软删除记录
     回收站/<id>/...         软删除的条目文件夹
   ========================================================= */
(function () {
  'use strict';

  var T = window.__TAURI__;
  if (!T || !T.core) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#E7F0EA;background:#0C1210;height:100vh">请通过程序本体启动（缺少 Tauri 运行环境）。</div>';
    return;
  }
  var invoke = T.core.invoke;
  var convertFileSrc = T.core.convertFileSrc;
  var appWindow = T.window.getCurrentWindow();

  var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'jfif'];
  var VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'wmv', 'flv'];
  var AUDIO_EXT = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus'];
  var IMG_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
    svg: 'image/svg+xml', ico: 'image/x-icon'
  };
  var MAX_MEDIA_BYTES = 200 * 1024 * 1024;

  var DEFAULT_SETTINGS = {
    dataDir: '',
    skin: 'green',
    displayName: '不许忘！',
    shortcut: 'Ctrl+Alt+Space',
    retentionDays: 30,
    autostart: false,
    closeAction: 'exit',
    newItemPos: 'top',
    lastSelectedId: ''
  };

  var dataDir = '';
  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var index = { version: 1, roots: [] };
  var trash = { version: 1, items: [] };
  var contentCache = Object.create(null);
  var contentLoaded = Object.create(null);
  var importDepth = 0;
  var selectedId = null;
  var draggingId = null;
  var searchQuery = '';
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ---------- 基础工具 ---------- */

  function uid() {
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normPath(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  function joinPath() {
    var parts = Array.prototype.slice.call(arguments).filter(function (s) { return s !== '' && s != null; });
    return parts.join('\\').replace(/\\+/g, '\\');
  }

  function walk(nodes, fn, parent) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      fn(n, parent || null);
      if (n.children && n.children.length) walk(n.children, fn, n);
    }
  }

  function findNode(id, nodes) {
    nodes = nodes || index.roots;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return nodes[i];
      if (nodes[i].children && nodes[i].children.length) {
        var r = findNode(id, nodes[i].children);
        if (r) return r;
      }
    }
    return null;
  }

  function findParent(id, nodes, parent) {
    nodes = nodes || index.roots;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return parent || null;
      if (nodes[i].children && nodes[i].children.length) {
        var r = findParent(id, nodes[i].children, nodes[i]);
        if (r) return r;
      }
    }
    return null;
  }

  function isAncestor(node, id) {
    if (!node.children || !node.children.length) return false;
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].id === id) return true;
      if (isAncestor(node.children[i], id)) return true;
    }
    return false;
  }

  function detach(id) {
    var parent = findParent(id);
    var list = parent ? parent.children : index.roots;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list.splice(i, 1)[0];
    }
    return null;
  }

  function siblingList(id) {
    var p = findParent(id);
    return p ? p.children : index.roots;
  }

  /** 置顶的排在同级最前，其余保持原有相对顺序。 */
  function pinnedFirst(list) {
    var top = [], rest = [];
    for (var i = 0; i < list.length; i++) (list[i].pinned ? top : rest).push(list[i]);
    return top.concat(rest);
  }

  function fullyDone(n) {
    if (!n.done) return false;
    if (!n.children || !n.children.length) return true;
    for (var i = 0; i < n.children.length; i++) {
      if (!fullyDone(n.children[i])) return false;
    }
    return true;
  }

  /** 下次打开时的重排：完成且整棵子树都完成的，沉到同级末尾（保持原有相对顺序）。 */
  function resort(list) {
    var kept = [], sunk = [];
    for (var i = 0; i < list.length; i++) (fullyDone(list[i]) ? sunk : kept).push(list[i]);
    list.length = 0;
    for (var j = 0; j < kept.length; j++) list.push(kept[j]);
    for (var k = 0; k < sunk.length; k++) list.push(sunk[k]);
    for (var m = 0; m < list.length; m++) {
      if (list[m].children && list[m].children.length) resort(list[m].children);
    }
  }

  function extOf(name) {
    var i = String(name || '').lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }

  /** 剪贴板里的图片常常没有文件名，退回到 MIME 类型判断。 */
  function extFromFile(f) {
    var e = extOf(f && f.name);
    if (e) return e;
    var t = String((f && f.type) || '').split('/')[1] || '';
    return t.replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace('x-icon', 'ico');
  }

  function isMediaFile(f) {
    return isMediaExt(extFromFile(f));
  }

  function isMediaExt(ext) {
    return IMAGE_EXT.indexOf(ext) >= 0 || VIDEO_EXT.indexOf(ext) >= 0 || AUDIO_EXT.indexOf(ext) >= 0;
  }

  function sanitizeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function firstLine(md) {
    if (!md) return '';
    var lines = String(md).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
      if (line) return line;
    }
    return '';
  }

  function displayName(n) {
    var t = (n.title || '').trim();
    if (t) return t;
    var f = firstLine(contentCache[n.id]);
    if (f) return f.length > 34 ? f.slice(0, 34) + '…' : f;
    return '未命名';
  }

  function countAll(n) {
    var total = 0, done = 0;
    var stack = (n.children || []).slice();
    while (stack.length) {
      var c = stack.pop();
      total++;
      if (c.done) done++;
      if (c.children) stack.push.apply(stack, c.children);
    }
    return { total: total, done: done };
  }

  function mediaCount(n) {
    var md = contentCache[n.id] || '';
    var m = md.match(/!\[[^\]]*\]\([^)]*媒体\/[^)]+\)/g);
    return m ? m.length : 0;
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    function p(x) { return String(x).length < 2 ? '0' + x : String(x); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 列表里用的短格式：10-21 15:30 */
  function fmtRemind(ts) {
    var d = new Date(ts);
    function p(x) { return String(x).length < 2 ? '0' + x : String(x); }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  function entryDir(id) { return joinPath('条目', id); }
  function trashDir(id) { return joinPath('回收站', id); }
  function contentPath(id) { return joinPath('条目', id, '正文.md'); }
  function mediaDirRel(id) { return joinPath('条目', id, '媒体'); }

  /* ---------- 磁盘读写 ---------- */

  async function readText(path) {
    try { return await invoke('read_text', { path: path }); } catch (e) { return ''; }
  }
  async function writeText(path, contents) {
    try { await invoke('write_text', { path: path, contents: contents }); } catch (e) { console.error(e); }
  }
  async function exists(path) {
    try { return await invoke('path_exists', { path: path }); } catch (e) { return false; }
  }
  async function listDir(path) {
    try { return await invoke('list_dir', { path: path }); } catch (e) { return []; }
  }

  var indexTimer = null;
  function saveIndexSoon() {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(saveIndexNow, 350);
  }
  async function saveIndexNow() {
    if (indexTimer) { clearTimeout(indexTimer); indexTimer = null; }
    await writeText('索引.json', JSON.stringify(index, null, 2));
  }

  var trashTimer = null;
  function saveTrashSoon() {
    if (trashTimer) clearTimeout(trashTimer);
    trashTimer = setTimeout(function () {
      writeText(joinPath('回收站', '回收站.json'), JSON.stringify(trash, null, 2));
    }, 350);
  }

  var pendingContent = Object.create(null);
  var contentTimer = null;
  function saveContentSoon(id) {
    pendingContent[id] = true;
    if (contentTimer) clearTimeout(contentTimer);
    contentTimer = setTimeout(flushContent, 450);
  }
  async function flushContent() {
    if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; }
    var ids = Object.keys(pendingContent);
    pendingContent = Object.create(null);
    for (var i = 0; i < ids.length; i++) {
      await writeText(contentPath(ids[i]), contentCache[ids[i]] || '');
    }
  }

  /* ---------- 媒体清理：正文里不再引用的文件直接从磁盘删掉 ---------- */

  /** 正文引用到的媒体文件名；兼容旧的「媒体/x.png」与新存的完整路径两种写法。 */
  function referencedMedia(id) {
    var full = mediaDirRel(id).replace(/\\/g, '/') + '/';
    var keep = Object.create(null);
    var md = contentCache[id] || '';
    MEDIA_RE.lastIndex = 0;
    var m;
    while ((m = MEDIA_RE.exec(md))) {
      var p = String(m[2] || '').replace(/\\/g, '/');
      var nm = null;
      if (p.indexOf(full) === 0) nm = p.slice(full.length);
      else if (p.indexOf('媒体/') === 0) nm = p.slice(3);
      if (nm && nm.indexOf('/') < 0) keep[nm] = true;
    }
    return keep;
  }

  /** 扫一遍这个条目的媒体目录，把没被正文引用的文件删掉，避免删图后磁盘里还留着。 */
  async function sweepMedia(id) {
    if (!id || importDepth > 0) return;
    var dirRel = mediaDirRel(id);
    var names = await listDir(dirRel);
    if (!names.length) return;
    var keep = referencedMedia(id);
    for (var i = 0; i < names.length; i++) {
      if (!keep[names[i]]) {
        try { await invoke('remove_path', { path: joinPath(dirRel, names[i]) }); } catch (e) {}
      }
    }
  }

  var pendingSweep = Object.create(null);
  var sweepTimer = null;
  function sweepSoon(id) {
    if (!id) return;
    pendingSweep[id] = true;
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(flushSweep, 2000);
  }
  async function flushSweep() {
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    var ids = Object.keys(pendingSweep);
    pendingSweep = Object.create(null);
    for (var i = 0; i < ids.length; i++) await sweepMedia(ids[i]);
  }

  var settingsTimer = null;
  function saveSettingsSoon() {
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(saveSettingsNow, 300);
  }
  async function saveSettingsNow() {
    if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; }
    try { await invoke('write_settings', { contents: JSON.stringify(settings, null, 2) }); } catch (e) { console.error(e); }
  }

  /* ---------- 内容流：Markdown 与 DOM 互转 ---------- */

  var MEDIA_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

  function appendText(flow, text) {
    if (!text) return;
    var parts = String(text).split('\n');
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) flow.appendChild(document.createElement('br'));
      if (parts[i]) flow.appendChild(document.createTextNode(parts[i]));
    }
  }

  /** 老数据里媒体路径是相对条目的（媒体/x.png）；新数据统一存相对数据目录的完整路径。 */
  function resolveRel(rel, entryId) {
    var r = String(rel || '').replace(/\\/g, '/');
    if (entryId && r.indexOf('媒体/') === 0) {
      return entryDir(entryId).replace(/\\/g, '/') + '/' + r;
    }
    return r;
  }

  /** 用系统默认程序打开原文件，不做任何转码或压缩。 */
  function openOriginal(rel) {
    invoke('open_path', { path: rel }).catch(function (e) {
      toast('打开失败：' + (e && e.message ? e.message : e));
    });
  }

  /** 打开这个文件所在的本地文件夹（数据目录内）。 */
  function revealFile(rel) {
    invoke('reveal', { path: rel }).catch(function (e) {
      toast('打开文件夹失败：' + (e && e.message ? e.message : e));
    });
  }

  /** 给已有的媒体元素挂上交互：双击开原图、右键菜单、加载失败回退。 */
  function attachMediaHandlers(el, rel) {
    var ext = extOf(rel);

    /* 资源协议被拦时，图片退回到直接读原始字节（不做任何转码）。 */
    function fallbackDataUrl() {
      return invoke('read_media_b64', { path: rel }).then(function (b64) {
        if (!b64) throw new Error('读不到文件');
        el.src = 'data:' + (IMG_MIME[ext] || 'application/octet-stream') + ';base64,' + b64;
      });
    }

    function markImgBroken() {
      el.classList.add('media-broken');
      el.title = '这张图没能显示，双击用系统默认程序打开原图';
    }

    if (el.tagName === 'IMG') {
      el.title = rel + '（双击打开原图，右键更多操作）';
      el.addEventListener('dblclick', function (ev) {
        ev.preventDefault();
        openOriginal(rel);
      });
      /* 屏蔽系统自带菜单（更多工具、放大图像、分享等），换成自己的两项。 */
      el.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openMediaCtx(ev.clientX, ev.clientY, rel);
      });
      /* 资源协议正常时不额外动作；被拦或超时都退回到直接读原始字节，保证一定显示。 */
      var settled = false;
      var timer = setTimeout(function () {
        if (settled || (el.complete && el.naturalWidth > 0)) return;
        settled = true;
        fallbackDataUrl().catch(markImgBroken);
      }, 2000);
      el.addEventListener('load', function () { settled = true; clearTimeout(timer); });
      el.addEventListener('error', function onImgErr() {
        el.removeEventListener('error', onImgErr);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fallbackDataUrl().catch(markImgBroken);
      });
    } else {
      el.addEventListener('error', function onMediaErr() {
        el.removeEventListener('error', onMediaErr);
        el.classList.add('media-broken');
        el.title = '这个文件没能加载，点一下在文件夹里打开';
        el.addEventListener('click', function (ev) {
          ev.preventDefault();
          revealFile(rel);
        });
      });
    }
  }

  function mediaSrc(rel) {
    var abs = joinPath(dataDir, String(rel).replace(/\//g, '\\'));
    return convertFileSrc(abs);
  }

  function makeMediaEl(rel, alt) {
    var ext = extOf(rel);
    var src = mediaSrc(rel);
    var el;
    if (VIDEO_EXT.indexOf(ext) >= 0) {
      el = document.createElement('video');
      el.src = src;
      el.controls = true;
      el.preload = 'metadata';
    } else if (AUDIO_EXT.indexOf(ext) >= 0) {
      el = document.createElement('audio');
      el.src = src;
      el.controls = true;
    } else {
      el = document.createElement('img');
      el.src = src;
    }
    el.className = 'media';
    el.setAttribute('contenteditable', 'false');
    el.dataset.rel = rel;
    el.dataset.alt = alt || '';
    el.title = rel;
    attachMediaHandlers(el, rel);
    return el;
  }

  function renderMd(flow, md, entryId) {
    flow.innerHTML = '';
    MEDIA_RE.lastIndex = 0;
    var last = 0, m;
    while ((m = MEDIA_RE.exec(md))) {
      appendText(flow, md.slice(last, m.index));
      flow.appendChild(makeMediaEl(resolveRel(m[2], entryId), m[1]));
      last = m.index + m[0].length;
    }
    appendText(flow, md.slice(last));
  }

  function serializeFlow(flow) {
    var out = '';
    (function rec(parent) {
      var kids = parent.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var node = kids[i];
        if (node.nodeType === 3) { out += node.nodeValue; continue; }
        if (node.nodeType !== 1) continue;
        var tag = node.tagName;
        if (tag === 'BR') { out += '\n'; continue; }
        if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO') {
          out += '![' + (node.dataset.alt || '') + '](' + (node.dataset.rel || '') + ')';
          continue;
        }
        rec(node);
        if (tag === 'DIV' || tag === 'P') out += '\n';
      }
    })(flow);
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 光标所在的落点；没有有效选区时退回到正文末尾。 */
  function caretRangeIn(flow) {
    flow.focus();
    var sel = window.getSelection();
    if (sel && sel.rangeCount && flow.contains(sel.anchorNode)) return sel.getRangeAt(0);
    var range = document.createRange();
    range.selectNodeContents(flow);
    range.collapse(false);
    return range;
  }

  function mediaTagHtml(rel, alt, token) {
    var ext = extOf(rel);
    var tag = VIDEO_EXT.indexOf(ext) >= 0 ? 'video' : (AUDIO_EXT.indexOf(ext) >= 0 ? 'audio' : 'img');
    return '<br><' + tag + ' src="' + escAttr(mediaSrc(rel)) + '"' +
      (tag === 'img' ? '' : ' controls') +
      ' class="media" contenteditable="false"' +
      ' data-rel="' + escAttr(rel) + '" data-alt="' + escAttr(alt || '') + '"' +
      ' title="' + escAttr(rel) + '" data-mtoken="' + token + '">' +
      (tag === 'img' ? '' : '</' + tag + '>') + '<br>';
  }

  function textToHtml(s) {
    return escAttr(s).replace(/\n/g, '<br>');
  }

  /**
   * 一次把若干段（文字/媒体）插到光标处。走 execCommand('insertHTML') 而不是直接
   * insertNode，是为了让这次改动进入浏览器原生撤销栈，Ctrl+Z 才能把它撤掉；
   * 插入后再按临时标记找回媒体元素，补上事件与加载回退。
   */
  function insertRichAtCaret(flow, parts, at) {
    var token = uid();
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      html += (p.rel != null) ? mediaTagHtml(p.rel, p.alt, token) : textToHtml(p.text || '');
    }
    if (!html) return;
    flow.focus();
    /* 落点优先用调用方在粘贴/拖放那一刻就抓好的位置：图片入库是异步的，等它写完
       选区可能已经被重置；没有就退回当前光标，再没有才落到末尾。
       注意必须在清空选区之前拿到范围，否则读到的永远是空选区、只能插到末尾。 */
    var range = (at && at.startContainer && flow.contains(at.startContainer)) ? at : caretRangeIn(flow);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, html);

    var els = flow.querySelectorAll('[data-mtoken="' + token + '"]');
    for (var k = 0; k < els.length; k++) {
      els[k].removeAttribute('data-mtoken');
      attachMediaHandlers(els[k], els[k].dataset.rel || '');
    }
  }

  function insertMediaAtCaret(flow, rel, alt, at) {
    insertRichAtCaret(flow, [{ rel: rel, alt: alt }], at);
  }

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  var WRITE_CHUNK = 4 * 1024 * 1024;

  async function importMedia(entryId, file) {
    var ext = extFromFile(file);
    if (!isMediaExt(ext)) return null;
    if (file.size > MAX_MEDIA_BYTES) {
      toast('「' + (file.name || '文件') + '」超过 200MB，暂不支持');
      return null;
    }
    var dirRel = mediaDirRel(entryId);
    var names = await listDir(dirRel);
    var base = sanitizeName(String(file.name || '').replace(/\.[^.]+$/, '')) || '媒体';
    var name = base + '.' + ext;
    var i = 1;
    while (names.indexOf(name) >= 0) { name = base + '-' + i + '.' + ext; i++; }
    var target = joinPath(dirRel, name);
    var bytes = new Uint8Array(await file.arrayBuffer());
    var total = Math.max(1, Math.ceil(bytes.length / WRITE_CHUNK));
    importDepth++;
    try {
      for (var c = 0; c < total; c++) {
        var part = bytes.subarray(c * WRITE_CHUNK, Math.min((c + 1) * WRITE_CHUNK, bytes.length));
        await invoke('write_bytes', { path: target, b64: bufToB64(part), first: c === 0 });
      }
    } finally {
      importDepth--;
    }
    /* 存相对数据目录的完整路径，这样正文里的媒体引用不依赖上下文也能定位。 */
    return mediaDirRel(entryId).replace(/\\/g, '/') + '/' + name;
  }

  async function insertFiles(flow, entryId, files, x, y, at) {
    if (!files || !files.length) return 0;
    /* 拖放按落点定位；粘贴时没有坐标，用调用方在事件那一刻抓好的光标位置。 */
    if (!at && typeof x === 'number' && document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r && flow.contains(r.startContainer)) at = r.cloneRange();
    }
    if (!at) at = caretRangeIn(flow);
    var n = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var rel = await importMedia(entryId, f);
      if (!rel) continue;
      insertMediaAtCaret(flow, rel, String(f.name).replace(/\.[^.]+$/, ''), at);
      at = caretRangeIn(flow);
      n++;
    }
    return n;
  }

  /* ---------- 剪贴板：文字与图片混排的粘贴 ---------- */

  /** 把一段 HTML 拆成按出现顺序排列的文字段与图片段。 */
  function htmlToSegments(html) {
    var out = [];
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return out; }
    var body = doc && doc.body;
    if (!body) return out;
    var buf = '';
    function flush() {
      if (buf) { out.push({ type: 'text', value: buf }); buf = ''; }
    }
    (function walk(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 3) { buf += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName;
        if (tag === 'IMG') {
          flush();
          var src = n.getAttribute('src') || n.getAttribute('data-src') || '';
          if (src) out.push({ type: 'img', src: src, alt: n.getAttribute('alt') || '' });
          continue;
        }
        if (tag === 'BR') { buf += '\n'; continue; }
        if (tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'TR') {
          if (buf && buf.slice(-1) !== '\n') buf += '\n';
          walk(n);
          if (buf && buf.slice(-1) !== '\n') buf += '\n';
          continue;
        }
        walk(n);
      }
    })(body);
    flush();
    for (var j = 0; j < out.length; j++) {
      if (out[j].type === 'text') out[j].value = out[j].value.replace(/\n{3,}/g, '\n\n');
    }
    while (out.length && out[0].type === 'text' && !out[0].value.trim()) out.shift();
    while (out.length && out[out.length - 1].type === 'text' && !out[out.length - 1].value.trim()) out.pop();
    return out;
  }

  /** data: 内联图片还原成 File，走和拖拽粘贴一样的入库流程。 */
  function dataUrlToFile(src, alt) {
    var s = String(src);
    var comma = s.indexOf(',');
    if (comma < 0) return null;
    var flags = s.slice(5, comma).split(';');
    var mime = 'application/octet-stream';
    if (flags.length && flags[0].indexOf('/') > 0) mime = flags.shift().toLowerCase();
    var isB64 = false;
    for (var i = 0; i < flags.length; i++) if (flags[i].toLowerCase() === 'base64') isB64 = true;
    var bytes;
    try {
      if (isB64) {
        var bin = atob(s.slice(comma + 1));
        bytes = new Uint8Array(bin.length);
        for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(s.slice(comma + 1)));
      }
    } catch (_) { return null; }
    var sub = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')
      .replace('x-icon', 'ico').split('+')[0];
    if (!isMediaExt(sub)) sub = 'png';
    return new File([bytes], (sanitizeName(alt) || '粘贴图片') + '.' + sub, { type: mime });
  }

  /** file:///C:/... 或 C:\... 这类本地路径还原成绝对路径。 */
  function fileUrlToPath(src) {
    var s = String(src || '').trim();
    if (/^file:\/\//i.test(s)) {
      s = s.replace(/^file:\/\//i, '').replace(/^localhost\//i, '').replace(/^\/(?=[a-zA-Z]:)/, '');
      try { s = decodeURIComponent(s); } catch (_) {}
      return s.replace(/\//g, '\\');
    }
    if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\//g, '\\');
    return '';
  }

  /** 把外部本地图片复制进条目的媒体目录（后端只允许「外部文件 → 数据目录」单向复制）。 */
  async function importExternal(entryId, absPath, baseName) {
    var ext = extOf(absPath) || 'png';
    if (!isMediaExt(ext)) return null;
    var dirRel = mediaDirRel(entryId);
    var names = await listDir(dirRel);
    var base = sanitizeName(baseName) || '粘贴图片';
    var name = base + '.' + ext;
    var i = 1;
    while (names.indexOf(name) >= 0) { name = base + '-' + i + '.' + ext; i++; }
    var target = joinPath(dirRel, name);
    importDepth++;
    try {
      await invoke('import_media_from_path', { source: absPath, dest: target });
    } catch (e) {
      return null;
    } finally {
      importDepth--;
    }
    return dirRel.replace(/\\/g, '/') + '/' + name;
  }

  /** 粘贴「文字+图片」时自己接管：图片入库，文字与图片按原顺序插回正文。 */
  async function handleHtmlPaste(flow, entryId, segs, at) {
    var parts = [];
    var failed = 0;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.type === 'text') { parts.push({ text: s.value }); continue; }
      var rel = null;
      if (/^data:/i.test(s.src)) {
        var f = dataUrlToFile(s.src, s.alt);
        if (f) rel = await importMedia(entryId, f);
      } else {
        var abs = fileUrlToPath(s.src);
        if (abs) rel = await importExternal(entryId, abs, s.alt);
      }
      if (rel) parts.push({ rel: rel, alt: s.alt });
      else failed++;
    }
    var cnt = 0;
    for (var k = 0; k < parts.length; k++) if (parts[k].rel != null) cnt++;
    if (parts.length) insertRichAtCaret(flow, parts, at);
    if (failed) toast(failed + ' 张图片读不到，已跳过（源文件可能已失效）');
    return cnt;
  }

  /* ---------- 条目树渲染 ---------- */

  var depthMap = Object.create(null);

  function buildDepthMap() {
    depthMap = Object.create(null);
    (function rec(list, d) {
      for (var i = 0; i < list.length; i++) {
        depthMap[list[i].id] = d;
        if (list[i].children) rec(list[i].children, d + 1);
      }
    })(index.roots, 0);
  }

  function visibleRows() {
    var out = [];
    var q = searchQuery.trim().toLowerCase();
    if (q) {
      var hit = Object.create(null);
      walk(index.roots, function (n) {
        var hay = (displayName(n) + '\n' + (contentCache[n.id] || '')).toLowerCase();
        if (hay.indexOf(q) >= 0) hit[n.id] = true;
      });
      var keep = Object.create(null);
      Object.keys(hit).forEach(function (id) { keep[id] = true; });
      Object.keys(hit).forEach(function (id) {
        var p = findParent(id);
        while (p) { keep[p.id] = true; p = findParent(p.id); }
      });
      walk(index.roots, function (n) {
        if (keep[n.id]) out.push({ n: n, depth: depthMap[n.id] || 0 });
      });
      return out;
    }
    (function rec(list) {
      list = pinnedFirst(list);
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        out.push({ n: n, depth: depthMap[n.id] || 0 });
        if (!n.collapsed && n.children && n.children.length) rec(n.children);
      }
    })(index.roots);
    return out;
  }

  function clearDropMarks() {
    var marked = document.querySelectorAll('.drop-before, .drop-after, .drop-into, .dragover');
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove('drop-before', 'drop-after', 'drop-into', 'dragover');
    }
  }

  function moveNode(dragId, targetId, zone) {
    var drag = findNode(dragId);
    var target = findNode(targetId);
    draggingId = null;
    if (!drag || !target || dragId === targetId) return;
    if (isAncestor(drag, targetId)) { toast('不能把条目拖进它自己的子条目里'); return; }
    detach(dragId);
    if (zone === 'into') {
      if (!target.children) target.children = [];
      target.children.push(drag);
      target.collapsed = false;
    } else {
      var list = siblingList(targetId);
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === targetId) {
          list.splice(zone === 'before' ? i : i + 1, 0, drag);
          break;
        }
      }
    }
    saveIndexSoon();
    renderTree();
    if (selectedId) renderDetail();
  }

  function buildRow(n, depth) {
    var row = document.createElement('div');
    var overdue = !n.done && n.remindAt && n.remindAt <= Date.now();
    row.className = 'row' + (n.id === selectedId ? ' sel' : '') + (n.done ? ' done' : '') + (overdue ? ' overdue' : '') + (n.pinned ? ' pinned' : '');
    row.dataset.id = n.id;
    row.style.paddingLeft = (8 + depth * 15) + 'px';
    row.draggable = true;

    var hasKids = n.children && n.children.length > 0;
    var caret = document.createElement('span');
    caret.className = 'caret' + (hasKids ? (n.collapsed ? '' : ' open') : ' leaf');
    caret.textContent = '▶';
    caret.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    caret.addEventListener('click', function (e) {
      e.stopPropagation();
      n.collapsed = !n.collapsed;
      saveIndexSoon();
      renderTree();
    });
    row.appendChild(caret);

    var check = document.createElement('span');
    check.className = 'check' + (n.done ? ' on' : '');
    check.title = '勾选完成：本次顺序不变，下次打开沉到同级最后';
    check.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    check.addEventListener('click', function (e) {
      e.stopPropagation();
      n.done = !n.done;
      /* 完成的条目不再需要置顶，自动取消。 */
      if (n.done && n.pinned) n.pinned = false;
      saveIndexSoon();
      renderTree();
      if (n.id === selectedId) { renderDetail(); }
      toast(n.done ? '已勾选完成，下次打开会沉到同级最后' : '已取消完成');
    });
    row.appendChild(check);

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = displayName(n);
    name.title = name.textContent;
    row.appendChild(name);

    var c = countAll(n);
    if (c.total > 0) {
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = c.done + '/' + c.total;
      meta.title = '子条目完成数';
      row.appendChild(meta);
    }
    var mc = mediaCount(n);
    if (mc > 0) {
      var meta2 = document.createElement('span');
      meta2.className = 'meta';
      meta2.textContent = '◍' + mc;
      meta2.title = '媒体数量';
      row.appendChild(meta2);
    }
    if (n.pinned) {
      var pmeta = document.createElement('span');
      pmeta.className = 'meta pin';
      pmeta.textContent = '📌';
      pmeta.title = '已置顶';
      row.appendChild(pmeta);
    }
    if (n.remindAt) {
      var rmeta = document.createElement('span');
      rmeta.className = 'meta' + (n.remindDone ? ' remind-done' : '');
      rmeta.textContent = '⏰';
      rmeta.title = (n.remindDone ? '已提醒：' : '提醒：') + fmtDate(n.remindAt);
      row.appendChild(rmeta);
    }

    var add = document.createElement('button');
    add.className = 'add';
    add.textContent = '＋';
    add.title = '在这个条目下新建子条目';
    add.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    add.addEventListener('click', function (e) { e.stopPropagation(); newEntry(n.id); });
    row.appendChild(add);

    row.addEventListener('click', function () {
      selectNode(n.id === selectedId ? null : n.id);
    });
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      selectNode(n.id);
      openCtx(e.clientX, e.clientY, n);
    });

    row.addEventListener('dragstart', function (e) {
      draggingId = n.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', n.id); } catch (_) {}
    });
    row.addEventListener('dragend', function () { draggingId = null; clearDropMarks(); });
    row.addEventListener('dragover', function (e) {
      if (!draggingId || draggingId === n.id) return;
      var drag = findNode(draggingId);
      if (!drag || isAncestor(drag, n.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var rect = row.getBoundingClientRect();
      var t = (e.clientY - rect.top) / rect.height;
      var zone = t < 0.3 ? 'before' : (t > 0.7 ? 'after' : 'into');
      clearDropMarks();
      row.classList.add('drop-' + zone);
    });
    row.addEventListener('dragleave', function () {
      row.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
    row.addEventListener('drop', function (e) {
      var zone = row.classList.contains('drop-into') ? 'into'
        : (row.classList.contains('drop-before') ? 'before'
          : (row.classList.contains('drop-after') ? 'after' : null));
      clearDropMarks();
      if (!zone || !draggingId) return;
      e.preventDefault();
      e.stopPropagation();
      moveNode(draggingId, n.id, zone);
    });

    return row;
  }

  var treeTimer = null;
  function refreshTreeSoon() {
    if (treeTimer) clearTimeout(treeTimer);
    treeTimer = setTimeout(renderTree, 260);
  }

  function renderTree() {
    var el = $('tree');
    el.innerHTML = '';
    buildDepthMap();
    if (!index.roots.length) {
      var d = document.createElement('div');
      d.className = 'tree-empty';
      d.innerHTML = '还没有条目。<br>点上面「＋ 新条目」建第一条。';
      el.appendChild(d);
      return;
    }
    var rows = visibleRows();
    if (!rows.length) {
      var d2 = document.createElement('div');
      d2.className = 'tree-empty';
      d2.textContent = '没有匹配的条目。';
      el.appendChild(d2);
      return;
    }
    for (var i = 0; i < rows.length; i++) el.appendChild(buildRow(rows[i].n, rows[i].depth));

    var tail = document.createElement('div');
    tail.className = 'tree-tail';
    tail.title = '拖到这里变成最外层条目';
    tail.addEventListener('dragover', function (e) {
      if (!draggingId) return;
      e.preventDefault();
      tail.classList.add('dragover');
    });
    tail.addEventListener('dragleave', function () { tail.classList.remove('dragover'); });
    tail.addEventListener('drop', function (e) {
      e.preventDefault();
      tail.classList.remove('dragover');
      if (!draggingId) return;
      var drag = detach(draggingId);
      draggingId = null;
      if (!drag) return;
      index.roots.push(drag);
      saveIndexSoon();
      renderTree();
    });
    el.appendChild(tail);
  }

  /* ---------- 编辑区渲染 ---------- */

  function renderDetail() {
    var el = $('detail');
    el.innerHTML = '';
    if (!selectedId) {
      var empty = document.createElement('div');
      empty.className = 'detail-empty';
      empty.innerHTML =
        '<div>左边点一条开始编辑，再点一次回到空选。</div>' +
        '<div>空选时点「＋ 新条目」新建独立条目；选中某条时点它，就在这条下面新建子条目。</div>' +
        '<div>图片、视频直接拖进来或 Ctrl+V 粘贴进来，插在光标所在的位置。</div>' +
        '<div>按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> 随时唤起窗口。</div>';
      el.appendChild(empty);
      return;
    }
    var n = findNode(selectedId);
    if (!n) { selectedId = null; renderDetail(); return; }

    var title = document.createElement('input');
    title.className = 'title-input';
    title.type = 'text';
    title.spellcheck = false;
    title.placeholder = '标题（可留空，留空就用正文第一行当显示名）';
    title.value = n.title || '';
    title.addEventListener('input', function () {
      n.title = title.value;
      saveIndexSoon();
      refreshTreeSoon();
    });
    el.appendChild(title);

    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '正文随便写，图片/视频拖进来或粘贴进来，插在光标位置；改动自动保存。';
    el.appendChild(hint);

    var flow = document.createElement('div');
    flow.className = 'flow';
    flow.contentEditable = 'true';
    flow.spellcheck = false;
    flow.dataset.ph = '在这里写正文…';
    renderMd(flow, contentCache[n.id] || '', n.id);
    flow.addEventListener('input', function () {
      contentCache[n.id] = serializeFlow(flow);
      saveContentSoon(n.id);
      sweepSoon(n.id);
      refreshTreeSoon();
    });
    flow.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      var files = cd.files ? Array.prototype.slice.call(cd.files) : [];
      var media = files.filter(isMediaFile);
      if (media.length) {
        e.preventDefault();
        var atFiles = caretRangeIn(flow);
        insertFiles(flow, n.id, media, undefined, undefined, atFiles).then(function (cnt) {
          if (cnt) toast('已插入 ' + cnt + ' 个媒体文件');
        });
        return;
      }
      /* 剪贴板里没有独立文件、但 HTML 里带图（聊天软件复制「文字+图片」常见）：
         默认粘贴会把这种图插成读不出来的死图，这里自己接管。 */
      var html = cd.getData ? (cd.getData('text/html') || '') : '';
      if (!html) return;
      var segs = htmlToSegments(html);
      var hasImg = false;
      for (var i = 0; i < segs.length; i++) {
        if (segs[i].type === 'img') { hasImg = true; break; }
      }
      if (!hasImg) return;
      e.preventDefault();
      var atHtml = caretRangeIn(flow);
      handleHtmlPaste(flow, n.id, segs, atHtml).then(function (cnt) {
        if (cnt) toast('已插入 ' + cnt + ' 个媒体文件');
      });
    });
    flow.addEventListener('dragover', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault();
    });
    flow.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      var files = Array.prototype.slice.call(e.dataTransfer.files);
      insertFiles(flow, n.id, files, e.clientX, e.clientY).then(function (cnt) {
        if (cnt) toast('已插入 ' + cnt + ' 个媒体文件');
      });
    });
    el.appendChild(flow);

    var foot = document.createElement('div');
    foot.className = 'detail-foot';

    var rbtn = document.createElement('button');
    rbtn.className = 'btn';
    rbtn.id = 'remindBtn';
    rbtn.addEventListener('click', function () {
      if (!$('remindPop').hidden && remindNodeId === n.id) { closeRemindPop(); return; }
      var r = rbtn.getBoundingClientRect();
      openRemindPop(n.id, r.left, r.bottom + 6);
    });
    foot.appendChild(rbtn);

    var pbtn = document.createElement('button');
    pbtn.className = 'btn';
    pbtn.id = 'pinBtn';
    pbtn.addEventListener('click', function () { togglePin(n.id); });
    foot.appendChild(pbtn);

    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    foot.appendChild(spacer);

    var note = document.createElement('span');
    note.className = 'note';
    note.textContent = settings.retentionDays
      ? '删除后进回收站，' + settings.retentionDays + ' 天内可恢复'
      : '删除后进回收站，永久保留';
    foot.appendChild(note);

    var del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除这条';
    del.title = '连同全部子条目和媒体一起放进回收站';
    del.addEventListener('click', function () { deleteNode(n.id); });
    foot.appendChild(del);

    el.appendChild(foot);
    updateRemindBtn();
    updatePinBtn();
  }

  function selectNode(id) {
    if (id === selectedId) return;
    flushContent();
    flushSweep();
    selectedId = id;
    settings.lastSelectedId = id || '';
    saveSettingsSoon();
    renderTree();
    renderDetail();
  }

  function newEntry(parentId) {
    var node = { id: uid(), title: '', done: false, collapsed: false, children: [] };
    var top = settings.newItemPos !== 'bottom';
    var p = parentId ? findNode(parentId) : null;
    if (p) {
      if (!p.children) p.children = [];
      p.children.splice(top ? 0 : p.children.length, 0, node);
      p.collapsed = false;
    } else {
      index.roots.splice(top ? 0 : index.roots.length, 0, node);
    }
    contentCache[node.id] = '';
    selectedId = node.id;
    settings.lastSelectedId = node.id;
    saveSettingsSoon();
    saveIndexSoon();
    renderTree();
    renderDetail();
    var ti = document.querySelector('.title-input');
    if (ti) ti.focus();
    toast(parentId ? '已新建子条目' : '已新建条目');
  }

  /* ---------- 删除与回收站 ---------- */

  async function deleteNode(id) {
    var n = findNode(id);
    if (!n) return;
    var name = displayName(n);
    var parent = findParent(id);
    var list = parent ? parent.children : index.roots;
    var at = 0;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) at = i;
    var ids = [];
    walk([n], function (x) { ids.push(x.id); });
    var snapshot = JSON.parse(JSON.stringify(n));
    detach(id);

    for (var j = 0; j < ids.length; j++) {
      if (await exists(entryDir(ids[j]))) {
        try { await invoke('rename_path', { from: entryDir(ids[j]), to: trashDir(ids[j]) }); } catch (e) { console.error(e); }
      }
    }
    trash.items.unshift({
      rootId: id,
      name: name,
      parentId: parent ? parent.id : null,
      at: at,
      deletedAt: Date.now(),
      snapshot: snapshot,
      ids: ids
    });
    selectedId = null;
    settings.lastSelectedId = '';
    saveSettingsSoon();
    saveIndexSoon();
    saveTrashSoon();
    renderTree();
    renderDetail();
    if (!$('trash').hidden) renderTrash();
    toast('已把「' + name + '」放进回收站，' + (settings.retentionDays ? settings.retentionDays + ' 天内可恢复' : '永久保留'));
  }

  function trashRecord(rootId) {
    for (var i = 0; i < trash.items.length; i++) if (trash.items[i].rootId === rootId) return i;
    return -1;
  }

  async function restoreTrash(rootId) {
    var i = trashRecord(rootId);
    if (i < 0) return;
    var rec = trash.items[i];
    for (var j = 0; j < rec.ids.length; j++) {
      if (await exists(trashDir(rec.ids[j]))) {
        try { await invoke('rename_path', { from: trashDir(rec.ids[j]), to: entryDir(rec.ids[j]) }); } catch (e) { console.error(e); }
      }
    }
    var parent = rec.parentId ? findNode(rec.parentId) : null;
    var list = parent ? parent.children : index.roots;
    var at = Math.max(0, Math.min(rec.at, list.length));
    list.splice(at, 0, rec.snapshot);
    trash.items.splice(i, 1);
    saveIndexSoon();
    saveTrashSoon();
    renderTree();
    renderDetail();
    renderTrash();
    toast('已恢复「' + rec.name + '」');
  }

  async function purgeTrash(rootId) {
    var i = trashRecord(rootId);
    if (i < 0) return;
    var rec = trash.items[i];
    for (var j = 0; j < rec.ids.length; j++) {
      try { await invoke('remove_path', { path: trashDir(rec.ids[j]) }); } catch (e) { console.error(e); }
    }
    trash.items.splice(i, 1);
    saveTrashSoon();
    renderTrash();
    toast('已彻底删除「' + rec.name + '」');
  }

  function renderTrash() {
    var el = $('trashList');
    el.innerHTML = '';
    if (!trash.items.length) {
      var d = document.createElement('div');
      d.className = 'trash-empty';
      d.textContent = '回收站是空的。';
      el.appendChild(d);
      return;
    }
    for (var i = 0; i < trash.items.length; i++) {
      (function (rec) {
        var row = document.createElement('div');
        row.className = 'trash-row';
        var name = document.createElement('span');
        name.className = 'tn';
        name.textContent = rec.name;
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = '含 ' + rec.ids.length + ' 条';
        var when = document.createElement('span');
        when.className = 'when';
        when.textContent = fmtDate(rec.deletedAt);
        var rb = document.createElement('button');
        rb.className = 'btn';
        rb.textContent = '恢复';
        rb.addEventListener('click', function () { restoreTrash(rec.rootId); });
        var pb = document.createElement('button');
        pb.className = 'btn danger';
        pb.textContent = '彻底删除';
        pb.addEventListener('click', function () { purgeTrash(rec.rootId); });
        row.appendChild(name);
        row.appendChild(sub);
        row.appendChild(when);
        row.appendChild(rb);
        row.appendChild(pb);
        el.appendChild(row);
      })(trash.items[i]);
    }
  }

  async function sweepTrash() {
    var days = Number(settings.retentionDays) || 0;
    if (!days) return;
    var cutoff = Date.now() - days * 86400000;
    var expired = trash.items.filter(function (r) { return r.deletedAt < cutoff; });
    for (var i = 0; i < expired.length; i++) await purgeTrash(expired[i].rootId);
    if (expired.length) toast('回收站里 ' + expired.length + ' 条已过期清除');
  }

  /* ---------- 提醒 ---------- */

  var remindNodeId = null;
  var remindDraft = null;
  var remindGrid = null;
  var remindYearBase = 0;
  var remindFocusMinute = false;
  var remindPos = { x: 0, y: 0 };

  function closeRemindPop() {
    $('remindPop').hidden = true;
    remindNodeId = null;
    remindDraft = null;
    remindGrid = null;
    remindFocusMinute = false;
  }

  function pad2(v) { return String(v).length < 2 ? '0' + v : String(v); }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  function clampDraftDay() {
    var max = daysInMonth(remindDraft.y, remindDraft.m);
    if (remindDraft.d > max) remindDraft.d = max;
    if (remindDraft.d < 1) remindDraft.d = 1;
  }

  function draftTs() {
    var d = remindDraft;
    return new Date(d.y, d.m, d.d, d.h, d.mi, 0, 0).getTime();
  }

  function openRemindPop(id, x, y) {
    var n = findNode(id);
    if (!n) return;
    remindNodeId = id;
    var base = new Date(n.remindAt || Date.now() + 3600000);
    remindDraft = {
      y: base.getFullYear(),
      m: base.getMonth(),
      d: base.getDate(),
      h: base.getHours(),
      mi: base.getMinutes()
    };
    remindGrid = null;
    remindYearBase = Math.floor(remindDraft.y / 12) * 12;
    remindPos = { x: x, y: y };
    renderRemindPop();
  }

  function renderRemindPop() {
    var el = $('remindPop');
    var n = remindNodeId ? findNode(remindNodeId) : null;
    if (!n || !remindDraft) { closeRemindPop(); return; }
    var d = remindDraft;
    el.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'rp-head';
    head.textContent = '给「' + displayName(n) + '」设提醒';
    el.appendChild(head);

    /* 时间戳：年/月/日/时点一下出对应网格，分钟直接输入数字。 */
    var stamp = document.createElement('div');
    stamp.className = 'rp-stamp';
    function seg(text, unit, key) {
      var b = document.createElement('button');
      b.className = 'rp-seg' + (remindGrid === key ? ' on' : '');
      b.textContent = text;
      b.addEventListener('click', function () {
        remindGrid = remindGrid === key ? null : key;
        if (key === 'year') remindYearBase = Math.floor(d.y / 12) * 12;
        renderRemindPop();
      });
      stamp.appendChild(b);
      var u = document.createElement('span');
      u.className = 'rp-unit';
      u.textContent = unit;
      stamp.appendChild(u);
    }
    seg(String(d.y), '年', 'year');
    seg(pad2(d.m + 1), '月', 'month');
    seg(pad2(d.d), '日', 'day');
    seg(pad2(d.h), '时', 'hour');

    var mi = document.createElement('input');
    mi.className = 'rp-mi';
    mi.type = 'text';
    mi.inputMode = 'numeric';
    mi.maxLength = 2;
    mi.value = pad2(d.mi);
    mi.placeholder = '分';
    mi.title = '分钟直接输入数字';
    mi.addEventListener('input', function () {
      mi.value = mi.value.replace(/\D/g, '').slice(0, 2);
      if (mi.value !== '') remindDraft.mi = Math.min(59, parseInt(mi.value, 10));
    });
    mi.addEventListener('blur', function () {
      remindDraft.mi = Math.min(59, parseInt(mi.value || '0', 10) || 0);
      mi.value = pad2(remindDraft.mi);
    });
    mi.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') trySaveReminder();
    });
    stamp.appendChild(mi);
    var u2 = document.createElement('span');
    u2.className = 'rp-unit';
    u2.textContent = '分';
    stamp.appendChild(u2);
    el.appendChild(stamp);

    if (remindGrid) el.appendChild(buildRemindGrid(remindGrid));

    var acts = document.createElement('div');
    acts.className = 'rp-acts';
    var ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '保存';
    ok.addEventListener('click', trySaveReminder);
    acts.appendChild(ok);
    var grow = document.createElement('span');
    grow.className = 'grow';
    acts.appendChild(grow);
    if (n.remindAt) {
      var clr = document.createElement('button');
      clr.className = 'btn';
      clr.textContent = '清除';
      clr.addEventListener('click', function () { saveReminder(remindNodeId, 0); });
      acts.appendChild(clr);
    }
    el.appendChild(acts);

    var tip = document.createElement('div');
    tip.className = 'rp-now';
    tip.textContent = '点年/月/日/时出网格选择，分钟直接输数字';
    el.appendChild(tip);

    el.hidden = false;
    var w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(remindPos.x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(4, Math.min(remindPos.y, window.innerHeight - h - 8)) + 'px';

    if (remindFocusMinute) {
      remindFocusMinute = false;
      mi.focus();
      mi.select();
    }
  }

  function buildRemindGrid(kind) {
    var d = remindDraft;
    var box = document.createElement('div');
    box.className = 'rp-gridbox';

    function cell(label, on, fn) {
      var b = document.createElement('button');
      b.className = 'rp-cell' + (on ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }

    var grid = document.createElement('div');
    grid.className = 'rp-grid ' + kind;

    if (kind === 'year') {
      var nav = document.createElement('div');
      nav.className = 'rp-gnav';
      var prev = document.createElement('button');
      prev.className = 'btn';
      prev.textContent = '◀';
      prev.addEventListener('click', function () { remindYearBase -= 12; renderRemindPop(); });
      nav.appendChild(prev);
      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = remindYearBase + ' – ' + (remindYearBase + 11);
      nav.appendChild(lbl);
      var next = document.createElement('button');
      next.className = 'btn';
      next.textContent = '▶';
      next.addEventListener('click', function () { remindYearBase += 12; renderRemindPop(); });
      nav.appendChild(next);
      box.appendChild(nav);
      for (var y = remindYearBase; y < remindYearBase + 12; y++) {
        (function (yy) {
          grid.appendChild(cell(String(yy), yy === d.y, function () {
            remindDraft.y = yy;
            clampDraftDay();
            remindGrid = 'month';
            renderRemindPop();
          }));
        })(y);
      }
    } else if (kind === 'month') {
      for (var m = 0; m < 12; m++) {
        (function (mm) {
          grid.appendChild(cell(String(mm + 1), mm === d.m, function () {
            remindDraft.m = mm;
            clampDraftDay();
            remindGrid = 'day';
            renderRemindPop();
          }));
        })(m);
      }
    } else if (kind === 'day') {
      var total = daysInMonth(d.y, d.m);
      for (var day = 1; day <= total; day++) {
        (function (dd) {
          grid.appendChild(cell(String(dd), dd === d.d, function () {
            remindDraft.d = dd;
            remindGrid = 'hour';
            renderRemindPop();
          }));
        })(day);
      }
    } else if (kind === 'hour') {
      for (var h = 0; h < 24; h++) {
        (function (hh) {
          grid.appendChild(cell(pad2(hh), hh === d.h, function () {
            remindDraft.h = hh;
            remindGrid = null;
            remindFocusMinute = true;
            renderRemindPop();
          }));
        })(h);
      }
    }

    box.appendChild(grid);
    return box;
  }

  function trySaveReminder() {
    var ts = draftTs();
    if (ts <= Date.now()) {
      toast('这个时间已经过去了，换一个');
      return;
    }
    saveReminder(remindNodeId, ts);
  }

  function saveReminder(id, ts) {
    var n = findNode(id);
    if (!n) return;
    if (ts) {
      n.remindAt = ts;
      n.remindDone = false;
    } else {
      delete n.remindAt;
      delete n.remindDone;
    }
    saveIndexSoon();
    closeRemindPop();
    renderTree();
    if (id === selectedId) renderDetail();
    toast(ts ? '提醒已设为 ' + fmtDate(ts) : '已取消提醒');
  }

  var remindTimer = null;
  var reminding = false;

  /** 到点的提醒：标成已提醒、拉回窗口、弹一条提示。同一条只响一次。 */
  function checkReminders() {
    if (reminding) return;
    var due = [];
    walk(index.roots, function (n) {
      if (n.remindAt && !n.remindDone && n.remindAt <= Date.now()) due.push(n);
    });
    if (!due.length) return;
    reminding = true;
    for (var i = 0; i < due.length; i++) due[i].remindDone = true;
    saveIndexSoon();
    renderTree();
    updateRemindBtn();
    var names = [];
    for (var j = 0; j < due.length; j++) names.push(displayName(due[j]));
    /* 每条单独发一条系统通知，落在 Windows 右下角通知中心。 */
    for (var k = 0; k < due.length; k++) {
      invoke('notify', {
        title: '提醒：' + displayName(due[k]),
        body: '到点了，别忘了这条。'
      }).catch(function () {});
    }
    toast(names.length === 1 ? '提醒：' + names[0] : '有 ' + names.length + ' 条提醒到点了');
    setTimeout(function () { reminding = false; }, 1500);
  }

  function startReminderLoop() {
    checkReminders();
    if (remindTimer) clearInterval(remindTimer);
    remindTimer = setInterval(checkReminders, 15000);
  }

  /** 到点后只改按钮文字，不重建编辑区，免得打断正在输入的光标。 */
  function updateRemindBtn() {
    var b = $('remindBtn');
    var n = selectedId ? findNode(selectedId) : null;
    if (!b || !n) return;
    if (n.remindAt) {
      b.textContent = '⏰ ' + fmtRemind(n.remindAt) + (n.remindDone ? '（已提醒）' : '');
      b.title = '提醒时间：' + fmtDate(n.remindAt) + '（点击修改）';
    } else {
      b.textContent = '⏰ 设置提醒';
      b.title = '给这条设一个提醒时间';
    }
  }

  /** 置顶只改排序，不重建编辑区，避免打断输入。 */
  function togglePin(id) {
    var n = findNode(id);
    if (!n) return;
    n.pinned = !n.pinned;
    if (n.pinned) {
      var list = siblingList(id);
      var i = list.indexOf(n);
      if (i > 0) { list.splice(i, 1); list.unshift(n); }
    }
    saveIndexSoon();
    renderTree();
    updatePinBtn();
    toast(n.pinned ? '已置顶，排在同级最前' : '已取消置顶');
  }

  function updatePinBtn() {
    var b = $('pinBtn');
    var n = selectedId ? findNode(selectedId) : null;
    if (!b || !n) return;
    b.textContent = n.pinned ? '📌 取消置顶' : '📌 置顶';
    b.title = n.pinned ? '点击取消置顶' : '把这条排到同级最前面';
  }

  /* ---------- 右键菜单 ---------- */

  function openCtx(x, y, n) {
    var el = $('ctx');
    el.innerHTML = '';
    function mk(label, cls, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', function () { closeCtx(); fn(); });
      return b;
    }
    el.appendChild(mk('新建子条目', '', function () { newEntry(n.id); }));
    el.appendChild(mk('重命名', '', function () {
      selectNode(n.id);
      var ti = document.querySelector('.title-input');
      if (ti) { ti.focus(); ti.select(); }
    }));
    el.appendChild(mk(n.done ? '取消完成' : '标记完成', '', function () {
      n.done = !n.done;
      if (n.done && n.pinned) n.pinned = false;
      saveIndexSoon();
      renderTree();
      if (n.id === selectedId) renderDetail();
    }));
    el.appendChild(mk('设置提醒…', '', function () { openRemindPop(n.id, x, y); }));
    el.appendChild(mk(n.pinned ? '取消置顶' : '置顶', '', function () { togglePin(n.id); }));
    el.appendChild(mk('删除', 'danger', function () { deleteNode(n.id); }));
    el.hidden = false;
    var w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }
  function closeCtx() { $('ctx').hidden = true; }

  /** 图片上的右键菜单：只留「打开原图」和「打开本地文件夹」。 */
  function openMediaCtx(x, y, rel) {
    var el = $('ctx');
    el.innerHTML = '';
    function mk(label, cls, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', function () { closeCtx(); fn(); });
      return b;
    }
    el.appendChild(mk('打开原图（用默认程序）', '', function () { openOriginal(rel); }));
    el.appendChild(mk('打开本地文件夹', '', function () { revealFile(rel); }));
    el.hidden = false;
    var w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }

  /* ---------- 设置与皮肤 ---------- */

  function markSkinButtons() {
    var btns = document.querySelectorAll('.skin');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-on', btns[i].dataset.skin === settings.skin);
    }
  }

  function applySkin() {
    document.documentElement.dataset.skin = settings.skin || 'green';
    markSkinButtons();
  }

  function applyDisplayName() {
    var name = (settings.displayName || '').trim() || '备忘录';
    $('appName').textContent = name;
    try { appWindow.setTitle(name); } catch (_) {}
  }

  function updateAutostartUI() {
    var on = !!settings.autostart;
    $('swStart').classList.toggle('is-on', on);
    $('swStart').setAttribute('aria-checked', on ? 'true' : 'false');
    $('autostartText').textContent = on ? '已开启，开机静默到托盘' : '关闭，不影响开机速度';
  }

  function closeAction() {
    return settings.closeAction === 'tray' ? 'tray' : 'exit';
  }

  function applyCloseUI() {
    var tray = closeAction() === 'tray';
    $('closeAction').value = tray ? 'tray' : 'exit';
    $('btnClose').title = tray ? '最小化到托盘（程序继续在后台运行）' : '彻底关闭程序';
  }

  function applySettings() {
    applySkin();
    applyDisplayName();
    $('kbdHint').textContent = settings.shortcut || 'Ctrl+Alt+Space';
    $('nameInput').value = settings.displayName || '';
    $('scInput').value = settings.shortcut || '';
    $('retention').value = String(settings.retentionDays == null ? 30 : settings.retentionDays);
    $('dataDirText').textContent = dataDir;
    $('dataDirText').title = dataDir;
    updateAutostartUI();
    applyCloseUI();
    $('newItemPos').value = settings.newItemPos === 'bottom' ? 'bottom' : 'top';
  }

  async function changeDataDir() {
    var picked = await invoke('pick_folder');
    if (!picked) return;
    if (normPath(picked) === normPath(dataDir)) { toast('已经是这个目录了'); return; }

    await flushContent();
    await saveIndexNow();
    await saveSettingsNow();

    var res;
    try {
      res = await invoke('migrate_data_dir', { path: picked });
    } catch (e) {
      toast('切换失败：' + (e && e.message ? e.message : e));
      return;
    }
    if (!res || !res.changed) { toast('已经是这个目录了'); return; }

    dataDir = picked;
    settings.dataDir = dataDir;
    await saveSettingsNow();
    await reloadFromDisk();
    applySettings();
    toast(res.targetEmpty ? '已把 ' + res.moved + ' 项数据搬到新目录' : '新目录里已有数据，已切换（旧数据留在原处）');
  }

  async function reloadFromDisk() {
    contentCache = Object.create(null);
    contentLoaded = Object.create(null);
    selectedId = null;
    var raw = await readText('索引.json');
    index = { version: 1, roots: [] };
    if (raw && raw.trim()) { try { index = JSON.parse(raw); } catch (_) {} }
    if (!index.roots) index.roots = [];
    var traw = await readText(joinPath('回收站', '回收站.json'));
    trash = { version: 1, items: [] };
    if (traw && traw.trim()) { try { trash = JSON.parse(traw); } catch (_) {} }
    if (!trash.items) trash.items = [];
    normalizeIndex();
    await preloadContents();
    resort(index.roots);
    await saveIndexNow();
    renderTree();
    renderDetail();
    if (!$('trash').hidden) renderTrash();
  }

  function normalizeIndex() {
    walk(index.roots, function (n) {
      if (!n.children) n.children = [];
      if (typeof n.collapsed !== 'boolean') n.collapsed = false;
      n.done = !!n.done;
      n.pinned = !!n.pinned;
      if (n.done) n.pinned = false;
      if (!n.title) n.title = '';
    });
  }

  async function preloadContents() {
    var ids = [];
    walk(index.roots, function (n) { ids.push(n.id); });
    await Promise.all(ids.map(async function (id) {
      try {
        contentCache[id] = await invoke('read_text', { path: contentPath(id) });
        contentLoaded[id] = true;
      } catch (e) {
        contentCache[id] = contentCache[id] || '';
        contentLoaded[id] = false;
      }
    }));
  }

  /** 启动后清一次历史残留：正文读成功却没被引用的媒体文件直接删掉。 */
  async function sweepAllOnBoot() {
    var ids = [];
    walk(index.roots, function (n) { ids.push(n.id); });
    for (var i = 0; i < ids.length; i++) {
      if (contentLoaded[ids[i]]) await sweepMedia(ids[i]);
    }
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    $('btnMin').addEventListener('click', function () { invoke('win_minimize'); });
    $('btnMax').addEventListener('click', function () { invoke('win_toggle_max'); });
    $('btnClose').addEventListener('click', async function () {
      await flushContent();
      await saveIndexNow();
      await saveSettingsNow();
      await flushSweep();
      if (closeAction() === 'tray') invoke('win_hide');
      else invoke('win_exit');
    });

    /* 设置/回收站按钮：点一下打开，再点一下收起；两个面板互斥。 */
    function toggleOverlay(id) {
      var ov = $(id);
      var willShow = ov.hidden;
      $('settings').hidden = true;
      $('trash').hidden = true;
      if (willShow) {
        if (id === 'trash') renderTrash();
        ov.hidden = false;
      }
    }
    $('btnSettings').addEventListener('click', function () { toggleOverlay('settings'); });
    $('btnTrashTop').addEventListener('click', function () { toggleOverlay('trash'); });
    $('setClose').addEventListener('click', function () { $('settings').hidden = true; });
    $('trashClose').addEventListener('click', function () { $('trash').hidden = true; });
    /* 设置面板里的「打开回收站」：打开回收站的同时把设置收起来。 */
    $('btnTrash').addEventListener('click', function () { renderTrash(); $('settings').hidden = true; $('trash').hidden = false; });

    $('search').addEventListener('input', function () {
      searchQuery = $('search').value;
      renderTree();
    });

    $('btnNew').addEventListener('click', function () { newEntry(selectedId); });

    $('skinList').addEventListener('click', function (e) {
      var b = e.target.closest('.skin');
      if (!b) return;
      settings.skin = b.dataset.skin;
      applySkin();
      saveSettingsSoon();
    });

    $('nameInput').addEventListener('input', function () {
      settings.displayName = $('nameInput').value;
      applyDisplayName();
      saveSettingsSoon();
    });

    $('btnPickDir').addEventListener('click', changeDataDir);
    $('btnOpenDir').addEventListener('click', function () { invoke('reveal', { path: '' }); });

    $('btnScSave').addEventListener('click', async function () {
      var accel = $('scInput').value.trim() || 'Ctrl+Alt+Space';
      try {
        await invoke('register_shortcut', { accel: accel });
        settings.shortcut = accel;
        $('kbdHint').textContent = accel;
        saveSettingsSoon();
        toast('快捷键已改为 ' + accel);
      } catch (e) {
        toast('这个快捷键不可用，换一个试试');
      }
    });

    $('retention').addEventListener('change', function () {
      settings.retentionDays = Number($('retention').value);
      saveSettingsSoon();
      renderDetail();
      toast(settings.retentionDays ? '回收站保留 ' + settings.retentionDays + ' 天' : '回收站永久保留');
    });

    $('swStart').addEventListener('click', async function () {
      var next = !settings.autostart;
      try {
        await invoke('set_autostart', { on: next });
        settings.autostart = next;
        updateAutostartUI();
        saveSettingsSoon();
        toast(next ? '已开启开机自启动' : '已关闭开机自启动');
      } catch (e) {
        toast('设置失败，可能被系统策略拦截');
      }
    });

    $('closeAction').addEventListener('change', function () {
      settings.closeAction = $('closeAction').value === 'tray' ? 'tray' : 'exit';
      applyCloseUI();
      saveSettingsSoon();
      toast(closeAction() === 'tray' ? '关闭按钮改为最小化到托盘' : '关闭按钮改为彻底关闭程序');
    });

    $('newItemPos').addEventListener('change', function () {
      settings.newItemPos = $('newItemPos').value === 'bottom' ? 'bottom' : 'top';
      saveSettingsSoon();
      toast(settings.newItemPos === 'bottom' ? '新建待办默认排在同级最后' : '新建待办默认排在同级最前');
    });

    $('btnResetGeom').addEventListener('click', async function () {
      try {
        await invoke('reset_window_geometry');
        toast('窗口已恢复默认大小并居中');
      } catch (e) {
        toast('恢复失败');
      }
    });

    document.addEventListener('click', function (e) {
      /* 点网格会重建弹层，旧节点已脱离文档，这种不算「点外面」。 */
      if (!e.target.isConnected) return;
      if (!e.target.closest('#ctx')) closeCtx();
      /* 点别处收起提醒弹层；从右键菜单里点「设置提醒」的那一下要放过。 */
      if (!e.target.closest('#remindPop') && !e.target.closest('#ctx') && !e.target.closest('#remindBtn')) {
        closeRemindPop();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeCtx();
        if (!$('remindPop').hidden) { closeRemindPop(); return; }
        if (!$('trash').hidden) { $('trash').hidden = true; return; }
        if (!$('settings').hidden) { $('settings').hidden = true; return; }
        if (selectedId) selectNode(null);
      }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        newEntry(selectedId);
      }
      if (e.key === 'F2' && selectedId) {
        e.preventDefault();
        var ti = document.querySelector('.title-input');
        if (ti) { ti.focus(); ti.select(); }
      }
    });

    window.addEventListener('blur', function () { flushContent(); flushSweep(); });
    window.addEventListener('beforeunload', function () { flushContent(); saveIndexNow(); saveSettingsNow(); flushSweep(); });
  }

  /* ---------- 启动 ---------- */

  async function boot() {
    dataDir = await invoke('get_data_dir');
    try {
      var sraw = await invoke('read_settings');
      if (sraw && sraw.trim()) settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(sraw));
    } catch (e) { console.error(e); }

    /* 数据目录由后端按「不落 C 盘」的规则解析好，前端直接采用。 */
    settings.dataDir = dataDir;

    var raw = await readText('索引.json');
    if (raw && raw.trim()) { try { index = JSON.parse(raw); } catch (_) {} }
    if (!index.roots) index.roots = [];

    var traw = await readText(joinPath('回收站', '回收站.json'));
    if (traw && traw.trim()) { try { trash = JSON.parse(traw); } catch (_) {} }
    if (!trash.items) trash.items = [];

    normalizeIndex();
    await preloadContents();

    /* 下次打开：完成且整棵子树完成的沉到同级末尾 */
    resort(index.roots);
    await saveIndexNow();

    /* 关闭前选中/聚焦的那条，重新打开时仍然默认选中它。 */
    var lastId = settings.lastSelectedId || '';
    if (lastId && findNode(lastId)) {
      var anc = findParent(lastId);
      while (anc) { anc.collapsed = false; anc = findParent(anc.id); }
      selectedId = lastId;
    }

    renderTree();
    renderDetail();
    applySettings();
    bindEvents();

    var selRow = document.querySelector('.row.sel');
    if (selRow && selRow.scrollIntoView) selRow.scrollIntoView({ block: 'nearest' });

    try { await invoke('register_shortcut', { accel: settings.shortcut || 'Ctrl+Alt+Space' }); } catch (_) {}
    try { await invoke('apply_window_geometry'); } catch (_) {}

    await sweepTrash();
    await sweepAllOnBoot();
    startReminderLoop();
  }

  boot().catch(function (e) {
    console.error(e);
    toast('启动出错：' + (e && e.message ? e.message : e));
  });
})();
