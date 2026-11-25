// 让大模型现场把最像的几段写成中文证据卡。不训练、不写死题集。
// 发送内容：用户的问题 + 命中的手册片段；不发送 PDF 文件本身、文件名。
import { chatOnce, defaultLlm, type Effort, type LlmChoice } from "./llm";
import type { Chunk } from "./chunk";

export type EvidenceCard = {
  title: string;       // "<REG_NAME> · <中文名>"
  what: string;        // 1 句中文解释
  quote_zh: string;    // 原文那句的中文翻译，命中词用 **加粗**
  keyword: string;     // 英文原样关键词
  sentence_en: string; // 英文原文那句（逐字取自手册片段）
  page: number;
  section: string;
  register: string;
  checked?: string[];  // 精确搜：核对寄存器名和页码时做过的修改（空数组 = 核对通过、无需修改）
};

const SYSTEM = [
  "你是嵌入式芯片手册的中文检索助手，面向不懂英文的初学者。",
  "用户给出一个中文问题和若干编号的手册英文片段。对每个片段输出一张证据卡，严格输出 JSON 数组，不要任何其它文字、不要 Markdown。",
  "每个元素字段：",
  '{"i":片段编号,"title":"寄存器名或主题英文名 · 中文名（如 XXX_CR · 控制寄存器；没有寄存器名时用小节主题）","what":"一句中文解释这是什么，不超过 40 字","sentence_en":"从该片段中逐字复制最能回答问题的一句英文原文，不得改写","quote_zh":"sentence_en 的中文翻译，把与问题最相关的中文词用 **双星号** 包住","keyword":"该句里最关键的英文词或标识符，原样不翻译"}',
  "规则：寄存器名、位名、地址、数值、单位原样保留；否定和条件关系不能丢；片段里没有的内容不要编造；片段与问题无关时 what 写明“与问题关系不大”。",
].join("\n");

function extractJson(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON。");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("模型返回格式不对。");
  return parsed;
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** 取命中词所在句子，作为模型没给出可核对原句时的兜底。 */
export function fallbackSentence(text: string, term: string) {
  const flat = normalize(text);
  const position = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (position < 0) return flat.slice(0, 220);
  const before = flat.slice(0, position);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), -1) + 1;
  const endMatch = /[.;](?:\s|$)/.exec(flat.slice(position));
  const end = endMatch ? position + endMatch.index + 1 : Math.min(flat.length, position + 260);
  return flat.slice(start, end).trim().slice(0, 320);
}

function chat(llm: LlmChoice, system: string, user: string, maxTokens: number, timeoutMs: number, temperature = 0.1, effort: Effort = "low") {
  return chatOnce(llm, system, user, maxTokens, timeoutMs, temperature, effort);
}

const REWRITE_SYSTEM = [
  "你把中文问题改写成英文检索词，用来在英文 MCU 手册里搜索。",
  "只输出一行，英文关键词用空格分隔；数量跟问题信息量成正比：问题很短就只给 3–6 个词，长问题最多 12 个。",
  "忠实原则：只翻译问题里出现的概念，加上它们在手册里常见的同义词或标准写法。",
  "用户会附上“本手册的章节/外设名词表”。如果问题对应词表里的某一项，必须用词表里的英文全称和缩写原样写出来；词表没有对应项时，只翻译问题本身。",
  "禁止添加既不在问题里、也不在词表里的外设名、寄存器名、缩写或数值；不确定就少写，宁缺毋滥，不要为了凑数去猜。",
  "问题里本来就有的英文标识符、缩写、数字原样保留。",
  "问“怎么开 / 启用 / 启动 / 配置”这类操作时，可以加 enable / start / configure；问“最高 / 最大 / 范围”时，可以加 maximum / limit / range；问题没有这类意思就不要加。",
  "不要解释，不要引号，不要换行。",
].join("\n");

/** 中文问题 → 英文检索词，让 BM25 能认英文术语，向量也有英文锚点。失败时返回空串（退回原问题）。 */
export async function rewriteQuery(question: string, outline: string[] = [], llm: LlmChoice = defaultLlm(), temperature = 0, effort: Effort = "low"): Promise<string> {
  try {
    const user = outline.length ? `本手册的章节/外设名词表：${outline.join("；")}\n\n问题：${question}` : `问题：${question}`;
    const text = await chat(llm, REWRITE_SYSTEM, user, effort === "high" ? 2000 : 500, effort === "high" ? 20000 : 8000, temperature, effort);
    return text.split("\n")[0].replace(/["`]/g, "").trim().slice(0, 300);
  } catch {
    return "";
  }
}

async function cardFor(question: string, chunk: Chunk, llm: LlmChoice): Promise<EvidenceCard> {
  const user = `问题：${question}\n\n【1】${chunk.section ? `(${chunk.section}) ` : ""}${chunk.text.slice(0, 900)}`;
  let item: Record<string, unknown> = {};
  try {
    const raw = extractJson(await chat(llm, SYSTEM, user, 700, 25000)) as Record<string, unknown>[];
    item = raw[0] || {};
  } catch {
    // 单张卡片失败不拖垮整次搜索：只保留本地字段，中文行留空。
  }
  const text = (field: string) => (typeof item[field] === "string" ? (item[field] as string).trim() : "");
  const keyword = text("keyword") || chunk.register;
  // 英文原句必须逐字出自手册片段，否则用本地规则取句，避免模型改写原文。
  const claimed = normalize(text("sentence_en"));
  const sentence = claimed && normalize(chunk.text).includes(claimed) ? claimed : fallbackSentence(chunk.text, keyword || chunk.register);
  return {
    title: text("title") || chunk.register || chunk.section || "相关原文",
    what: text("what"),
    quote_zh: text("quote_zh"),
    keyword,
    sentence_en: sentence,
    page: chunk.page,
    section: chunk.section,
    register: chunk.register,
  };
}

const RERANK_SYSTEM = [
  "你是嵌入式芯片手册的检索排序器。用户给出一个中文问题和若干编号的英文手册片段。",
  "请判断哪些片段最能**直接**回答这个问题，按相关度从高到低输出编号。",
  "排序原则（通用，不针对某本手册）：",
  "先判断问题类型，再排序：",
  "A. 名词/功能类（如“××是什么”“××对应哪个寄存器”或只有一个功能名词）：标了【寄存器定义】、且这个寄存器正是实现该功能的那一段排第一；其次是该功能的说明段。",
  "B. 操作类（“怎么开/启用/配置/清除××”）：写明具体操作（写什么值、置哪个位、按什么顺序）的段落排第一；其次是被操作的那个寄存器的【寄存器定义】。",
  "C. 数值类（“最高/最大/最小/范围/多少”）：写着具体数值和单位、且数值说的正是问题所问对象的段落排第一。",
  "通用规则：只是顺带提到该对象的段落、其它外设的段落、目录、寄存器总表、修订历史一律靠后；片段前标注的【寄存器定义：XXX】表示这一段就是 XXX 的定义页。",
  '只输出 JSON：{"order":[编号,...]}，最多 5 个编号，不要任何其它文字。',
].join("\n");

/** 精确搜第二步：让模型带推理把候选段重新排一次序，取最能直接回答问题的 5 段。失败时保持原顺序。 */
export async function rerankChunks(question: string, chunks: Chunk[], llm: LlmChoice = defaultLlm(), limit = 5): Promise<{ chunks: Chunk[]; reranked: boolean }> {
  if (chunks.length <= 1) return { chunks: chunks.slice(0, limit), reranked: false };
  const user = `问题：${question}\n\n` + chunks.map((chunk, index) => `【${index + 1}】第 ${chunk.page} 页${chunk.register ? `【寄存器定义：${chunk.register}】` : ""} ${chunk.section ? `(${chunk.section}) ` : ""}${chunk.text.slice(0, 600)}`).join("\n\n");
  try {
    const text = await chat(llm, RERANK_SYSTEM, user, 3000, 25000, 0, "high");
    const match = text.match(/\{[\s\S]*\}/);
    const order = ((match ? JSON.parse(match[0]) : {}).order || []) as unknown[];
    const picked: Chunk[] = [];
    for (const value of order) {
      const chunk = chunks[Number(value) - 1];
      if (chunk && !picked.includes(chunk)) picked.push(chunk);
      if (picked.length >= limit) break;
    }
    if (!picked.length) return { chunks: chunks.slice(0, limit), reranked: false };
    // 模型给的不足 limit 个时，用原顺序补齐。
    for (const chunk of chunks) { if (picked.length >= limit) break; if (!picked.includes(chunk)) picked.push(chunk); }
    return { chunks: picked, reranked: true };
  } catch {
    return { chunks: chunks.slice(0, limit), reranked: false };
  }
}

const IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Za-z0-9]+)+(?:\[\d+(?::\d+)?\])?/g;

/**
 * 精确搜第三步：逐张卡片核对寄存器名和页码（确定性规则，不靠模型）。
 * - 标题里的寄存器名必须真的出现在该段原文里（或就是该段定义的寄存器），否则换成该段自己的寄存器名 / 小节名；
 * - 原文关键词必须真的出现在该段原文里，否则换成英文原句里的标识符或该段寄存器名；
 * - 页码、章节一律取自该段本身，不用模型说的；
 * - 标题是寄存器 X、但这一段只是“提到” X 而不是 X 的定义页：X 的定义段也在结果里，就把定义段排到它前面；
 *   不在结果里，就在卡片上注明 X 的定义在第几页。
 * 返回每张卡片改了什么，界面据此显示“已核对”。
 */
export function verifyCards(cards: EvidenceCard[], chunks: Chunk[], definitionPageOf: (register: string) => number | undefined = () => undefined): EvidenceCard[] {
  const checkedCards = cards.map((card, index) => {
    const chunk = chunks[index];
    if (!chunk) return { card, mentionOnly: "" };
    const source = chunk.text.toLowerCase();
    const fixes: string[] = [];
    let title = card.title;
    for (const name of title.match(IDENTIFIER) || []) {
      const bare = name.replace(/\[.*$/, "");
      if (source.includes(bare.toLowerCase()) || bare === chunk.register) continue;
      const replacement = chunk.register || "";
      title = replacement ? title.replace(name, replacement) : title.replace(name, "").replace(/^\s*·\s*/, "");
      fixes.push(`标题里的 ${bare} 不在该段原文中，已改为 ${replacement || "小节主题"}`);
    }
    let keyword = card.keyword;
    // 关键词就是这一段定义的寄存器时直接算通过：长寄存器定义会被切成几段，后面几段正文里不一定再出现它的名字。
    if (keyword && keyword !== chunk.register && !source.includes(keyword.toLowerCase())) {
      const fromSentence = card.sentence_en.match(IDENTIFIER)?.[0];
      const next = fromSentence || chunk.register || "";
      fixes.push(`关键词 ${keyword} 不在该段原文中，已改为 ${next || "（无）"}`);
      keyword = next;
    }
    if (card.page !== chunk.page) fixes.push(`页码已按原文改为第 ${chunk.page} 页`);
    // 标题点名的寄存器（取第一个）不是这一段定义的那个：记下它的定义页，后面用来调整顺序。
    const titled = (title.match(IDENTIFIER) || [])[0]?.replace(/\[.*$/, "") || "";
    const mentionOnly = titled && titled !== chunk.register ? titled : "";
    return { card: { ...card, title: title.trim() || chunk.register || chunk.section || "相关原文", keyword, page: chunk.page, section: chunk.section, register: chunk.register, checked: fixes }, mentionOnly };
  });

  // 第二遍：处理"只是提到、不是定义页"的卡片。
  const ordered = checkedCards.map((entry) => entry.card);
  for (const { card, mentionOnly } of checkedCards) {
    if (!mentionOnly) continue;
    const definitionPage = definitionPageOf(mentionOnly);
    if (!definitionPage || definitionPage === card.page) continue;
    const from = ordered.indexOf(card);
    const definitionAt = ordered.findIndex((other) => other.register === mentionOnly);
    if (definitionAt > from) {
      const [definition] = ordered.splice(definitionAt, 1);
      ordered.splice(from, 0, definition);
      definition.checked = [...(definition.checked || []), `这是 ${mentionOnly} 的定义页，已排到只提到它的第 ${card.page} 页之前`];
    } else if (definitionAt < 0) {
      card.checked = [...(card.checked || []), `这一段只是提到 ${mentionOnly}，它的定义在第 ${definitionPage} 页`];
    }
  }
  return ordered;
}

/** 每个命中片段一次 GLM 调用，并行发出：总耗时约等于最慢的一张卡，而不是五张之和。 */
export async function writeEvidenceCards(question: string, chunks: Chunk[], llm: LlmChoice = defaultLlm()): Promise<{ cards: EvidenceCard[]; ms: number; model: string }> {
  const startedAt = Date.now();
  const cards = await Promise.all(chunks.map((chunk) => cardFor(question, chunk, llm)));
  return { cards, ms: Date.now() - startedAt, model: llm.model };
}
