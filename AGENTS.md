# 项目协作说明

## 项目位置

- 当前工作区：`D:\tool\芯片手册翻译器`（这是唯一有效副本）。
- 旧原型在 `C:\Users\32700\Documents\ChatGPT\英文数据手册问答助手`，只作为来源参考；不要在那里继续开发。
- 交接先读：本文件 → `outputs/项目记忆.md` → `outputs/计划分析与修订建议.md`。

## 产品边界

- 面向不懂英文的嵌入式初学者，只做两件事：中文搜索并在 PDF 原文定位高亮；原文跟随式上下文翻译。
- 不做通用聊天机器人，不把 PDF 文件发云端问答，不做 Acrobat 插件。（搜索会联网发送手册文字片段，规则见下。）
- 最终目标是双击可运行的 Windows 阅读器；网页只是开发验收形态。
- RM0008 是 Reference Manual，不是具体型号 Datasheet；不得用外设配置推断封装引脚或电气参数。

## 翻译规则

- 默认引擎是本机离线模型（Argos en→zh 1.9 + CTranslate2），不依赖网络，不需要密钥；模型包由用户自己从官方地址下载后在本机安装。
- **可选在线引擎（智谱 GLM）默认关闭**。只有用户在译读面板里主动把「引擎」切到「在线（智谱）」时，才把**当前段落文本**发到 bigmodel.cn；PDF 文件、文件名和其他内容不上传。界面必须在该模式下常驻提示"本段会发送到智谱"。
- 在线 key 只从本机 `.zhipu-key` 文件或 `ZHIPU_API_KEY` 环境变量读取，**不得写入前端、不得打包进安装包、不得出现在日志里**。
- 界面必须始终能区分：原文、机器译文（本机/在线）、术语辅助。**不得把词典输出说成整段翻译。**
- 寄存器名、位名、地址、数值和单位必须在送入模型前做占位保护，译后还原；未还原的占位符要显示出来，不能静默吞掉。
- 离线模型许可只核到包内 README（原始 OPUS 模型 CC-BY 4.0）；分发前必须单独核对模型与训练数据条款。在线服务的使用条款由用户账号承担。

## 搜索规则

- **默认搜**：快，2–4 秒，大模型现场猜，给三行中文证据卡。
- **精确搜**（搜索框旁「精确搜索」开关，默认关）：慢，5–10 秒，大模型多想一步、多验一步——多取几段、多排一次序、再核对一次寄存器名和页码，再给答案；适合默认那个猜得不准的时候。打开后显示“正在仔细想…”。
- 两种都联网、都由大模型判断，区别只是想多久。**精确搜不是本地按字找，不走 `/api/ask`**；`/api/ask` 只在在线索引还没建好或建不了时，作为默认搜的临时退路，并在结果面板上标明“本地按字找”。
- 联网发送的内容：打开手册时把整本手册的文字片段发到硅基流动（api.siliconflow.cn，BGE-M3 embedding）建索引；每次搜索把问题和命中的手册片段发到硅基流动与智谱（open.bigmodel.cn，查询改写、重排、证据卡）。PDF 文件本身和文件名不上传。打开手册后界面必须常驻提示发送对象。
- 搜索的 key 只从本机 `.siliconflow-key`（也认 `.siliconflow-key.txt`）/ `SILICONFLOW_API_KEY` 和 `.zhipu-key` / `ZHIPU_API_KEY` 读取，规则同在线翻译：不进前端、不进安装包、不进日志。
- 向量库是本机 Chroma，数据在 `./chroma_db`，一本手册一个 collection，换手册即删旧建新。
- **不得针对样本手册写死寄存器名、页码或答案**；排序、切段、查询改写都必须是通用规则，换一本手册重建索引就能搜。RM0008 只当验收样本，判分标准只能写在 `tools/` 的验收脚本里，不进 `src/`。
- `XINZH_SEARCH_DEBUG=1` 时接口会多返回改写词与命中明细，并允许按请求切换大模型（仅用于横向对比）；默认不开。

## 已知技术与环境坑

- **Next.js 的 fork/IPC 会被受限环境拦截**（`spawn EPERM`）：用 `node node_modules\next\dist\bin\next dev` 启动；`npm run dev` 会失败。构建同理，需要时可临时放开权限。
- **CTranslate2 / SentencePiece 打不开非 ASCII 绝对路径**：翻译服务先 `chdir` 到模型父目录，再传相对路径。
- 模型下载走境外源很慢，用 `tools\pget.mjs` 多连接分段下载（约 250–300 KiB/s）。
- 沙箱里 `pip install` 会因临时目录权限失败；运行时用 `tools\setup-runtime.ps1` 解包 wheel 到 `.runtime/`。
- Chroma 装在 `.runtime/chroma`（`pip install chromadb --target .runtime/chroma -i https://pypi.org/simple`；清华镜像没有 chromadb）。由 Node 按需拉起本机 Chroma 服务（随机端口，只听 127.0.0.1）。
- Chroma 进程被强行结束后 HNSW 索引可能损坏（报 `Error loading hnsw index`）；建索引时会先验证，坏了自动删掉该 collection 重建。
- 本机内存紧张时 Claude Code 会结束后台的开发服务，结束后需要手动重新启动。
- 用脚本改 TS 源码时注意 Python 字符串里的 `\b` 会变成退格字符，曾导致正则静默失效；改完用 `grep -P '\x08'` 自查。

## 交付与记录

- 每轮改动都要留可复核的证据：`outputs/` 下的验收记录、`outputs/screenshots/` 下的浏览器截图、命令与实际数值。
- 不提交密钥、用户 PDF、模型权重；`.gitignore` 已排除 `.runtime/`、`models/`、`.samples/`、`.wheels/`、`.tmp/`、`chroma_db/`、`.zhipu-key`、`.deepl-key`、`.siliconflow-key*`。
- 未真实验收的能力（EXE、表格翻译、跨手册泛化）必须标为未完成。
