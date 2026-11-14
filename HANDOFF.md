# 交接卡片

新对话先读这一个文件，不要重述历史。

## 项目

本地 Windows 阅读器「芯知」：PDF.js 显示英文芯片手册，中文搜索定位，段落/选中文字翻成中文。仓库 `https://github.com/abraxasLi/xinzh-datasheet-reader`。

## 怎么跑

```powershell
cd D:\tool\芯片手册翻译器
node node_modules\next\dist\bin\next dev --hostname 127.0.0.1 --port 3010
```

打开 http://127.0.0.1:3010 ，用 `.samples\rm0008-en.pdf` 验收。不要用 `npm run dev`（spawn EPERM）。

## 现状

- 已完成并验证：PDF 阅读、中文搜索定位、跟随译读、选中即译、位域表、表格解析、三引擎（本机 Argos / 智谱 / DeepL）。
- 翻译质量：DeepL > 智谱 > 本机。key 在 `.zhipu-key`、`.deepl-key`（已 gitignore）。
- 未完成：EXE 打包（进行中）、表格单元格切分、位段选中误读、20 段质量评分。

## 下一步（优先级）

1. 完成 EXE：`tools\build-exe.ps1`（Electron + Next standalone + 便携 Python + 离线模型，产出 `release\` 安装包）。
2. 翻译提速四件事：按句切分、本机先出译文再替换 DeepL、预取下一段、整页缓存。
3. 表格切分与位段结构化。

## 关键文件

| 改什么 | 文件 |
| --- | --- |
| 界面 / 面板 | `src/app/page.tsx`、`src/app/TablePanel.tsx` |
| PDF / 选中 / 坐标 | `src/app/PdfReader.tsx` |
| 翻译编排 | `src/app/api/translate/route.ts` |
| 引擎 | `src/lib/translation/{engine,online,deepl}.ts`、`runtime/translate_server.py` |
| 质量 | `src/lib/translation/{protect,sanitize,quality}.ts`、`src/lib/datasheet/terms.ts` |
| 结构解析 | `src/lib/datasheet/{bitfields,tables}.ts` |

## 约束

- 只给一个最推荐方案，回答简短。
- 改完跑 `npx tsc --noEmit --incremental false` 和 `npx eslint .`，涉及界面跑 `tools\ui-check.mjs`。
- 不提交密钥/模型/PDF；不把在线引擎设成默认。
- 详细说明见 `docs/开发指南.md`，历史验收记录在 `outputs/`。
