# DeepL 接入说明

日期：2026-11-13
状态：**代码已接入，未用真实 key 验收**（需要你自己的 DeepL key）。

## 怎么申请

1. 打开 https://www.deepl.com/pro-api ，选 **DeepL API Free**（每月 50 万字符，个人用足够）。
2. 注册时要绑定支付方式做身份验证（Free 计划不扣费，但部分地区要求填卡）。
3. 登录后在账号页复制 **Authentication Key**：
   - Free 计划的 key **以 `:fx` 结尾**；
   - Pro 计划的 key 不带 `:fx`。
4. 两者走不同端点，代码会自动判断：
   - Free → `https://api-free.deepl.com/v2/translate`
   - Pro → `https://api-prod.deepl.com/v2/translate`

## 怎么配到本项目

把 key 写进工作区文件（已加入 `.gitignore`，不会进仓库）：

```powershell
Set-Content -Path "D:\tool\芯片手册翻译器\.deepl-key" -Value "你的key:fx" -NoNewline
```

或者用环境变量 `DEEPL_API_KEY`。

## 怎么测

```powershell
cd D:\tool\芯片手册翻译器
$env:Path="C:\Users\32700\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;$env:Path"
node tools\deepl-check.mjs
```

输出 `✅ 可用（xxx ms）：该 ADC 时钟不得超过 14 MHz。` 就说明 key 有效。

然后在应用里：译读面板「引擎」选 **在线（DeepL）**。面板顶部会显示把文字发往哪个域名、Free 还是 Pro。

## 实现要点

- `src/lib/translation/deepl.ts`：`POST /v2/translate`，`target_lang=ZH`、`source_lang=EN`、`preserve_formatting=true`；DeepL 原生支持一次传多段文本，所以「前后文/当前页」也是一次请求。
- `/api/translate` 的 `provider` 支持 `offline | online（智谱） | deepl`；没配 key 时返回 409 并提示写 key，不会静默回退（避免你以为在用离线、其实发出了网络请求）。
- 占位保护照旧：寄存器名/地址/数值先换成 `[[Zn]]`，`preserve_formatting` 能进一步降低占位符被改写的概率；译文出来后仍走术语校正和重复退化拦截。

## 三种引擎对比（基于已测数据）

| | 本机 Argos | 智谱 glm-5.3-flashx | DeepL |
| --- | --- | --- | --- |
| 费用 | 免费 | 免费额度（限流严重） | 50 万字符/月免费，超出付费 |
| 速度 | 60–150 ms/段 | 批量 3 段约 5.4 s | 未测（通常 0.5–2 s/段） |
| 通用中文 | 差（登记器/标针/坦佩尔） | 较好 | **最好** |
| 芯片术语 | 靠占位+校正 | 靠提示词+校正 | 仍需术语校正 |
| 隐私 | 完全本机 | 段落发到 bigmodel.cn | 段落发到 deepl.com |
| 离线可用 | 是 | 否 | 否 |

结论：**日常阅读用 DeepL（质量）或本机（离线/隐私），智谱当兜底**。无论哪条路，寄存器名/地址/数值都靠占位保护兜住，不依赖模型自觉。

## 注意

- DeepL 有每月额度，界面不会实时显示剩余字符；额度用完会返回 456/429，代码会把错误原样提示出来。
- DeepL 的隐私条款与国内平台不同：发送的是当前段/选中段，不含 PDF 文件；但如果你处理的是保密手册，建议只用本机引擎。
- 这个 key 和智谱 key 一样，只存在本机文件里，不进前端、不进安装包、不进日志。

## 实测验收（2026-11-14，真实 key）

`.deepl-key` 已配置（Free，`:fx` 结尾），`node tools/deepl-check.mjs` 返回：

```
✅ 可用（1967 ms）：ADC时钟频率不得超过14 MHz。
```

### 质量对照（同一批 RM0008 段落）

| # | 原文要点 | DeepL | 本机 Argos |
| --- | --- | --- | --- |
| 1 | write-only / value is undefined | 这些位仅支持写入（读取时，其值未定义） | 这些位值是只写(读取时,数值是未定义的) |
| 2 | must not exceed 14 MHz | 不得超过 14 MHz，采样时间 1.5 us | 不得超过14 MHz,取样时间为1.5 us |
| 3 | spurious Tamper event | 可能触发虚假的**篡改**事件 | 产生一个虚假的**坦佩尔**事件 |
| 4 | backup registers / regulator | 嵌入式**稳压器**；工作电压电源 | 嵌入式**调节器**；运行电压供给 |

占位保护在 DeepL 上同样生效：`[[Zn]]` 全部还原，4 段里没有未还原占位符。

### 速度

- DeepL 原生批量：4 段一次请求 **1.7 秒**；
- 浏览器实机单段（含冷启动）：**4.2 秒**；
- 本机 Argos：4 段 0.58 秒（快，但质量差）。

### 浏览器验收

引擎下拉切到「在线（DeepL）」后，面板顶部显示“当前段落文字会发送到 DeepL（api-free.deepl.com，Free（每月 50 万字符））”，译文正常、无控制台报错。截图：`outputs/screenshots/15-deepl-translate.png`。

## 建议

- **保密手册**：仍用本机离线；
- **日常阅读**：DeepL（质量最好）；
- **限流/断网**：智谱兜底。
