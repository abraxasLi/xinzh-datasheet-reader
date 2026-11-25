"use client";

import "pdfjs-dist/web/pdf_viewer.css";
import { RefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import { buildLines, detectContinuation, detectTables, type ParsedTable, type Span } from "@/lib/datasheet/tables";

export type TranslationTarget = {
  id: string;
  page: number;
  paragraph: string;
  context: string;
  pageText: string;
};

export type PdfReaderHandle = {
  goToPage: (page: number, highlightTerm?: string) => void;
  zoomBy: (delta: number) => void;
};

type Props = {
  src: string;
  pageNumber: number;
  readerRef: RefObject<PdfReaderHandle | null>;
  onPageCount: (count: number) => void;
  onPageChange: (page: number) => void;
  followTranslationEnabled: boolean;
  lockedTargetId: string | null;
  onTargetClick: (target: TranslationTarget) => void;
  onReaderError: (message: string) => void;
  onPageParagraphs?: (page: number, paragraphs: string[]) => void;
  onPageTables?: (page: number, tables: ParsedTable[]) => void;
  onSelectionText?: (text: string) => void;
};

/** 把文字层 span 转成坐标（y 取负值，变成"向上为正"的 PDF 习惯）。 */
function collectSpans(container: HTMLDivElement): Span[] {
  return Array.from(container.querySelectorAll<HTMLElement>("span"))
    .filter((span) => span.textContent?.trim())
    .map((span) => {
      const rect = span.getBoundingClientRect();
      return { text: span.textContent || "", x: rect.left, y: -rect.top, width: rect.width, height: rect.height };
    })
    .filter((span) => span.width > 0 && span.height > 0);
}

type PdfRenderedPage = {
  pageNumber: number;
  source?: {
    textLayer?: { div?: HTMLDivElement };
  };
};
type PdfOutlineItem = { title: string; dest: string | unknown[] | null; items?: PdfOutlineItem[] };
type DisplayOutlineItem = { title: string; page: number; depth: number };

function groupTextLayer(container: HTMLDivElement, page: number): TranslationTarget[] {
  const spans = Array.from(container.querySelectorAll<HTMLElement>("span"))
    .filter((span) => span.textContent?.trim() && span.getBoundingClientRect().height > 0)
    .map((span, index) => {
      const rect = span.getBoundingClientRect();
      const fontSize = Number.parseFloat(span.style.fontSize) || rect.height || 12;
      return { span, index, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, fontSize };
    })
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const lines: { top: number; bottom: number; fontSize: number; parts: typeof spans }[] = [];
  for (const item of spans) {
    const line = lines.find((candidate) => Math.abs(candidate.top - item.top) < Math.max(2, Math.min(candidate.fontSize, item.fontSize) * 0.4));
    if (line) {
      line.parts.push(item);
      line.bottom = Math.max(line.bottom, item.bottom);
      line.fontSize = Math.max(line.fontSize, item.fontSize);
    } else {
      lines.push({ top: item.top, bottom: item.bottom, fontSize: item.fontSize, parts: [item] });
    }
  }
  lines.sort((a, b) => a.top - b.top);
  for (const line of lines) line.parts.sort((a, b) => a.left - b.left);

  const paragraphs: { lines: typeof lines; bottom: number; fontSize: number }[] = [];
  for (const line of lines) {
    const previous = paragraphs.at(-1);
    if (previous && line.top - previous.bottom <= Math.max(5, previous.fontSize * 0.9)) {
      previous.lines.push(line);
      previous.bottom = Math.max(previous.bottom, line.bottom);
      previous.fontSize = Math.max(previous.fontSize, line.fontSize);
    } else {
      paragraphs.push({ lines: [line], bottom: line.bottom, fontSize: line.fontSize });
    }
  }

  const result: TranslationTarget[] = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const paragraphSpans = paragraph.lines.flatMap((line) => line.parts);
    const paragraphText = paragraph.lines.map((line) => line.parts.reduce((text, part, partIndex) => {
      const itemText = part.span.textContent ?? "";
      if (partIndex === 0) return itemText;
      const previous = line.parts[partIndex - 1];
      const needsSpace = part.left - previous.right > Math.min(part.fontSize, previous.fontSize) * 0.18;
      const startsPunctuation = /^[,.;:!?%)\]}]/.test(itemText);
      const existingSpace = /\s$/.test(text) || /^\s/.test(itemText);
      return text + (needsSpace && !startsPunctuation && !existingSpace ? " " : "") + itemText;
    }, "")).join("\n").replace(/[\t\u00a0]+/g, " ").replace(/ {2,}/g, " ").trim();
    if (!paragraphText) continue;
    const id = `${page}:${paragraphIndex}`;
    paragraphSpans.forEach((part, index) => {
      part.span.dataset.translationParagraph = id;
      part.span.classList.add("pdf-translation-target");
      part.span.tabIndex = index === 0 ? 0 : -1;
      if (index === 0) part.span.setAttribute("aria-label", `第 ${page} 页段落：${paragraphText.slice(0, 180)}`);
    });
    result.push({ id, page, paragraph: paragraphText, context: "", pageText: "" });
  }

  const pageText = result.map((target) => target.paragraph).join("\n\n");
  return result.map((target, index) => ({
    ...target,
    context: [result[index - 1]?.paragraph, target.paragraph, result[index + 1]?.paragraph].filter(Boolean).join("\n\n"),
    pageText,
  }));
}

export default function PdfReader({ src, pageNumber, readerRef, onPageCount, onPageChange, followTranslationEnabled, lockedTargetId, onTargetClick, onReaderError, onPageParagraphs, onPageTables, onSelectionText }: Props) {
  const [outline, setOutline] = useState<DisplayOutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ currentPageNumber: number; currentScale: number; currentScaleValue: string; setDocument: (document: unknown) => void } | null>(null);
  const targetMapRef = useRef(new Map<string, TranslationTarget>());
  const activeTargetRef = useRef<TranslationTarget | null>(null);
  const pendingSearchRef = useRef<{ page: number; term: string } | null>(null);
  const applySearchHighlightRef = useRef<() => void>(() => {});
  const callbackRef = useRef({ onPageCount, onPageChange, followTranslationEnabled, lockedTargetId, onTargetClick, onReaderError });
  const syncHighlightRef = useRef<() => void>(() => {});
  const onPageParagraphsRef = useRef(onPageParagraphs);
  const onPageTablesRef = useRef(onPageTables);
  const lastTableRef = useRef<{ page: number; table: ParsedTable } | null>(null);
  const onSelectionTextRef = useRef(onSelectionText);

  useEffect(() => { onSelectionTextRef.current = onSelectionText; }, [onSelectionText]);
  const pageNumberRef = useRef(pageNumber);

  useEffect(() => { onPageParagraphsRef.current = onPageParagraphs; }, [onPageParagraphs]);
  useEffect(() => { onPageTablesRef.current = onPageTables; }, [onPageTables]);

  useEffect(() => { pageNumberRef.current = pageNumber; }, [pageNumber]);

  useEffect(() => {
    callbackRef.current = { onPageCount, onPageChange, followTranslationEnabled, lockedTargetId, onTargetClick, onReaderError };
    syncHighlightRef.current();
  }, [onPageCount, onPageChange, followTranslationEnabled, lockedTargetId, onTargetClick, onReaderError]);

  useImperativeHandle(readerRef, () => ({
    goToPage: (page, highlightTerm) => {
      containerRef.current?.querySelectorAll(".pdf-search-highlight").forEach((element) => element.classList.remove("pdf-search-highlight"));
      pendingSearchRef.current = highlightTerm?.trim() ? { page, term: highlightTerm.trim() } : null;
      if (viewerRef.current) viewerRef.current.currentPageNumber = page;
      window.requestAnimationFrame(() => applySearchHighlightRef.current());
    },
    zoomBy: (delta) => { if (viewerRef.current) viewerRef.current.currentScale = Math.max(0.5, Math.min(3, viewerRef.current.currentScale + delta)); },
  }), []);

  useEffect(() => {
    let cancelled = false;
    setOutline([]);
    setOutlineOpen(false);
    lastTableRef.current = null;
    const container = containerRef.current;
    const targetMap = targetMapRef.current;
    let loadingTask: { promise: Promise<unknown>; destroy: () => Promise<void> } | null = null;
    let eventBus: { on: (name: string, listener: (event: never) => void) => void } | null = null;
    let pdfViewer: { currentPageNumber: number; currentScaleValue: string; currentScale: number; setDocument: (document: unknown) => void } | null = null;
    let linkService: { setDocument: (document: unknown) => void; setViewer: (viewer: unknown) => void } | null = null;

    async function load() {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        // pdf_viewer.mjs reads this global while the module is evaluated.
        (globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjs }).pdfjsLib = pdfjs;
        const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
        if (cancelled || !containerRef.current || !viewerElementRef.current) return;
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const bus = new viewerModule.EventBus();
        eventBus = bus as unknown as NonNullable<typeof eventBus>;
        const service = new viewerModule.PDFLinkService({ eventBus: bus });
        linkService = service as unknown as NonNullable<typeof linkService>;
        const viewer = new viewerModule.PDFViewer({
          container: containerRef.current,
          viewer: viewerElementRef.current,
          eventBus: bus,
          linkService: service,
          textLayerMode: 1,
          removePageBorders: true,
        });
        pdfViewer = viewer as unknown as NonNullable<typeof pdfViewer>;
        viewerRef.current = viewer as unknown as NonNullable<typeof viewerRef.current>;
        linkService.setViewer(viewer);

        const onPagesInit = () => {
          if (!pdfViewer) return;
          pdfViewer.currentScaleValue = "page-width";
          pdfViewer.currentPageNumber = pageNumberRef.current;
          callbackRef.current.onPageCount((viewer as unknown as { pagesCount: number }).pagesCount);
        };
        const onPageChanging = (event: { pageNumber: number }) => callbackRef.current.onPageChange(event.pageNumber);
        const onTextLayerRendered = async (event: PdfRenderedPage) => {
          const textLayer = event.source?.textLayer?.div;
          if (!textLayer) return;
          const targets = groupTextLayer(textLayer, event.pageNumber);
          for (const target of targets) targetMap.set(target.id, target);
          onPageParagraphsRef.current?.(event.pageNumber, targets.map((target) => target.paragraph));
          try {
            const lines = buildLines(collectSpans(textLayer));
            const tables = detectTables(lines, event.pageNumber);
            let result = tables;
            const previous = lastTableRef.current;
            // 本页没找到表头，但上一页结尾有表：按上一页的列边界当续表解析
            if (!tables.length && previous && previous.table.columnEdges && event.pageNumber === previous.page + 1) {
              const continuation = detectContinuation(lines, previous.table);
              if (continuation) result = [continuation];
            }
            if (tables.length) lastTableRef.current = { page: event.pageNumber, table: tables[tables.length - 1] };
            onPageTablesRef.current?.(event.pageNumber, result);
          } catch {
            onPageTablesRef.current?.(event.pageNumber, []);
          }
          applySearchHighlightRef.current();
          syncHighlightRef.current();
        };
        eventBus.on("pagesinit", onPagesInit as (event: never) => void);
        eventBus.on("pagechanging", onPageChanging as (event: never) => void);
        eventBus.on("textlayerrendered", onTextLayerRendered as (event: never) => void);

        loadingTask = pdfjs.getDocument({ url: src, useSystemFonts: true });
        const pdfDocument = await loadingTask.promise;
        if (cancelled) return;
        pdfViewer?.setDocument(pdfDocument);
        linkService?.setDocument(pdfDocument);
        const pdfWithOutline = pdfDocument as {
          getOutline: () => Promise<PdfOutlineItem[] | null>;
          getDestination: (name: string) => Promise<unknown[] | null>;
          getPageIndex: (reference: unknown) => Promise<number>;
        };
        try {
          const outlineTree = await pdfWithOutline.getOutline();
          const displayItems: DisplayOutlineItem[] = [];
          const appendOutline = async (nodes: PdfOutlineItem[], depth: number) => {
            for (const node of nodes) {
              let page = 1;
              try {
                const destination = typeof node.dest === "string" ? await pdfWithOutline.getDestination(node.dest) : node.dest;
                if (destination?.[0]) page = (await pdfWithOutline.getPageIndex(destination[0])) + 1;
              } catch { /* Leave a broken outline link at its default page. */ }
              displayItems.push({ title: node.title, page, depth });
              if (node.items?.length) await appendOutline(node.items, depth + 1);
            }
          };
          if (outlineTree?.length) await appendOutline(outlineTree, 0);
          if (!cancelled) setOutline(displayItems);
        } catch { /* The document remains readable if its outline is malformed. */ }
      } catch (error) {
        if (!cancelled) callbackRef.current.onReaderError(error instanceof Error ? `PDF 无法显示：${error.message}` : "PDF 无法显示，请检查文件是否损坏或加密。");
      }
    }
    void load();

    const lookupTarget = (event: Event) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-translation-paragraph]") : null;
      if (!element) return undefined;
      return targetMap.get(element.dataset.translationParagraph || "");
    };
    // dragged：这次按下之后鼠标离开按下位置的最大距离（像素），用来区分“点一下”和“真的拖出一段字”。
    let pointerDown: { x: number; y: number; id: number; dragged: number } | null = null;
    let suppressClick = false;
    let hoveredTarget: TranslationTarget | undefined;
    const clearTargetFrame = () => {
      activeTargetRef.current = null;
      container?.querySelectorAll(".translation-active").forEach((element) => element.classList.remove("translation-active"));
      container?.querySelector(".translation-paragraph-frame")?.remove();
    };
    const drawTargetFrame = (target: TranslationTarget) => {
      if (!container) return;
      activeTargetRef.current = target;
      container.querySelectorAll(".translation-active").forEach((element) => element.classList.remove("translation-active"));
      const escapedId = CSS.escape(target.id);
      const spans = Array.from(container.querySelectorAll<HTMLElement>(`[data-translation-paragraph="${escapedId}"]`));
      spans.forEach((element) => element.classList.add("translation-active"));
      if (!spans.length) { clearTargetFrame(); return; }
      const bounds = spans.map((element) => element.getBoundingClientRect());
      const containerBounds = container.getBoundingClientRect();
      const frame = container.querySelector<HTMLDivElement>(".translation-paragraph-frame") || document.createElement("div");
      frame.className = "translation-paragraph-frame";
      frame.setAttribute("aria-hidden", "true");
      frame.style.left = `${Math.min(...bounds.map((rect) => rect.left)) - containerBounds.left + container.scrollLeft - 4}px`;
      frame.style.top = `${Math.min(...bounds.map((rect) => rect.top)) - containerBounds.top + container.scrollTop - 4}px`;
      frame.style.width = `${Math.max(...bounds.map((rect) => rect.right)) - Math.min(...bounds.map((rect) => rect.left)) + 8}px`;
      frame.style.height = `${Math.max(...bounds.map((rect) => rect.bottom)) - Math.min(...bounds.map((rect) => rect.top)) + 8}px`;
      if (!frame.isConnected) container.append(frame);
    };
    const applyPendingSearchHighlight = () => {
      const pending = pendingSearchRef.current;
      if (!container || !pending) return;
      const pageElement = container.querySelector<HTMLElement>(`.page[data-page-number="${pending.page}"]`);
      if (!pageElement) return;
      const normalizedTerm = pending.term.toLocaleLowerCase();
      const spans = Array.from(pageElement.querySelectorAll<HTMLElement>(".textLayer span"));
      const matches = spans.filter((span) => span.textContent?.toLocaleLowerCase().includes(normalizedTerm));
      if (!matches.length) return;
      container.querySelectorAll(".pdf-search-highlight").forEach((element) => element.classList.remove("pdf-search-highlight"));
      matches.forEach((span) => span.classList.add("pdf-search-highlight"));
      pendingSearchRef.current = null;
      matches[0].scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    };
    applySearchHighlightRef.current = applyPendingSearchHighlight;
    const redrawActiveFrame = () => {
      const { followTranslationEnabled, lockedTargetId } = callbackRef.current;
      if (!followTranslationEnabled || pointerDown) { clearTargetFrame(); return; }
      const target = lockedTargetId ? targetMap.get(lockedTargetId) : hoveredTarget;
      if (target) drawTargetFrame(target);
      else clearTargetFrame();
    };
    syncHighlightRef.current = redrawActiveFrame;
    const handlePointerOver = (event: PointerEvent) => {
      hoveredTarget = lookupTarget(event);
      redrawActiveFrame();
    };
    const handlePointerOut = (event: PointerEvent) => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest<HTMLElement>("[data-translation-paragraph]") : null;
      hoveredTarget = next ? targetMap.get(next.dataset.translationParagraph || "") : undefined;
      redrawActiveFrame();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId, dragged: 0 };
      suppressClick = false;
      container?.classList.add("translation-selecting");
      clearTargetFrame();
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerDown) return;
      const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
      pointerDown.dragged = Math.max(pointerDown.dragged, distance);
      if (distance > 4) suppressClick = true;
    };
    const finishPointer = () => {
      pointerDown = null;
      container?.classList.remove("translation-selecting");
      redrawActiveFrame();
    };
    const handlePointerCancel = () => {
      suppressClick = true;
      finishPointer();
    };
    const handleClick = (event: MouseEvent) => {
      const target = lookupTarget(event);
      if (target && !pointerDown && !suppressClick && callbackRef.current.followTranslationEnabled && window.getSelection()?.type !== "Range") {
        callbackRef.current.onTargetClick(target);
      }
    };
    const handleFocus = (event: FocusEvent) => {
      hoveredTarget = lookupTarget(event);
      redrawActiveFrame();
    };
    const handleMouseUp = () => {
      // 只有真正拖出一段字才算划词：这一下按住后至少拖动了 5 像素。
      // 点一下、手抖 1–2 像素、双击（浏览器会自动选中整个单词）都不触发，点一下只锁定跟随译文。
      if (!pointerDown || pointerDown.dragged <= 5) return;
      const selection = window.getSelection();
      const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
      if (text.length >= 2 && text.length <= 2000) onSelectionTextRef.current?.(text);
    };
    container?.addEventListener("mouseup", handleMouseUp);
    container?.addEventListener("pointerover", handlePointerOver);
    container?.addEventListener("pointerout", handlePointerOut);
    container?.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("mouseup", finishPointer);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handlePointerCancel);
    container?.addEventListener("click", handleClick);
    container?.addEventListener("focusin", handleFocus);
    container?.addEventListener("scroll", redrawActiveFrame, true);
    window.addEventListener("resize", redrawActiveFrame);

    return () => {
      cancelled = true;
      applySearchHighlightRef.current = () => {};
      syncHighlightRef.current = () => {};
      clearTargetFrame();
      container?.classList.remove("translation-selecting");
      container?.removeEventListener("mouseup", handleMouseUp);
      container?.removeEventListener("pointerover", handlePointerOver);
      container?.removeEventListener("pointerout", handlePointerOut);
      container?.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("mouseup", finishPointer);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handlePointerCancel);
      container?.removeEventListener("click", handleClick);
      container?.removeEventListener("focusin", handleFocus);
      container?.removeEventListener("scroll", redrawActiveFrame, true);
      window.removeEventListener("resize", redrawActiveFrame);
      pdfViewer?.setDocument(null);
      linkService?.setDocument(null);
      viewerRef.current = null;
      targetMap.clear();
      void loadingTask?.destroy();
    };
  }, [src]);

  useEffect(() => {
    if (viewerRef.current && viewerRef.current.currentPageNumber !== pageNumber) viewerRef.current.currentPageNumber = pageNumber;
  }, [pageNumber]);

  return (
    <div className="pdf-viewer-container" ref={containerRef} aria-label="PDF 手册阅读区">
      <button className="pdf-outline-toggle" onClick={() => setOutlineOpen((open) => !open)} aria-expanded={outlineOpen} aria-label={outlineOpen ? "收起 PDF 目录" : "打开 PDF 目录"}>
        {outlineOpen ? "收起目录" : "☰ 目录"}
      </button>
      {outlineOpen && <aside className="pdf-outline-panel" aria-label="PDF 目录">
        <div><strong>手册目录</strong><button onClick={() => setOutlineOpen(false)} aria-label="收起 PDF 目录">×</button></div>
        {outline.length ? <nav>{outline.map((item, index) => <button key={`${item.page}-${index}`} style={{ paddingLeft: `${10 + Math.min(item.depth, 4) * 13}px` }} onClick={() => { onPageChange(item.page); if (viewerRef.current) viewerRef.current.currentPageNumber = item.page; }}><span>{item.title}</span><small>{item.page}</small></button>)}</nav> : <p>这份 PDF 没有可用的书签目录。</p>}
      </aside>}
      <div className="pdfViewer" ref={viewerElementRef} />
    </div>
  );
}
