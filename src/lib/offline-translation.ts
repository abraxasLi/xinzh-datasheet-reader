/**
 * Small, deterministic datasheet term translator. This is a glossary/rule
 * helper, not a neural or statistical machine-translation system.
 */

const phrases: ReadonlyArray<readonly [string, string]> = [
  ["is set to", "被设置为"],
  ["is cleared by writing", "通过写入清零"],
  ["is set by writing", "通过写入置位"],
  ["read only", "只读"],
  ["write only", "只写"],
  ["read write", "读写"],
  ["least significant bit", "最低有效位"],
  ["most significant bit", "最高有效位"],
  ["reset value", "复位值"],
  ["reset state", "复位状态"],
  ["bit field", "位域"],
  ["clock enable", "时钟使能"],
  ["clock source", "时钟源"],
  ["interrupt flag", "中断标志"],
  ["interrupt request", "中断请求"],
  ["alternate function", "复用功能"],
  ["input mode", "输入模式"],
  ["output mode", "输出模式"],
  ["pull up", "上拉"],
  ["pull down", "下拉"],
  ["write a one", "写入 1"],
  ["write a zero", "写入 0"],
  ["set to one", "置为 1"],
  ["set to zero", "置为 0"],
  ["when the bit is set", "当该位置位时"],
  ["when the bit is cleared", "当该位清零时"],
  ["when this bit is set", "当此位置位时"],
  ["when this bit is cleared", "当此位清零时"],
  ["this bit is set", "此位置位"],
  ["this bit is cleared", "此位清零"],
  ["the following", "以下"],
  ["the value of", "……的值"],
  ["in order to", "以便"],
  ["as shown in", "如……所示"],
  ["refer to", "参见"],
  ["consists of", "由……组成"],
  ["not available", "不可用"],
  ["not used", "未使用"],
  ["reserved for", "保留用于"],
  ["is reset", "复位"],
  ["is enabled", "已使能"],
  ["is disabled", "已禁用"],
  ["is read", "被读取"],
  ["is written", "被写入"],
  ["must be", "必须为"],
  ["should be", "应为"],
  ["can be", "可以被"],
  ["will be", "将被"],
  ["one of", "其中一个"],
  ["number of", "……的数量"],
  ["address offset", "地址偏移"],
  ["peripheral clock", "外设时钟"],
  ["system clock", "系统时钟"],
];

const words: Readonly<Record<string, string>> = {
  a: "一个", an: "一个", the: "该", this: "此", these: "这些", those: "那些",
  and: "和", or: "或", but: "但", if: "如果", when: "当", while: "当",
  before: "之前", after: "之后", during: "期间", until: "直到", from: "从", to: "到",
  in: "在", on: "在", at: "在", by: "通过", with: "使用", without: "不使用",
  for: "用于", of: "的", as: "作为", into: "进入", between: "之间", each: "每个",
  all: "所有", any: "任意", other: "其他", both: "两者", only: "仅", also: "也",
  not: "不", no: "无", yes: "是", value: "值", values: "值", bit: "位", bits: "位",
  register: "寄存器", registers: "寄存器", field: "字段", fields: "字段", address: "地址",
  offset: "偏移", reset: "复位", default: "默认", status: "状态", control: "控制",
  configuration: "配置", configure: "配置", set: "置位", clear: "清除", write: "写入",
  read: "读取", enable: "使能", enabled: "已使能", disable: "禁用", disabled: "已禁用",
  assert: "置为有效", deassert: "置为无效", input: "输入", output: "输出", mode: "模式",
  clock: "时钟", interrupt: "中断", flag: "标志", request: "请求", source: "来源",
  function: "功能", alternate: "复用", pin: "引脚", pins: "引脚", port: "端口",
  peripheral: "外设", system: "系统", bus: "总线", data: "数据",
  readwrite: "读写", readonly: "只读", writeonly: "只写", reserved: "保留",
  must: "必须", should: "应当", may: "可以", can: "可以", will: "将", shall: "应",
  is: "是", are: "是", be: "为", was: "为", were: "为", has: "具有", have: "具有",
  used: "使用", use: "使用", using: "使用", select: "选择", selected: "已选择",
  indicates: "表示", indicate: "表示", specifies: "指定", specify: "指定", contains: "包含",
  contain: "包含", provides: "提供", provide: "提供", corresponding: "对应的",
  following: "以下", previous: "前一个", high: "高", low: "低",
  bitwise: "按位", settable: "可置位", cleared: "已清零", rising: "上升", falling: "下降",
  edge: "沿", level: "电平", event: "事件", condition: "条件", conditions: "条件",
  table: "表", figure: "图", section: "章节", note: "注", example: "示例",
  see: "参见", located: "位于",
};

const protectedPatterns = [
  /\b0x[\da-f]+\b/gi,
  /\b(?:[A-Z][A-Z\d]*_[A-Z\d_]+|[A-Za-z]+\d+[A-Za-z\d]*|[A-Z]{2,}\d*)\b/g,
  /\b\d+(?:\.\d+)?\s?(?:V|mV|A|mA|uA|µA|Hz|kHz|MHz|GHz|ns|us|µs|ms|s|ohm|Ω|pF|nF|uF|µF|°C)\b/gi,
  /\b\d+(?:\.\d+)?\b/g,
];

export type OfflineTranslation = {
  text: string;
  unknownTerms: string[];
  translatedTerms: number;
};

/** Translate recognizable datasheet wording locally and preserve unknown words. */
export function translateDatasheetText(source: string): OfflineTranslation {
  const protectedValues: string[] = [];
  const clipped = source.length > 20_000;
  let text = source.slice(0, 20_000);
  for (const pattern of protectedPatterns) {
    text = text.replace(pattern, (value) => {
      const markerIndex = protectedValues.length;
      const marker = `\uE000${String.fromCharCode(0xE100 + Math.floor(markerIndex / 0x1900))}${String.fromCharCode(0xE100 + markerIndex % 0x1900)}\uE001`;
      protectedValues.push(value);
      return marker;
    });
  }

  // English manuals often place a short bit-state condition after its result;
  // move this common pattern to the front so the Chinese reading order is clearer.
  text = text.replace(
    /([^.!?\n]+?)\s+when\s+((?:this|the)\s+bit\s+(?:is|has been)\s+(?:set|cleared))/gi,
    "when $2, $1",
  );

  const unknownTerms = new Set<string>();
  let translatedTerms = 0;
  const orderedPhrases = [...phrases].sort((a, b) => b[0].length - a[0].length);
  for (const [english, chinese] of orderedPhrases) {
    const pattern = new RegExp(`\\b${english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+")}\\b`, "gi");
    text = text.replace(pattern, () => {
      translatedTerms += 1;
      return chinese;
    });
  }

  text = text.replace(/\b[A-Za-z]+(?:['’-][A-Za-z]+)*\b/g, (word) => {
    const translated = words[word.toLowerCase()];
    if (!translated) {
      unknownTerms.add(word);
      return word;
    }
    translatedTerms += 1;
    return translated;
  });

  text = text.replace(/\uE000([\uE100-\uF8FF])([\uE100-\uF8FF])\uE001/g, (_marker, high: string, low: string) => {
    const index = (high.charCodeAt(0) - 0xE100) * 0x1900 + low.charCodeAt(0) - 0xE100;
    return protectedValues[index] ?? "";
  });
  text = text
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/\s+([，。；：！？、])/g, "$1")
    .replace(/(?<=[\u3400-\u9fff])[.](?=\s|$)/g, "。")
    .replace(/([,;:!?])(?=[\u3400-\u9fff])/g, (_match, punctuation: string) => ({ ",": "，", ";": "；", ":": "：", "!": "！", "?": "？" }[punctuation] ?? punctuation));

  if (clipped) text += "\n\n[为保持阅读流畅，本地规则译读仅处理前 20,000 个字符。]";
  return { text, unknownTerms: [...unknownTerms], translatedTerms };
}
