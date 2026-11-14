// 通用双语术语层：不绑定 STM32，覆盖数据手册最常见的名词/动词/单位。
// 用途有三个：
//   1) 中文搜索时把中文问题扩展成英文检索词（换厂商手册也能搜）；
//   2) 在线模型翻译时作为动态术语约束，减少"标针/登记器"这类错译；
//   3) 译后对少量高频错误做定向校正。

export type Term = {
  en: string;
  zh: string;
  aliases: string[]; // 用户可能输入的中文/英文变体
  kind: "noun" | "verb" | "unit";
};

export const GENERAL_TERMS: Term[] = [
  // 寄存器与结构
  { en: "register", zh: "寄存器", aliases: ["寄存器", "register", "reg"], kind: "noun" },
  { en: "bit", zh: "位", aliases: ["位", "比特", "bit"], kind: "noun" },
  { en: "bit field", zh: "位域", aliases: ["位域", "位段", "bitfield", "bit field"], kind: "noun" },
  { en: "reserved", zh: "保留", aliases: ["保留位", "保留", "reserved"], kind: "noun" },
  { en: "address offset", zh: "地址偏移", aliases: ["地址偏移", "偏移", "offset"], kind: "noun" },
  { en: "base address", zh: "基地址", aliases: ["基地址", "base address"], kind: "noun" },
  { en: "reset value", zh: "复位值", aliases: ["复位值", "默认值", "reset value"], kind: "noun" },
  { en: "default", zh: "默认", aliases: ["默认", "缺省", "default"], kind: "noun" },
  { en: "read only", zh: "只读", aliases: ["只读", "read only", "ro"], kind: "noun" },
  { en: "write only", zh: "只写", aliases: ["只写", "write only", "wo"], kind: "noun" },
  { en: "read/write", zh: "读写", aliases: ["读写", "read write", "rw"], kind: "noun" },
  { en: "set", zh: "置位", aliases: ["置位", "置1", "set"], kind: "verb" },
  { en: "clear", zh: "清零", aliases: ["清零", "清除", "clear", "reset bit"], kind: "verb" },
  { en: "enable", zh: "使能", aliases: ["使能", "开启", "启用", "enable"], kind: "verb" },
  { en: "disable", zh: "禁用", aliases: ["禁用", "关闭", "disable"], kind: "verb" },
  { en: "configure", zh: "配置", aliases: ["配置", "设置", "configure", "set up"], kind: "verb" },
  { en: "select", zh: "选择", aliases: ["选择", "select"], kind: "verb" },
  { en: "init", zh: "初始化", aliases: ["初始化", "init", "initialize"], kind: "verb" },

  // 外设与信号
  { en: "peripheral", zh: "外设", aliases: ["外设", "周边", "peripheral"], kind: "noun" },
  { en: "interrupt", zh: "中断", aliases: ["中断", "interrupt", "irq"], kind: "noun" },
  { en: "flag", zh: "标志", aliases: ["标志位", "标志", "flag"], kind: "noun" },
  { en: "status", zh: "状态", aliases: ["状态", "status"], kind: "noun" },
  { en: "pending", zh: "挂起", aliases: ["挂起", "待处理", "pending"], kind: "noun" },
  { en: "clock", zh: "时钟", aliases: ["时钟", "clock", "clk"], kind: "noun" },
  { en: "prescaler", zh: "预分频器", aliases: ["预分频", "分频", "prescaler"], kind: "noun" },
  { en: "baud rate", zh: "波特率", aliases: ["波特率", "baud"], kind: "noun" },
  { en: "channel", zh: "通道", aliases: ["通道", "频道", "channel"], kind: "noun" },
  { en: "buffer", zh: "缓冲区", aliases: ["缓冲", "缓冲区", "buffer", "fifo"], kind: "noun" },
  { en: "latch", zh: "锁存", aliases: ["锁存", "latch"], kind: "noun" },
  { en: "edge", zh: "边沿", aliases: ["边沿", "边缘", "edge"], kind: "noun" },
  { en: "rising edge", zh: "上升沿", aliases: ["上升沿", "rising edge"], kind: "noun" },
  { en: "falling edge", zh: "下降沿", aliases: ["下降沿", "falling edge"], kind: "noun" },
  { en: "duty cycle", zh: "占空比", aliases: ["占空比", "duty cycle"], kind: "noun" },
  { en: "glitch", zh: "毛刺", aliases: ["毛刺", "glitch"], kind: "noun" },
  { en: "wakeup", zh: "唤醒", aliases: ["唤醒", "wakeup", "wake up"], kind: "noun" },
  { en: "power down", zh: "掉电", aliases: ["掉电", "断电", "power down", "power off"], kind: "noun" },

  // 显示 / 存储 / 传感器（换厂商时常用）
  { en: "command", zh: "命令", aliases: ["命令", "指令", "command"], kind: "noun" },
  { en: "data", zh: "数据", aliases: ["数据", "data"], kind: "noun" },
  { en: "display", zh: "显示", aliases: ["显示", "display"], kind: "noun" },
  { en: "window", zh: "窗口", aliases: ["窗口", "window"], kind: "noun" },
  { en: "memory", zh: "存储器", aliases: ["内存", "存储器", "memory"], kind: "noun" },
  { en: "sector", zh: "扇区", aliases: ["扇区", "sector"], kind: "noun" },
  { en: "block", zh: "块", aliases: ["块", "block"], kind: "noun" },
  { en: "page", zh: "页", aliases: ["页", "page"], kind: "noun" },
  { en: "erase", zh: "擦除", aliases: ["擦除", "erase"], kind: "verb" },
  { en: "program", zh: "编程", aliases: ["编程", "写入", "program"], kind: "verb" },
  { en: "write protect", zh: "写保护", aliases: ["写保护", "write protect"], kind: "noun" },
  { en: "hold", zh: "保持", aliases: ["保持", "hold"], kind: "noun" },
  { en: "chip select", zh: "片选", aliases: ["片选", "chip select", "cs"], kind: "noun" },
  { en: "temperature", zh: "温度", aliases: ["温度", "temperature"], kind: "noun" },
  { en: "conversion", zh: "转换", aliases: ["转换", "conversion", "convert"], kind: "noun" },
  { en: "resolution", zh: "分辨率", aliases: ["分辨率", "精度", "resolution"], kind: "noun" },
  { en: "sensor", zh: "传感器", aliases: ["传感器", "sensor"], kind: "noun" },
  { en: "pin", zh: "引脚", aliases: ["引脚", "管脚", "pin"], kind: "noun" },
  { en: "voltage", zh: "电压", aliases: ["电压", "voltage", "vdd"], kind: "noun" },
  { en: "current", zh: "电流", aliases: ["电流", "current"], kind: "noun" },
  { en: "frequency", zh: "频率", aliases: ["频率", "frequency"], kind: "noun" },

  // 读/写/操作
  { en: "read", zh: "读取", aliases: ["读取", "读", "read"], kind: "verb" },
  { en: "write", zh: "写入", aliases: ["写入", "写", "write"], kind: "verb" },
  { en: "transmit", zh: "发送", aliases: ["发送", "transmit", "tx"], kind: "verb" },
  { en: "receive", zh: "接收", aliases: ["接收", "receive", "rx"], kind: "verb" },
  { en: "sample", zh: "采样", aliases: ["采样", "取样", "sample"], kind: "verb" },
  { en: "sequence", zh: "序列", aliases: ["序列", "顺序", "sequence"], kind: "noun" },
];

/** 中文问题 → 英文检索词（同时保留用户输入的英文标识符）。 */
export function expandToEnglish(question: string): string[] {
  const lower = question.toLowerCase();
  const terms = new Set<string>();
  for (const term of GENERAL_TERMS) {
    if (term.aliases.some((alias) => lower.includes(alias.toLowerCase()))) {
      terms.add(term.en);
    }
  }
  return [...terms];
}

/** 命中段落的术语，用于在线翻译时的动态术语约束。 */
export function matchTermsForText(text: string, limit = 12): Term[] {
  const lower = text.toLowerCase();
  return GENERAL_TERMS.filter((term) => lower.includes(term.en.toLowerCase())).slice(0, limit);
}

/** 译后定向校正：只修高频、确定错的渲染，不改写句子。 */
const OUTPUT_FIXES: { pattern: RegExp; replacement: string }[] = [
  { pattern: /登记器/g, replacement: "寄存器" },
  { pattern: /登记册/g, replacement: "寄存器" },
  { pattern: /标针|披针|寄存针|管脚器/g, replacement: "引脚" },
  { pattern: /坦佩尔|谭珀/g, replacement: "篡改" },
  { pattern: /篡改器/g, replacement: "篡改" },
  { pattern: /预缩放器|预分频器器/g, replacement: "预分频器" },
  { pattern: /奴隶(?=定时器|设备|端)/g, replacement: "从" },
  { pattern: /离国/g, replacement: "关断" },
  { pattern: /鼻音/g, replacement: "正弦波" },
  { pattern: /(平方)(?=、|或|波)/g, replacement: "方波" },
  { pattern: /死后(?=时间|，|,)/g, replacement: "死区后" },
  { pattern: /比特(?=[^，。]{0,4}(位|置位|清零))/g, replacement: "位" },
];

export function applyOutputFixes(text: string): string {
  let output = text;
  for (const fix of OUTPUT_FIXES) output = output.replace(fix.pattern, fix.replacement);
  return output;
}
