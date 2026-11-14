"use client";

import { useMemo, useState } from "react";
import type { ParsedTable } from "@/lib/datasheet/tables";
import { tableKind } from "@/lib/datasheet/tables";

type Props = {
  page: number;
  tables: ParsedTable[];
  provider: "offline" | "online" | "deepl";
  onClose: () => void;
};

function pickDescriptionColumn(table: ParsedTable) {
  const byHeader = table.headers.findIndex((header) => /descript|function|comment|conditions/i.test(header));
  if (byHeader >= 0) return byHeader;
  let best = 0;
  let bestLength = -1;
  for (let column = 0; column < table.columns; column++) {
    const average = table.rows.reduce((sum, row) => sum + (row[column]?.length || 0), 0) / Math.max(1, table.rows.length);
    if (average > bestLength) { bestLength = average; best = column; }
  }
  return best;
}

const KIND_LABEL = { pin: "引脚定义表", electrical: "电气参数表", other: "表格" } as const;

export default function TablePanel({ page, tables, provider, onClose }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [view, setView] = useState<"zh" | "en">("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const table = tables[Math.min(activeIndex, tables.length - 1)];
  const descriptionColumn = useMemo(() => (table ? pickDescriptionColumn(table) : 0), [table]);

  async function translateDescriptions() {
    if (!table) return;
    const texts = [...new Set(table.rows.map((row) => row[descriptionColumn]).filter((text) => text && text.length > 1))].slice(0, 24);
    if (!texts.length) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, provider }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "翻译失败。");
      const map: Record<string, string> = {};
      (result.items as { translation: string; skipped?: boolean }[]).forEach((item, index) => {
        map[texts[index]] = item.skipped || !item.translation ? texts[index] : item.translation;
      });
      setTranslations((current) => ({ ...current, ...map }));
      setView("zh");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "翻译失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="bitfield-panel table-panel" aria-label="表格视图">
      <div className="bitfield-heading">
        <div>
          <span>表格 · 第 {page} 页</span>
          <small>{tables.length} 个表 · {table ? KIND_LABEL[tableKind(table)] : "无"}</small>
        </div>
        <button onClick={onClose} aria-label="关闭表格面板">×</button>
      </div>

      {tables.length > 1 && (
        <div className="table-tabs">
          {tables.map((item, index) => (
            <button key={item.id} className={index === activeIndex ? "selected" : ""} onClick={() => setActiveIndex(index)} title={item.title}>
              {item.title.slice(0, 22) || `表 ${index + 1}`}
            </button>
          ))}
        </div>
      )}

      {table ? (
        <>
          <div className="bitfield-controls">
            <div role="group" aria-label="表格显示方式">
              <button className={view === "zh" ? "selected" : ""} onClick={() => setView("zh")}>中文说明</button>
              <button className={view === "en" ? "selected" : ""} onClick={() => setView("en")}>英文原文</button>
            </div>
            {busy && <small className="bitfield-status">正在翻译第 {descriptionColumn + 1} 列…</small>}
            <button className="bitfield-retranslate" disabled={busy} onClick={() => void translateDescriptions()}>
              翻译说明列
            </button>
          </div>
          {error && <p className="bitfield-empty">{error}</p>}
          <div className="bitfield-table-wrap">
            <table>
              <thead>
                <tr>{table.headers.map((header, index) => <th key={index}>{header || `列 ${index + 1}`}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, columnIndex) => (
                      <td key={columnIndex} className={columnIndex === descriptionColumn ? "desc" : ""}>
                        {columnIndex === descriptionColumn && view === "zh"
                          ? (translations[cell] || cell)
                          : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small className="bitfield-foot">
            表结构由文字层坐标还原，不依赖模型；中文说明来自{provider === "offline" ? "本机离线模型" : provider === "deepl" ? "DeepL" : "在线模型"}。
          </small>
        </>
      ) : (
        <p className="bitfield-empty">这一页没有识别到表格。翻到引脚定义表或电气参数表那一页再点「表格」。</p>
      )}
    </aside>
  );
}
