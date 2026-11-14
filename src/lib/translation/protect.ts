// 段落翻译前的占位保护：寄存器名、地址、位名、数值+单位先替换成占位符，
// 送进模型后再按序号还原。模型本身不认识芯片标识符，直接翻译会把它们译成中文或丢掉。
// 占位符格式 [[Z0]]：实测这个写法被模型改写的概率最低（PUA/⟦⟧ 会被译成 Q 或乱码）。
import { escapeRegExp } from "./text";
import { applyOutputFixes } from "@/lib/datasheet/terms";

const IDENTIFIER_PATTERNS: RegExp[] = [
  /\b0x[0-9A-Fa-f]+\b/g, // 十六进制地址/复位值
  /\b\d+(?:\.\d+)?\s*(?:MHz|kHz|GHz|Hz|ms|us|µs|ns|s|V|mV|mA|µA|A|pF|nF|uF|µF|kΩ|MΩ|Ω|%|bytes?|bits?)\b/g, // 数值+单位
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // RCC_APB2ENR、AFIO_MAPR
  /\b(?:GPIO|TIM|USART|SPI|I2C|ADC|DMA|EXTI|RCC|FLASH|AFIO|NVIC|CAN|USB|SDIO|FSMC|RTC|IWDG|WWDG|BKP|PWR|SYSCFG|DBGMCU)[A-Za-z0-9]*\b/g,
  /\b[A-Za-z]+x_[A-Z0-9]+\b/g, // GPIOx_CRL 这类按端口泛化的名字
  /\b[A-Z]{2,5}\b/g, // 短缩写位名（TC/TXE/ORE）；长全大写单词不在此列，避免把整段大写正文屏蔽掉
];

// 全大写但对翻译有意义的常见词：不能当标识符屏蔽，否则模型只能看到占位符。
const UPPER_WORDS = new Set([
  "THE", "AND", "FOR", "SET", "BIT", "OFF", "ALL", "ANY", "ONE", "TWO", "USE", "NOT", "CAN", "ARE",
  "WAS", "ITS", "YOU", "SEE", "PER", "VIA", "NEW", "LOW", "HIGH", "DATA", "READ", "WRITE", "MODE",
  "PAGE", "TIME", "TURN", "ONLY", "MUST", "WITH", "FROM", "THAN", "THIS", "THAT", "EACH", "BOTH",
  "NEXT", "LAST", "SAME", "HOLD", "WAIT", "STOP", "START", "POWER", "RESET", "CLEAR", "INPUT",
  "OUTPUT", "GROUND", "SUPPLY", "STATUS", "COMMAND", "VALUE", "RANGE", "LEVEL", "TOTAL", "VALID",
]);

export type ProtectionStyle = { open: string; close: string };
export const DEFAULT_STYLE: ProtectionStyle = { open: "[[Z", close: "]]" };

export type ProtectedText = {
  text: string;
  tokens: string[];
  counts: number;
};

function overlaps(spans: { start: number; end: number }[], start: number, end: number) {
  return spans.some((span) => start < span.end && end > span.start);
}

export function protectText(source: string, style: ProtectionStyle = DEFAULT_STYLE): ProtectedText {
  const spans: { start: number; end: number; value: string }[] = [];
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!match[0].trim()) continue;
      // 全大写常见词（DATA / READ / OUTPUT…）要留给模型翻译
      if (/^[A-Z]{2,5}$/.test(match[0]) && UPPER_WORDS.has(match[0])) continue;
      if (overlaps(spans, start, end)) continue;
      spans.push({ start, end, value: match[0] });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let text = "";
  let cursor = 0;
  const tokens: string[] = [];
  for (const span of spans) {
    text += source.slice(cursor, span.start);
    text += `${style.open}${tokens.length}${style.close}`;
    tokens.push(span.value);
    cursor = span.end;
  }
  text += source.slice(cursor);
  return { text, tokens, counts: tokens.length };
}

/** 模型偶尔会吞掉一个方括号或加空格，这里放宽匹配，避免原文标识符被静默丢弃。 */
export function restoreText(translated: string, tokens: string[], style: ProtectionStyle = DEFAULT_STYLE) {
  void style.open;
  void style.close;
  let output = translated;
  tokens.forEach((token, index) => {
    const pattern = new RegExp(`\\[+\\s*Z?\\s*${index}\\s*\\]+`, "gi");
    output = output.replace(pattern, token);
  });
  return output;
}

export function leftoverPlaceholders(translated: string) {
  return translated.match(/\[+\s*Z\s*\d+\s*\]+/gi) || [];
}

/** 输出侧的术语校正：只修模型最常错的技术词，改动会保留在译文里并可在界面查看。 */
const OUTPUT_CORRECTIONS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /披针/g, replacement: "引脚" },
  { pattern: /针脚/g, replacement: "引脚" },
  { pattern: /寄存器器/g, replacement: "寄存器" },
  { pattern: /复位重置值/g, replacement: "复位值" },
  { pattern: /预分频器器/g, replacement: "预分频器" },
];

export function correctOutput(translated: string) {
  let output = translated;
  for (const correction of OUTPUT_CORRECTIONS) output = output.replace(correction.pattern, correction.replacement);
  // 通用术语层的定向校正（登记器→寄存器、标针→引脚、奴隶→从……）
  output = applyOutputFixes(output);
  return output;
}

export { escapeRegExp };
