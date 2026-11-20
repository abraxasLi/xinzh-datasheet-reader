"use client";

import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import PdfReader, { type PdfReaderHandle, type TranslationTarget } from "./PdfReader";
import TablePanel from "./TablePanel";
import { translateDatasheetText } from "@/lib/offline-translation";
import { parseBitfields, parseRegisterHeader, type BitfieldRow } from "@/lib/datasheet/bitfields";
import type { ParsedTable } from "@/lib/datasheet/tables";

type Evidence = { quote_en: string; translation_zh: string; page: number; section: string; highlight_term?: string };
type SearchAnswer = {
  answer_zh: string;
  resolved_term: string;
  confidence: number;
  evidence: Evidence[];
  insufficient: boolean;
  glossary?: { term: string; english: string; chinese: string }[];
};

type ModelInfo = {
  installed: boolean;
  manifest?: {
    name: string;
    version: string;
    source: string;
    license: string;
    licenseNote: string;
    packageSize: number;
    packageSha256: string;
    installedAt: string;
    engine: string;
  } | null;
  modelDir?: string | null;
  sizeBytes?: number;
  runtime: { python: string | null; ready: boolean; detail: string };
  engine: { running: boolean; port: number | null; loadMs: number | null; cachedParagraphs: number };
  online?: { configured: boolean; provider: string; host: string; model: string };
  deepl?: { configured: boolean; provider: string; host: string; mode: string };
  officialSource: string;
  expectedPackageBytes: number;
};

type TranslationItem = { source: string; translation: string; ms: number; protectedCount: number; unresolved: string[]; skipped?: boolean; skipLabel?: string; protectionSkipped?: boolean; degraded?: boolean; qualityFailed?: boolean; qualityReason?: string };
type TranslationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; items: TranslationItem[]; totalMs: number; engine?: string }
  | { status: "missing" }
  | { status: "error"; error: string };

const examples = [
  "时钟中断寄存器的作用是什么？",
  "GPIO 复用功能在哪里？",
  "这个寄存器的地址和每个位是什么意思？",
];

function formatBytes(bytes = 0) {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const pdfReaderRef = useRef<PdfReaderHandle>(null);
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);
  const translationHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translationRequest = useRef(0);
  const documentRevision = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentInfo, setDocumentInfo] = useState<{ pageCount: number; kind: string } | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchAnswer, setSearchAnswer] = useState<SearchAnswer | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [followTranslationEnabled, setFollowTranslationEnabled] = useState(false);
  const [translationPreviewOpen, setTranslationPreviewOpen] = useState(false);
  const [translationTarget, setTranslationTarget] = useState<TranslationTarget | null>(null);
  const [translationScope, setTranslationScope] = useState<"paragraph" | "context" | "page">("paragraph");
  const [translationProvider, setTranslationProvider] = useState<"offline" | "online" | "deepl">("offline");
  const [translationView, setTranslationView] = useState<"translation" | "bilingual" | "source">("translation");
  const [translationPinned, setTranslationPinned] = useState(false);
  const [translationState, setTranslationState] = useState<TranslationState>({ status: "idle" });
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelNotice, setModelNotice] = useState("");
  const [error, setError] = useState("");
  const [draggingFile, setDraggingFile] = useState(false);
  const [readerHeight, setReaderHeight] = useState<number | null>(null);
  const [focusReading, setFocusReading] = useState(false);
  const [bitfieldOpen, setBitfieldOpen] = useState(false);
  const [bitfieldBusy, setBitfieldBusy] = useState(false);
  const [bitfieldView, setBitfieldView] = useState<"zh" | "en">("zh");
  const [bitfield, setBitfield] = useState<{
    page: number;
    register: string | null;
    offset: string | null;
    reset: string | null;
    rows: BitfieldRow[];
    translations: Record<string, string>;
  } | null>(null);
  const pageParagraphsRef = useRef(new Map<number, string[]>());
  const pageTablesRef = useRef(new Map<number, ParsedTable[]>());
  const [tablesOpen, setTablesOpen] = useState(false);
  const [tablesForPage, setTablesForPage] = useState<ParsedTable[]>([]);
  const [selectedText, setSelectedText] = useState("");
  const [selectionResult, setSelectionResult] = useState<{ text: string; engine?: string; ms?: number; error?: string; busy?: boolean } | null>(null);

  async function translateSelection(text = selectedText) {
    if (!text.trim()) return;
    setSelectionResult({ text: "", busy: true });
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: [text], provider: translationProvider }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "翻译失败。");
      const item = (result.items as TranslationItem[] | undefined)?.[0];
      setSelectionResult({
        text: item?.translation || "",
        engine: result.engine,
        ms: item?.ms,
        error: item?.qualityFailed ? `模型输出不稳定（${item.qualityReason}），已拦截；建议切「在线（智谱）」再试。` : undefined,
      });
    } catch (cause) {
      setSelectionResult({ text: "", error: cause instanceof Error ? cause.message : "翻译失败。" });
    }
  }

  const collectPageParagraphs = useCallback((page: number, paragraphs: string[]) => {
    pageParagraphsRef.current.set(page, paragraphs);
  }, []);

  const collectPageTables = useCallback((page: number, tables: ParsedTable[]) => {
    pageTablesRef.current.set(page, tables);
  }, []);

  function openTables() {
    setTablesForPage(pageTablesRef.current.get(activePage) || []);
    setTablesOpen(true);
  }

  const dictionaryFallback = useMemo(
    () => translationTarget && translationScope === "paragraph" ? translateDatasheetText(translationTarget.paragraph) : null,
    [translationTarget, translationScope],
  );

  const refreshModel = useCallback(async () => {
    try {
      const response = await fetch("/api/model", { cache: "no-store" });
      if (response.ok) setModelInfo((await response.json()) as ModelInfo);
    } catch {
      /* 模型状态读取失败不阻塞阅读 */
    }
  }, []);

  useEffect(() => { void refreshModel(); }, [refreshModel]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  async function uploadPdf(nextFile: File) {
    setError("");
    if (nextFile.type !== "application/pdf" && !nextFile.name.toLowerCase().endsWith(".pdf")) {
      setError("请选择 PDF 文件。");
      return;
    }
    const revision = ++documentRevision.current;
    clearTranslationSelection();
    setSearching(false);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(URL.createObjectURL(nextFile));
    setActivePage(1);
    setFile(nextFile);
    setDocumentId(null);
    setDocumentInfo(null);
    setSearchAnswer(null);
    setSearchOpen(false);
    setUploading(true);

    const data = new FormData();
    data.append("file", nextFile);
    try {
      const response = await fetch("/api/documents", { method: "POST", body: data });
      const result = await response.json();
      if (revision !== documentRevision.current) return;
      if (!response.ok) throw new Error(result.error || "无法读取这份 PDF");
      setDocumentId(result.documentId);
      setDocumentInfo({ pageCount: result.pageCount, kind: result.kind });
      searchRef.current?.focus();
    } catch (cause) {
      if (revision !== documentRevision.current) return;
      setError(cause instanceof Error ? cause.message : "读取失败。PDF 仍可在左侧打开阅读。");
    } finally {
      if (revision === documentRevision.current) setUploading(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (selected) void uploadPdf(selected);
  }

  function onFileDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingFile(false);
    const droppedFile = event.dataTransfer.files[0];
    if (droppedFile) void uploadPdf(droppedFile);
  }

  function startReaderResize(event: PointerEvent<HTMLDivElement>) {
    if (!workspaceRef.current) return;
    event.preventDefault();
    resizeStartRef.current = { y: event.clientY, height: workspaceRef.current.getBoundingClientRect().height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeReader(event: PointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    const workspace = workspaceRef.current;
    if (!start || !workspace) return;
    const maximum = Math.max(420, Math.floor(window.innerHeight - workspace.getBoundingClientRect().top - 78));
    setReaderHeight(Math.max(420, Math.min(maximum, start.height + event.clientY - start.y)));
  }

  function stopReaderResize() {
    resizeStartRef.current = null;
  }

  function resizeReaderByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const currentHeight = readerHeight ?? workspaceRef.current?.getBoundingClientRect().height ?? 500;
    const delta = event.key === "ArrowUp" ? -40 : 40;
    const top = workspaceRef.current?.getBoundingClientRect().top ?? 0;
    const maximum = Math.max(420, Math.floor(window.innerHeight - top - 78));
    setReaderHeight(Math.max(420, Math.min(maximum, currentHeight + delta)));
  }

  async function runSearch(value: string) {
    if (!value.trim() || !documentId || searching) return;
    const revision = documentRevision.current;
    setError("");
    setSearching(true);
    setSearchAnswer(null);
    setSearchOpen(true);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, question: value.trim() }),
      });
      const result = await response.json();
      if (revision !== documentRevision.current) return;
      if (!response.ok) throw new Error(result.error || "搜索失败，请重试。");
      setSearchAnswer(result.answer as SearchAnswer);
    } catch (cause) {
      if (revision !== documentRevision.current) return;
      setError(cause instanceof Error ? cause.message : "搜索失败，请重试。");
      setSearchAnswer(null);
    } finally {
      if (revision === documentRevision.current) setSearching(false);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(query);
  }

  function handleResultKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (!searchOpen || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false);
      searchRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(resultsRef.current?.querySelectorAll<HTMLButtonElement>(".jump-button") ?? []);
    if (!buttons.length) return;
    const current = buttons.findIndex((button) => button === event.target);
    if (current < 0 && event.target !== searchRef.current) return;
    event.preventDefault();
    const index = event.key === "ArrowDown" ? (current + 1) % buttons.length : current <= 0 ? buttons.length - 1 : current - 1;
    buttons[index].focus();
  }

  function goToPage(page: number) {
    const bounded = Math.max(1, Math.min(page, documentInfo?.pageCount || 1));
    setActivePage(bounded);
    pdfReaderRef.current?.goToPage(bounded);
    setSearchOpen(false);
  }

  function goToEvidence(evidence: Evidence) {
    const bounded = Math.max(1, Math.min(evidence.page, documentInfo?.pageCount || 1));
    setActivePage(bounded);
    pdfReaderRef.current?.goToPage(bounded, evidence.highlight_term);
    setSearchOpen(false);
    searchRef.current?.focus({ preventScroll: true });
  }

  async function translateTarget(target: TranslationTarget, scope: typeof translationScope, provider: typeof translationProvider = translationProvider) {
    const requestId = ++translationRequest.current;
    setTranslationState({ status: "loading" });
    const texts = scope === "page"
      ? [target.pageText.slice(0, 2400)]
      : scope === "context"
        ? [target.context]
        : [target.paragraph];
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, provider }),
      });
      const result = await response.json();
      if (requestId !== translationRequest.current) return;
      if (!response.ok) {
        if (result.code === "model_missing") {
          setTranslationState({ status: "missing" });
          void refreshModel();
          return;
        }
        throw new Error(result.error || "翻译失败。");
      }
      setTranslationState({ status: "ready", items: result.items as TranslationItem[], totalMs: result.totalMs, engine: result.engine });
    } catch (cause) {
      if (requestId !== translationRequest.current) return;
      setTranslationState({ status: "error", error: cause instanceof Error ? cause.message : "翻译失败。" });
    }
  }

  function openTranslationTarget(target: TranslationTarget) {
    if (!followTranslationEnabled || translationPinned) return;
    setTranslationTarget(target);
    setTranslationPreviewOpen(true);
    void translateTarget(target, translationScope);
  }

  function focusTranslationTarget(target: TranslationTarget) {
    if (!followTranslationEnabled || translationPinned || window.getSelection()?.type === "Range") return;
    if (translationHoverTimer.current) clearTimeout(translationHoverTimer.current);
    translationHoverTimer.current = setTimeout(() => {
      translationHoverTimer.current = null;
      openTranslationTarget(target);
    }, 260);
  }

  function toggleFollowTranslation() {
    const next = !followTranslationEnabled;
    setFollowTranslationEnabled(next);
    if (next) {
      setTranslationPreviewOpen(true);
      return;
    }
    if (translationHoverTimer.current) clearTimeout(translationHoverTimer.current);
    translationHoverTimer.current = null;
    translationRequest.current++;
    setTranslationTarget(null);
    setTranslationPreviewOpen(false);
    setTranslationPinned(false);
    setTranslationState({ status: "idle" });
  }

  function toggleTranslationPinned() {
    setTranslationPinned((pinned) => !pinned);
  }

  function changeScope(scope: typeof translationScope) {
    setTranslationScope(scope);
    if (translationTarget) void translateTarget(translationTarget, scope);
  }

  function changeProvider(provider: "offline" | "online" | "deepl") {
    setTranslationProvider(provider);
    if (translationTarget) void translateTarget(translationTarget, translationScope, provider);
  }

  async function translateBitfields(rows: BitfieldRow[]) {
    const texts = [...new Set(rows.map((row) => row.description).filter((text) => text && text.length > 1))].slice(0, 24);
    if (!texts.length) return;
    setBitfieldBusy(true);
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, provider: translationProvider }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "翻译失败。");
      const map: Record<string, string> = {};
      (result.items as TranslationItem[]).forEach((item, index) => { map[texts[index]] = item.translation; });
      setBitfield((current) => current ? { ...current, translations: { ...current.translations, ...map } } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "位域说明翻译失败。");
    } finally {
      setBitfieldBusy(false);
    }
  }

  function openBitfields() {
    const paragraphs = pageParagraphsRef.current.get(activePage) || [];
    const pageText = paragraphs.join("\n");
    const rows = parseBitfields(pageText);
    const header = parseRegisterHeader(pageText);
    setBitfield({ page: activePage, register: header.register, offset: header.offset, reset: header.reset, rows, translations: {} });
    setBitfieldOpen(true);
    if (rows.length) void translateBitfields(rows);
  }

  function updatePdfPageCount(pageCount: number) {
    setDocumentInfo((current) => current ? { ...current, pageCount } : current);
  }

  function clearTranslationSelection() {
    if (translationHoverTimer.current) clearTimeout(translationHoverTimer.current);
    translationHoverTimer.current = null;
    translationRequest.current++;
    setFollowTranslationEnabled(false);
    setTranslationTarget(null);
    setTranslationPreviewOpen(false);
    setTranslationPinned(false);
    setTranslationState({ status: "idle" });
  }

  function resetDocument() {
    documentRevision.current++;
    setUploading(false);
    setSearching(false);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(null);
    setFile(null);
    setDocumentId(null);
    setDocumentInfo(null);
    setActivePage(1);
    setQuery("");
    setSearchAnswer(null);
    setSearchOpen(false);
    clearTranslationSelection();
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function installModel(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    setModelBusy(true);
    setModelNotice("正在解包并校验模型…");
    const data = new FormData();
    data.append("file", selected);
    try {
      const response = await fetch("/api/model", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "安装失败。");
      setModelNotice(`已安装 ${result.manifest?.name || "英中模型"}。第一次翻译需要加载模型，约 1 秒。`);
      await refreshModel();
    } catch (cause) {
      setModelNotice(cause instanceof Error ? cause.message : "安装失败。");
    } finally {
      setModelBusy(false);
    }
  }

  async function removeModel() {
    setModelBusy(true);
    try {
      await fetch("/api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove" }) });
      setModelNotice("已移除本机模型。");
      setTranslationState({ status: "idle" });
      await refreshModel();
    } finally {
      setModelBusy(false);
    }
  }

  const modelReady = Boolean(modelInfo?.installed && modelInfo?.runtime?.ready);
  const translationBusy = translationState.status === "loading";

  return (
    <main className={"shell reading-app" + (file ? " has-document" : "") + (focusReading ? " focus-reading" : "")}>
      <header className="topbar reader-topbar">
        <a className="brand" href="#" aria-label="芯知首页">
          <span className="brand-mark">芯</span>
          <span>芯知 <small>英文芯片手册阅读器</small></span>
        </a>
        <div className="top-right">
          <span className={"status-dot " + (modelReady ? "connected" : "demo")} />
          本机运行 · {modelReady ? "离线模型已就绪" : "离线模型未就绪"}
          <button className="model-button" onClick={() => setModelOpen((open) => !open)}>
            {modelInfo?.installed ? "模型管理" : "安装模型"}
          </button>
        </div>
      </header>

      <section className={"reader-intro" + (file ? " compact-reader-intro" : "")}>
        <div>
          <div className="eyebrow">给嵌入式初学者的英文手册工具</div>
          <h1>用中文找手册内容，边读边看懂上下文。</h1>
          <p>中文搜索定位 · 原文跟随式整段翻译</p>
        </div>
        <details className="quick-guide">
          <summary>怎么使用？</summary>
          <div>
            <p><b>找内容：</b>用中文说出你想找的东西，搜索结果会带你回到手册原文并高亮。</p>
            <p><b>看翻译：</b>默认拖动选中文字即可翻译；打开工具栏“跟随译读”后，悬停或点击英文段落才会翻译整段。</p>
            <p><b>翻译从哪来：</b>安装一次免费离线英中模型包（约 70 MB）后，整段翻译全部在本机 CPU 上完成，断网可用。</p>
            <small>没有安装模型时，只显示术语提示，不会假装已经翻译。</small>
          </div>
        </details>
      </section>

      <section className="reader-toolbar" aria-label="手册工具栏">
        <div className="toolbar-document">
          <button className="upload-compact" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {file ? "换一本手册" : "打开手册"}
          </button>
          <input ref={inputRef} hidden type="file" accept="application/pdf,.pdf" onChange={onFileChange} />
          <span className="document-label" title={file?.name || ""}>
            {uploading ? "正在读取手册…" : file ? file.name : "尚未打开 PDF"}
            {documentInfo && <small>{documentInfo.kind} · {documentInfo.pageCount} 页</small>}
            {!uploading && file && !documentId && <small>无法建立文本索引 · PDF 仍可阅读</small>}
          </span>
          {file && <button className="close-document" onClick={resetDocument}>关闭</button>}
        </div>
        <form className="search-bar" onSubmit={submitSearch} onKeyDown={handleResultKeys}>
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={documentId ? "用中文描述要找的寄存器、地址或功能…" : "先打开一本 PDF 手册"}
            aria-label="用中文搜索手册"
            disabled={!documentId}
          />
          <kbd>Ctrl K</kbd>
          <button type="submit" disabled={!documentId || !query.trim() || searching}>{searching ? "查找中…" : "搜索"}</button>
        </form>
        <button
          className={"translation-mode-button" + (followTranslationEnabled ? " enabled" : "")}
          onClick={toggleFollowTranslation}
          aria-pressed={followTranslationEnabled}
          title={followTranslationEnabled ? "关闭后只保留划词翻译" : "打开后允许悬停/点击整段翻译"}
        >
          跟随译读
          <span>{followTranslationEnabled ? "已开启" : "已关闭"}</span>
        </button>
        <button className="bitfield-button" onClick={() => { if (bitfieldOpen) setBitfieldOpen(false); else openBitfields(); }}>
          位域表
        </button>
        <button className="bitfield-button" onClick={() => { if (tablesOpen) setTablesOpen(false); else openTables(); }}>
          表格
        </button>
        <button className="focus-reading-button" onClick={() => setFocusReading((active) => !active)}>
          {focusReading ? "退出专注" : "专注阅读"}
        </button>
      </section>

      {error && <div className="reader-error" role="alert">{error}</div>}

      <section ref={workspaceRef} className="reader-workspace" style={readerHeight ? { height: readerHeight, minHeight: readerHeight } : undefined}>
        <div
          className={"reader-stage" + (draggingFile ? " drag-over" : "")}
          onDragEnter={(event) => { event.preventDefault(); setDraggingFile(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFile(false); }}
          onDrop={onFileDrop}
        >
          {pdfUrl ? (
            <PdfReader
              src={pdfUrl}
              pageNumber={activePage}
              readerRef={pdfReaderRef}
              onPageCount={updatePdfPageCount}
              onPageChange={setActivePage}
              followTranslationEnabled={followTranslationEnabled}
              onTarget={focusTranslationTarget}
              onTargetClick={openTranslationTarget}
              onReaderError={setError}
              onPageParagraphs={collectPageParagraphs}
              onPageTables={collectPageTables}
              onSelectionText={(text) => { setSelectedText(text); setSelectionResult(null); void translateSelection(text); }}
            />
          ) : (
            <button className="reader-welcome" onClick={() => inputRef.current?.click()}>
              <span className="welcome-icon">PDF</span>
              <strong>打开一本英文芯片手册</strong>
              <span>然后用中文搜索你想找的内容</span>
              <small>点击选择或把 PDF 拖到这里 · 文本型 PDF · 最大 30 MB</small>
              <span className="welcome-features">中文搜索定位 <i>·</i> 原文跟随式整段翻译</span>
            </button>
          )}

          {documentInfo && (
            <div className="reader-page-controls" aria-label="PDF 页码控制">
              <button onClick={() => goToPage(activePage - 1)} disabled={activePage <= 1} aria-label="上一页">‹</button>
              <input
                aria-label="当前页码"
                type="number"
                min={1}
                max={documentInfo.pageCount}
                value={activePage}
                onChange={(event) => goToPage(Number(event.target.value) || 1)}
              />
              <span>/ {documentInfo.pageCount}</span>
              <button onClick={() => goToPage(activePage + 1)} disabled={activePage >= documentInfo.pageCount} aria-label="下一页">›</button>
              <button onClick={() => pdfReaderRef.current?.zoomBy(-0.1)} aria-label="缩小 PDF">−</button>
              <button onClick={() => pdfReaderRef.current?.zoomBy(0.1)} aria-label="放大 PDF">+</button>
            </div>
          )}

          {!documentId && !pdfUrl && (
            <div className="first-use-hint">
              常见搜索示例：
              {examples.map((example) => <span key={example}>{example}</span>)}
            </div>
          )}

          {searchOpen && searchAnswer && (
            <aside ref={resultsRef} className="search-results-panel" aria-live="polite" aria-label="中文搜索结果面板" onKeyDown={handleResultKeys}>
              <div className="results-heading">
                <div><small>中文搜索结果 · 仅搜索</small><strong>{query}</strong></div>
                <button onClick={() => setSearchOpen(false)} aria-label="关闭搜索结果">×</button>
              </div>
              <p className="results-summary">{searchAnswer.answer_zh}</p>
              {searchAnswer.resolved_term && <div className="resolved-term"><span>可能对应</span><b>{searchAnswer.resolved_term}</b></div>}
              {!searchAnswer.evidence.length ? (
                <div className="no-results">没有找到明确原文。试试补充外设名、用途或关键词。</div>
              ) : (
                <div className="result-list">
                  {searchAnswer.evidence.map((evidence, index) => (
                    <article className="result-card" key={evidence.page + "-" + index}>
                      <div className="result-meta"><span>相关原文 {index + 1}</span><b>{evidence.section}</b></div>
                      <p>{evidence.translation_zh}</p>
                      <button className="jump-button" onClick={() => goToEvidence(evidence)}>定位并高亮 <span>· 第 {evidence.page} 页 ↗</span></button>
                      <details><summary>查看英文原文</summary><blockquote>{evidence.quote_en}</blockquote></details>
                    </article>
                  ))}
                </div>
              )}
            </aside>
          )}

          {translationPreviewOpen && (
            <aside className="translation-preview-panel" aria-live="polite" aria-label="跟随译读翻译面板">
              <div className="translation-panel-heading">
                <div>
                  <span>跟随译读翻译</span>
                  <small>
                    {translationTarget ? `第 ${translationTarget.page} 页 · ` : ""}
                    {translationProvider === "deepl" ? "在线模型（DeepL）" : translationProvider === "online" ? "在线模型（智谱）" : modelReady ? "本机离线模型" : "未安装离线模型"}
                  </small>
                </div>
                {translationPinned && <b className="pinned-badge">已固定</b>}
                <button onClick={() => setTranslationPreviewOpen(false)} aria-label="关闭译读面板">×</button>
              </div>
              <div className="translation-panel-controls">
                <label>范围
                  <select value={translationScope} onChange={(event) => changeScope(event.target.value as typeof translationScope)}>
                    <option value="paragraph">当前段</option><option value="context">前后文</option><option value="page">当前页</option>
                  </select>
                </label>
                <label>引擎
                  <select value={translationProvider} onChange={(event) => changeProvider(event.target.value as "offline" | "online" | "deepl")}>
                    <option value="offline">本机离线</option>
                    <option value="online">在线（智谱）</option>
                    <option value="deepl">在线（DeepL）</option>
                  </select>
                </label>
                <div role="group" aria-label="译读显示方式">
                  <button className={translationView === "translation" ? "selected" : ""} onClick={() => setTranslationView("translation")}>译文</button>
                  <button className={translationView === "bilingual" ? "selected" : ""} onClick={() => setTranslationView("bilingual")}>中英对照</button>
                  <button className={translationView === "source" ? "selected" : ""} onClick={() => setTranslationView("source")}>原文</button>
                </div>
                {translationTarget && <button className="pin-translation" onClick={toggleTranslationPinned}>{translationPinned ? "取消固定" : "固定段落"}</button>}
              </div>

              {translationProvider !== "offline" && (
                <p className="translation-online-warning">
                  在线模式：当前段落文字会发送到{" "}
                  {translationProvider === "deepl"
                    ? `${modelInfo?.deepl?.provider || "DeepL"}（${modelInfo?.deepl?.host || "api-free.deepl.com"}，${modelInfo?.deepl?.mode || "Free"}）`
                    : `${modelInfo?.online?.provider || "智谱 GLM"}（${modelInfo?.online?.host || "open.bigmodel.cn"}）`}
                  翻译；PDF 文件、文件名和其它内容不会上传。断网时请切回“本机离线”。
                </p>
              )}

              {translationTarget ? (
                <div className="translation-content">
                  {(translationView === "source" || translationView === "bilingual") && (
                    <p className="translation-source">
                      {translationScope === "page" ? translationTarget.pageText : translationScope === "context" ? translationTarget.context : translationTarget.paragraph}
                    </p>
                  )}

                  {translationView !== "source" && (
                    <>
                      {translationBusy && <p className="translation-loading">本机模型翻译中…（首次要加载模型，约 1 秒）</p>}

                      {translationState.status === "ready" && translationState.items.map((item, index) => (
                        <div className="translation-block" key={index}>
                          {item.skipped ? (
                            <p className="translation-skip">{item.skipLabel || "已跳过翻译"}（目录/索引页送进模型会产生乱码，阅读器直接挡掉）</p>
                          ) : item.qualityFailed ? (
                            <div className="translation-pending">
                              离线模型这段输出不稳定（{item.qualityReason}），已拦截，避免给你乱码。可以切「在线（智谱）」重试，或在 PDF 里选中这一小段用「选中片段」翻译。
                            </div>
                          ) : (
                            <>
                              <p className="translation-local-result">{item.translation}</p>
                              <p className="translation-meta">
                                {translationProvider === "offline" ? "本机模型" : translationProvider === "deepl" ? "DeepL" : "智谱"} · {item.ms} ms
                                {item.protectionSkipped
                                  ? " · 未保护直译（这段几乎全是型号/编号，占位会破坏句子）"
                                  : ` · 保护 ${item.protectedCount} 个标识符/数值`}
                                {item.unresolved.length ? ` · ${item.unresolved.length} 个占位符未还原` : ""}
                              </p>
                            </>
                          )}
                        </div>
                      ))}

                      {translationState.status === "ready" && translationScope !== "paragraph" && (
                        <p className="translation-meta">整段/整页译文连在一起显示，原文见上方对照。</p>
                      )}

                      {translationState.status === "missing" && (
                        <div className="translation-pending">
                          <b>还没有安装离线英中模型。</b>
                          <p>现在的译文只能给术语提示，不是整段翻译。点右上角“安装模型”，选择已下载的 <code>.argosmodel</code> 文件即可，之后翻译全部在本机完成。</p>
                          {dictionaryFallback && <p className="translation-terms">术语辅助：{dictionaryFallback.text}</p>}
                        </div>
                      )}

                      {translationState.status === "error" && (
                        <div className="translation-pending">翻译失败：{translationState.error}</div>
                      )}

                      {translationState.status === "idle" && !translationBusy && (
                        <p className="translation-empty">点击英文段落后，这里会显示对应的中文译文。</p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p className="translation-empty">点击英文段落后，这里会显示对应的中文译文。</p>
              )}
              <small className="translation-boundary">
                PDF 与文字只在本机处理 · 翻译不联网 · 寄存器名/地址/数值先做占位保护
              </small>
            </aside>
          )}

          {tablesOpen && (
            <TablePanel
              page={activePage}
              tables={tablesForPage}
              provider={translationProvider}
              onClose={() => setTablesOpen(false)}
            />
          )}

          {selectedText && (
            <aside className="selection-panel" aria-label="选中片段翻译">
              <div className="selection-heading">
                <span>选中片段 · {selectedText.length} 字</span>
                <button onClick={() => { setSelectedText(""); setSelectionResult(null); }} aria-label="关闭选中翻译">×</button>
              </div>
              <p className="selection-source">{selectedText.slice(0, 600)}</p>
              <div className="selection-actions">
                <button onClick={() => void translateSelection()} disabled={selectionResult?.busy}>
                  {selectionResult?.busy ? "翻译中…" : `翻译选中（${translationProvider === "offline" ? "本机" : translationProvider === "deepl" ? "DeepL" : "智谱"}）`}
                </button>
              </div>
              {selectionResult?.text && <p className="selection-result">{selectionResult.text}</p>}
              {selectionResult?.error && <p className="selection-error">{selectionResult.error}</p>}
              {selectionResult?.engine && <small className="selection-meta">{selectionResult.engine} · {selectionResult.ms} ms</small>}
            </aside>
          )}

          {bitfieldOpen && bitfield && (
            <aside className="bitfield-panel" aria-label="位域表">
              <div className="bitfield-heading">
                <div>
                  <span>位域表 · 第 {bitfield.page} 页</span>
                  <small>
                    {bitfield.register || "未识别寄存器"}
                    {bitfield.offset ? ` · 偏移 ${bitfield.offset}` : ""}
                    {bitfield.reset ? ` · 复位 ${bitfield.reset}` : ""}
                  </small>
                </div>
                <button onClick={() => setBitfieldOpen(false)} aria-label="关闭位域表">×</button>
              </div>
              <div className="bitfield-controls">
                <div role="group" aria-label="位域说明显示方式">
                  <button className={bitfieldView === "zh" ? "selected" : ""} onClick={() => setBitfieldView("zh")}>中文说明</button>
                  <button className={bitfieldView === "en" ? "selected" : ""} onClick={() => setBitfieldView("en")}>英文原文</button>
                </div>
                {bitfieldBusy && <small className="bitfield-status">正在翻译说明…</small>}
                <button className="bitfield-retranslate" disabled={bitfieldBusy} onClick={() => void translateBitfields(bitfield.rows)}>重新翻译</button>
              </div>
              {bitfield.rows.length ? (
                <div className="bitfield-table-wrap">
                  <table>
                    <thead>
                      <tr><th>位段</th><th>名称</th><th>属性</th><th>说明</th></tr>
                    </thead>
                    <tbody>
                      {bitfield.rows.map((row) => (
                        <tr key={row.id} className={row.name === "Reserved" ? "reserved" : ""}>
                          <td className="bits">{row.bits}</td>
                          <td className="name">{row.name}</td>
                          <td className="access">{row.access || "—"}</td>
                          <td className="desc">
                            {bitfieldView === "zh" ? (bitfield.translations[row.description] || row.description) : row.description}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="bitfield-empty">这一页没有识别到位域定义行。翻到寄存器定义页再点「位域表」。</p>
              )}
              <small className="bitfield-foot">
                结构由 PDF 文字层解析，不依赖模型；说明译文来自{translationProvider === "online" ? "在线模型" : "本机离线模型"}。
              </small>
            </aside>
          )}

          {modelOpen && (
            <aside className="model-panel" aria-label="离线模型管理">
              <div className="model-panel-heading">
                <div><span>离线翻译模型</span><small>Argos en→zh · 本机 CPU 推理</small></div>
                <button onClick={() => setModelOpen(false)} aria-label="关闭模型面板">×</button>
              </div>
              <div className="model-panel-body">
                {modelInfo ? (
                  <>
                    <p className={"model-state " + (modelReady ? "ok" : "warn")}>
                      {modelReady ? "已就绪：断网也能翻译" : modelInfo.installed ? "模型已安装，但本机运行时不可用" : "未安装：当前只能给术语提示"}
                    </p>
                    <dl className="model-facts">
                      <dt>模型</dt><dd>{modelInfo.manifest?.name || "Argos translate-en_zh"} {modelInfo.manifest?.version ? `· ${modelInfo.manifest.version}` : ""}</dd>
                      <dt>占用</dt><dd>{formatBytes(modelInfo.sizeBytes || modelInfo.manifest?.packageSize)}</dd>
                      <dt>运行时</dt><dd>{modelInfo.runtime.ready ? "CTranslate2 + SentencePiece（本机）" : modelInfo.runtime.detail || "不可用"}</dd>
                      <dt>推理进程</dt><dd>{modelInfo.engine.running ? `运行中 · 加载 ${modelInfo.engine.loadMs ?? "?"} ms · 缓存 ${modelInfo.engine.cachedParagraphs} 段` : "尚未启动（首次翻译时加载）"}</dd>
                      {modelInfo.manifest?.license && <><dt>许可</dt><dd className="model-license">{modelInfo.manifest.licenseNote}<br />{modelInfo.manifest.license.slice(0, 160)}</dd></>}
                    </dl>
                    <div className="model-actions">
                      <label className="model-install">
                        选择 .argosmodel 文件安装
                        <input type="file" accept=".argosmodel" onChange={installModel} disabled={modelBusy} />
                      </label>
                      {modelInfo.installed && <button onClick={() => void removeModel()} disabled={modelBusy}>移除模型</button>}
                    </div>
                    <p className="model-note">
                      模型包需要你自己从官方来源下载一次（约 67.5 MB）：<a href={modelInfo.officialSource} target="_blank" rel="noreferrer">Argos translate-en_zh 1.9</a>。
                      安装后所有翻译都在本机完成，不上传 PDF 或段落。
                    </p>
                    {modelNotice && <p className="model-notice">{modelNotice}</p>}
                  </>
                ) : (
                  <p className="model-note">正在读取本机模型状态…</p>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>

      <div
        className="reader-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-label="拖动调整 PDF 阅读区高度"
        title="上下拖动调整 PDF 阅读区高度"
        onPointerDown={startReaderResize}
        onPointerMove={resizeReader}
        onPointerUp={stopReaderResize}
        onPointerCancel={stopReaderResize}
        onKeyDown={resizeReaderByKeyboard}
      >
        <span />
        <small>{readerHeight ? "PDF 区域高度已调整 · 拖动继续调整" : "上下拖动调整 PDF 阅读区高度"}</small>
        {readerHeight !== null && <button onClick={() => setReaderHeight(null)}>恢复默认</button>}
      </div>

      <footer className="reader-footer">
        <span>{documentId ? "搜索与翻译都在本机完成 · PDF 不上传" : "基础搜索在本机完成"}</span>
        <span>Enter 搜索 · ↑↓ 选结果 · Enter 定位 · Esc 关闭结果</span>
      </footer>
    </main>
  );
}
