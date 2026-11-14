import { matchGlossary } from "@/lib/glossary";
import { expandToEnglish } from "@/lib/datasheet/terms";

export type EvidenceChunk = { quote_en: string; page: number; section: string; translation_zh: string; highlight_term: string };

const overviewPattern = /这份文档|这个文档|文档.{0,8}(关于什么|讲什么|主要|介绍)|主要内容|手册.{0,8}(关于什么|讲什么|是什么)/i;

export function isOverviewQuestion(question: string) {
  return overviewPattern.test(question);
}

function sectionFrom(text: string) {
  const match = text.match(/(?:^|\s)(\d+(?:\.\d+){1,3}\s+[A-Z][A-Za-z0-9 ,()/-]{3,90})/);
  return match?.[1]?.trim() || "PDF 文本页";
}

function inferRegisterIntent(question: string) {
  const intents: { test: RegExp; identifiers: string[]; terms: string[] }[] = [
    { test: /GPIO.{0,10}时钟|时钟.{0,10}GPIO|(?:使能|开启).{0,8}GPIO.{0,8}时钟/i, identifiers: ["RCC_APB2ENR"], terms: ["IOPAEN", "GPIOAEN", "APB2ENR", "enable clock"] },
    { test: /GPIO.{0,12}(?:浮空|浮置|输入)|(?:浮空输入|浮置输入)/i, identifiers: ["GPIOx_CRL", "GPIOx_CRH"], terms: ["floating input", "input floating", "CNF", "MODE"] },
    { test: /GPIO.{0,12}(?:输出速度|速度设置)|(?:输出速度).{0,10}GPIO/i, identifiers: ["GPIOx_CRL", "GPIOx_CRH"], terms: ["output speed", "MODE", "CNF"] },
    { test: /(?:GPIO|引脚).{0,12}(?:复用|重映射)|(?:复用|重映射).{0,12}(?:GPIO|引脚)/i, identifiers: ["AFIO_MAPR"], terms: ["remapping", "alternate function"] },
    { test: /(?:USART|UART|串口|串行).{0,12}(?:波特率|baud)|(?:波特率|baud).{0,12}(?:USART|UART|串口|串行)/i, identifiers: ["USART_BRR"], terms: ["baud rate", "BRR"] },
    { test: /(?:USART|UART|串口|串行).{0,16}(?:发送完成|传输完成)|(?:发送完成|传输完成).{0,12}(?:USART|UART|串口|串行)/i, identifiers: ["USART_SR"], terms: ["transmission complete", "TC"] },
    { test: /(?:定时器|timer|TIM).{0,12}(?:预分频|分频系数)|(?:预分频|分频系数).{0,12}(?:定时器|timer|TIM)/i, identifiers: ["TIMx_PSC"], terms: ["prescaler", "PSC"] },
    { test: /(?:外部中断|EXTI).{0,12}(?:挂起|pending)|(?:挂起|pending).{0,12}(?:外部中断|EXTI)/i, identifiers: ["EXTI_PR"], terms: ["pending register", "pending bit"] },
    { test: /(?:NVIC|中断).{0,12}(?:优先级)|(?:优先级).{0,12}(?:NVIC|中断)/i, identifiers: ["NVIC"], terms: ["interrupt priority", "priority level"] },
    { test: /DMA.{0,12}(?:传输完成|完成标志)|(?:传输完成|完成标志).{0,12}DMA/i, identifiers: ["DMA_ISR"], terms: ["transfer complete", "TCIF"] },
    { test: /(?:I2C|I²C|两线总线).{0,12}(?:起始|START)|(?:起始条件|START).{0,12}(?:I2C|I²C|总线)?/i, identifiers: ["I2C_CR1"], terms: ["start condition", "START bit"] },
    { test: /(?:Flash|闪存).{0,12}(?:解锁|密钥|键)|(?:解锁|密钥|键).{0,12}(?:Flash|闪存)/i, identifiers: ["FLASH_KEYR"], terms: ["key register", "unlock sequence"] },
    { test: /(?:时钟安全|时钟故障|时钟中断).{0,16}(?:标志|寄存器|清除)?|CSSF/i, identifiers: ["RCC_CIR"], terms: ["clock security system", "CSSF"] },
    { test: /(?:复位和)?时钟控制(?:寄存器|模块)|(?:RCC).{0,12}(?:复位|时钟)/i, identifiers: ["RCC_CFGR", "RCC_CR", "RCC_CSR"], terms: ["reset and clock control", "clock configuration", "reset status"] },
    { test: /(?:片上|内部|内置)?\s*(?:温度传感器|temperature sensor)/i, identifiers: ["ADC_CR2"], terms: ["TSVREFE", "channel 16", "temperature sensor"] },
  ];
  const matched = intents.filter((intent) => intent.test.test(question));
  return {
    identifiers: [...new Set(matched.flatMap((intent) => intent.identifiers))],
    terms: [...new Set(matched.flatMap((intent) => intent.terms))],
  };
}

function termsForQuestion(question: string, intentTerms: string[] = []) {
  const terms = new Set<string>();
  intentTerms.forEach((term) => terms.add(term));
  // 通用术语层：把中文问题映射成英文检索词，换厂商手册也能命中。
  for (const term of expandToEnglish(question)) terms.add(term);
  for (const entry of matchGlossary(question)) {
    terms.add(entry.term); terms.add(entry.english);
    if (["GPIO", "pin", "pinout"].includes(entry.term)) { terms.add("GPIO"); terms.add("pin"); terms.add("pinout"); terms.add("alternate function"); }
    if (entry.term === "RCC") { terms.add("RCC"); terms.add("clock"); terms.add("reset"); }
    if (entry.term === "NVIC") { terms.add("NVIC"); terms.add("interrupt"); }
    if (entry.term === "TIM") { terms.add("timer"); terms.add("prescaler"); }
  }
  const identifiers = question.match(/\b(?:0x[0-9a-f]+|[a-z]{2,}[a-z0-9_]*|[a-z]{1,3}\d{1,2})\b/gi) || [];
  const broadStops = new Set(["stm32", "datasheet", "manual", "reference", "which", "where", "what", "this", "that", "with", "from", "into", "over"]);
  identifiers.filter((token) => !broadStops.has(token.toLowerCase())).forEach((token) => terms.add(token));
  return [...terms].slice(0, 16);
}

function exactIdentifiers(question: string) {
  return [...new Set(question.match(/\b(?:0x[0-9a-f]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{2,})\b/g) || [])]
    .filter((token) => !/^STM\d*$/i.test(token));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionForTerm(text: string, term: string) {
  const termPosition = text.toLowerCase().indexOf(term.toLowerCase());
  if (termPosition < 0) return sectionFrom(text);
  const headingPattern = /(?:^|\s)(\d+(?:\.\d+){1,3}\s+[A-Z][A-Za-z0-9 ,()/-]{3,90})/g;
  let closest: RegExpExecArray | null = null;
  for (let match = headingPattern.exec(text); match; match = headingPattern.exec(text)) {
    if (match.index > termPosition) break;
    closest = match;
  }
  if (closest && termPosition - closest.index < 500) return closest[1].trim();
  return sectionFrom(text);
}

function hasRegisterDefinition(text: string, token: string) {
  const heading = new RegExp(`(?:^|\\s)\\d+(?:\\.\\d+){1,3}\\s+[^.]{0,160}\\(\\s*${escapeRegExp(token)}\\s*\\)`, "gi");
  for (let match = heading.exec(text); match; match = heading.exec(text)) {
    if (/Address(?:\s+offset)?\s*:/i.test(text.slice(match.index, match.index + 900))) return true;
  }
  return false;
}

function occurrences(text: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(escaped, "gi")) || []).length;
}

export function searchPages(pages: string[], question: string, kind: string, fileName: string): { evidence: EvidenceChunk[]; glossary: ReturnType<typeof matchGlossary>; answerHint: string } {
  const glossary = matchGlossary(question);
  if (isOverviewQuestion(question)) {
    const evidence = pages.slice(0, 12).map((text, index) => ({
      quote_en: text.slice(0, 1000).trim(), page: index + 1,
      section: index === 0 ? "封面" : sectionFrom(text),
      translation_zh: "本地阅读模式展示封面/目录原文；不会自动编写全文摘要。",
      highlight_term: "",
    })).filter((chunk) => chunk.quote_en.length > 50).slice(0, 8);
    const typeHint = /Reference Manual/i.test(kind)
      ? "参考手册通常说明外设工作方式、寄存器和配置流程；具体型号的封装引脚与电气参数要查对应 Datasheet。"
      : "下方保留了封面和前段目录原文，可直接继续阅读并用本地搜索定位细节。";
    return {
      evidence, glossary,
      answerHint: `《${fileName}》识别为 ${kind}，共 ${pages.length} 页。${typeHint}本地模式直接展示封面/目录原文，不编造自动摘要。`,
    };
  }

  const inferredIntent = inferRegisterIntent(question);
  const exactTokens = [...new Set([...exactIdentifiers(question), ...inferredIntent.identifiers])].map((term) => term.toLowerCase());
  const strongTokens = exactTokens.filter((token) => token.includes("_") || token.startsWith("0x"));
  // If the user names a concrete register or address, search around that exact identifier first.
  // Broad glossary expansion (RCC, register, clock...) otherwise floods the result list.
  const terms = strongTokens.length
    ? strongTokens.filter((term) => term.length >= 2)
    : termsForQuestion(question, inferredIntent.terms).map((term) => term.toLowerCase()).filter((term) => term.length >= 2);
  const results = pages.map((text, index) => {
    const lower = text.toLowerCase();
    const hits = terms.map((term) => ({ term, count: occurrences(lower, term) })).filter((hit) => hit.count > 0);
    const strongHit = strongTokens.reduce((sum, token) => sum + occurrences(lower, token), 0);
    if (!hits.length && !strongHit) return null;
    const exactHit = exactTokens.reduce((sum, token) => sum + Math.min(occurrences(lower, token), 3), 0);
    // A requested identifier should dominate broad glossary matches (e.g. RCC_CIR over generic RCC pages).
    const hasFormalRegisterDefinition = strongTokens.some((token) => hasRegisterDefinition(text, token));
    const matchedSection = sectionFrom(text);
    const nvicSectionBoost = /(?:NVIC|中断).{0,12}(?:优先级)|(?:优先级).{0,12}(?:NVIC|中断)/i.test(question) && /nested vectored interrupt controller/i.test(matchedSection) ? 60000 : 0;
    const cueScore = strongHit * 10000 + (hasFormalRegisterDefinition ? 100000 : 0) + nvicSectionBoost + exactHit * 100 + hits.reduce((sum, hit) => sum + Math.min(hit.count, 3) * (hit.term.includes("_") || hit.term.includes("0x") ? 7 : 2), 0);
    const isContentsOrIndex = /table of contents|contents\b|list of (?:tables|figures)|\bindex\b/i.test(text.slice(0, 1200));
    // 只惩罚真正的目录/索引页。之前对前 10 页一律扣分，会把别的厂商手册
    // 前几页里的有效内容（例如 DS18B20 第 1/5 页的 resolution）直接筛掉。
    const frontMatterPenalty = isContentsOrIndex && !hasFormalRegisterDefinition ? 1000000 : 0;
    const exactTerm = strongTokens.find((token) => lower.includes(token)) || exactTokens.find((token) => lower.includes(token)) || hits.sort((a, b) => (b.term.includes("_") ? 1 : 0) - (a.term.includes("_") ? 1 : 0) || b.term.length - a.term.length)[0]?.term || strongTokens[0];
    const position = lower.indexOf(exactTerm);
    const start = Math.max(0, position - 210);
    const end = Math.min(text.length, position + 540);
    const translation = glossary[0]?.chinese || "请在当前阅读面板使用本地词典规则译读，并核对英文原文。";
    return { score: cueScore - frontMatterPenalty, chunk: { quote_en: text.slice(start, end).trim(), page: index + 1, section: sectionForTerm(text, exactTerm), translation_zh: translation, highlight_term: exactTerm || "" } };
  }).filter((item): item is NonNullable<typeof item> => item !== null).sort((a, b) => b.score - a.score);
  const ranked = results.filter((result) => result.score > 0).slice(0, 8).map((result) => result.chunk);
  const isPinQuestion = /引脚|管脚|脚位|pinout/i.test(question);
  const isFlashProgrammingQuestion = /(?:flash|闪存).{0,14}(?:解锁|密钥|键|编程|擦除)|(?:解锁|密钥|键|编程|擦除).{0,14}(?:flash|闪存)/i.test(question);
  const isNvicPriorityQuestion = /(?:nvic|中断).{0,12}优先级|优先级.{0,12}(?:nvic|中断)/i.test(question);
  const isOperatingRangeQuestion = /(?:工作|运行)?温度.{0,6}(?:范围|等级)|工作温度范围/i.test(question);
  const answerHint = !ranked.length
    ? "本地索引没有明确命中。试试输入手册中的英文缩写、寄存器名或十六进制地址；本地模式不会猜测未检索到的内容。"
    : isPinQuestion && /Reference Manual/i.test(kind)
      ? "这是参考手册，通常说明 GPIO 配置和复用功能，不一定包含某个具体型号的封装引脚图。下面列出 pin/GPIO 相关原文；精确物理脚位请核对对应芯片型号的 Datasheet。"
      : isOperatingRangeQuestion && /Reference Manual/i.test(kind)
        ? "命中的是片上温度传感器相关内容，不是芯片的工作温度范围。具体型号的工作温度等级要看对应 Datasheet 的电气特性表，参考手册不提供。"
      : isFlashProgrammingQuestion && /Reference Manual/i.test(kind)
        ? "本手册的命中内容只提供 FLASH_KEYR 等寄存器的地址映射；完整 Flash 解锁、擦除和编程步骤请查封面列出的配套 Flash programming manual PM0075。"
        : isNvicPriorityQuestion && /Reference Manual/i.test(kind)
          ? "本手册可定位到 NVIC 与中断章节；具体 Cortex-M3 优先级寄存器编程细节请核对配套 PM0056 编程手册。"
      : `本地索引找到 ${ranked.length} 处可能相关的原文。${glossary.length ? `术语：${glossary.map((item) => `${item.term} = ${item.chinese}`).join("；")}。` : "请查看原文片段并核对上下文。"}`;
  return { evidence: ranked, glossary, answerHint };
}
