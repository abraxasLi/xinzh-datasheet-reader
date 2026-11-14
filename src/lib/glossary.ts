export type GlossaryEntry = { term: string; english: string; chinese: string; aliases: string[] };

export const embeddedGlossary: GlossaryEntry[] = [
  { term: "GPIO", english: "General-purpose input/output", chinese: "通用输入/输出端口；参考手册通常说明 GPIO 配置与复用功能", aliases: ["gpio", "io口", "通用输入输出", "模块引脚", "模块的引脚", "引脚", "io引脚", "pin"] },
  { term: "RCC", english: "Reset and clock control", chinese: "复位和时钟控制", aliases: ["rcc", "复位时钟", "时钟控制", "复位控制"] },
  { term: "NVIC", english: "Nested vectored interrupt controller", chinese: "嵌套向量中断控制器", aliases: ["nvic", "中断控制器", "中断优先级", "中断"] },
  { term: "SysTick", english: "System tick timer", chinese: "系统滴答定时器", aliases: ["systick", "系统滴答", "滴答定时器", "系统定时器"] },
  { term: "USART", english: "Universal synchronous/asynchronous receiver/transmitter", chinese: "通用同步/异步收发器", aliases: ["usart", "串口", "串行通信"] },
  { term: "SPI", english: "Serial peripheral interface", chinese: "串行外设接口", aliases: ["spi", "串行外设", "串行接口"] },
  { term: "I²C", english: "Inter-integrated circuit", chinese: "集成电路间总线", aliases: ["i2c", "i²c", "两线总线", "集成电路间"] },
  { term: "DMA", english: "Direct memory access", chinese: "直接存储器访问", aliases: ["dma", "直接存储器访问", "搬运数据"] },
  { term: "ADC", english: "Analog-to-digital converter", chinese: "模数转换器", aliases: ["adc", "模数转换", "模拟数字转换"] },
  { term: "TIM", english: "Timer", chinese: "定时器/计数器", aliases: ["tim", "定时器", "计数器", "预分频"] },
  { term: "EXTI", english: "External interrupt/event controller", chinese: "外部中断/事件控制器", aliases: ["exti", "外部中断", "外部事件"] },
  { term: "AFIO", english: "Alternate function I/O", chinese: "复用功能输入/输出控制器", aliases: ["afio", "复用功能", "重映射"] },
  { term: "Flash", english: "Flash memory", chinese: "闪存", aliases: ["flash", "闪存", "程序存储器"] },
  { term: "IWDG", english: "Independent watchdog", chinese: "独立看门狗", aliases: ["iwdg", "独立看门狗", "看门狗"] },
  { term: "WWDG", english: "Window watchdog", chinese: "窗口看门狗", aliases: ["wwdg", "窗口看门狗"] },
  { term: "pinout", english: "Pin assignment / pinout", chinese: "器件封装引脚分配图", aliases: ["pinout", "引脚图", "管脚图", "封装引脚", "引脚定义", "模块引脚"] },
  { term: "pin", english: "Pin", chinese: "引脚；芯片与外部电路连接的端子", aliases: ["pin", "引脚", "管脚", "脚位"] },
  { term: "alternate function", english: "Alternate function", chinese: "复用功能；GPIO 引脚承担的外设功能", aliases: ["alternate function", "复用功能", "引脚复用"] },
  { term: "register", english: "Register", chinese: "寄存器；用于配置或读取外设状态的存储单元", aliases: ["register", "寄存器", "控制寄存器"] },
  { term: "bit field", english: "Bit field", chinese: "位域；寄存器中一组具有特定含义的位", aliases: ["bit field", "位域", "寄存器位", "标志位"] },
];

export function matchGlossary(question: string) {
  const normalized = question.toLowerCase().replace(/[\s_-]+/g, " ");
  return embeddedGlossary.filter((entry) => entry.aliases.some((alias) => normalized.includes(alias.toLowerCase())) || normalized.includes(entry.term.toLowerCase())).slice(0, 5);
}
