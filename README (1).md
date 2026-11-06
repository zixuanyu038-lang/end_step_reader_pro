# Endstep Studio

在 Codex 中使用的万智牌复盘工作台：先通看整盘找节点，用 Forge 搜索比较，再根据真实执行证据写复盘。选择节点，用中文描述新打法，即可生成含隐藏信息假设的 Endstep 分支。所有牌名保留完整英文。

当前是 **Windows x64 实验预览版**，由个人开发，与 Endstep 官方无隶属关系。模型调用遵循已登录 Codex 账户的额度与使用条件。

## 仓库怎么读

完整的逐文件说明见 **[代码导览](code-guide.md)**：覆盖发布目录中的每个文件，解释主要函数、类、代码块、调用关系和修改入口。

| 部分 | 主要文件 | 做什么 |
| --- | --- | --- |
| 页面与战报 | `index.html`、`style.css`、`app.js`、`replay.js` | 导入记录，还原局面，阅读和导出 |
| 复盘交互与任务 | `studio.js`、`studio-server.js`、`codex-client.js` | 选择节点、提交任务、连接本机 Codex |
| 牌表与根局面 | `match-decks.js`、`deck-service.js`、`search-source.js`、`hidden-worlds.js` | 还原组成，固定换备，构造并审计隐藏世界 |
| 搜索与判断 | `search-review.js`、`search-branch.js`、`tree-search.js`、`winning-lines.js` | 调度搜索，筛胜局，由 AI 判断教学价值 |
| 规则与回放 | `forge-client.js`、`forge/EngineWorker.java`、`forge-replay.js` | 执行规则，将认可轨迹写成 Endstep 回放 |
| 兼容、工具与测试 | `branch*`、`engine.js`、`scenario.js`、`forge/`、`tests/` 等 | 保留旧协议，安装运行时，验证格式与执行边界 |

推荐阅读顺序：`studio-server.js → search-review.js → tree-search.js → forge/EngineWorker.java → winning-lines.js → forge-replay.js`。旧手动分支与账本已在导览中单独标出。

## 0.4.1 更新

- 默认官方账号连接使用持久的本机 App Server 进程和 HTTP/SSE 请求路径，避开本机实测反复超时的 WebSocket 握手；沿用已登录账号、模型与推理强度，不修改全局配置。检测到自定义提供方或网关时保留其配置。`CODEX_TRANSPORT=auto` 可恢复 Codex 原传输选择，`http` 可显式使用官方账号 HTTP 路径。
- 内置 381 份去重的 Legacy 赛事参考列表。本地先匹配公开牌，AI 只选择候选 ID、类型和依据；没有合理候选再联网。仍只固定一份推定牌表，不能将参考列表当成对手真实牌表。
- 重试提示区分连接中断、限流和上游错误；推理或网页搜索恢复活动时立即清除旧提示。任务目录新增脱敏的 `model-requests.jsonl` 和完整 `progress.jsonl`。
- 搜索结果新增每节点和每世界耗时，便于分开测量 MCTS 与模型等待；本次没有调整搜索预算。

## Windows 启动

需要 Node.js 22+ 和已登录的 Codex。无需安装 npm 运行依赖、无需额外填写 API Key；模型与额度沿用本机 Codex 配置，页面显示实际模型和推理强度。

1. 首次双击 `安装Forge.cmd`：从官方 GitHub 下载固定版本 Temurin JDK17 与 Forge2.0.15，校验 SHA-256 后解压到 `%LOCALAPPDATA%\EndstepForgeProbe`，约490MB，不修改系统Java。
2. 双击 `启动复盘.cmd`，打开 `http://127.0.0.1:8787/`。也可在 Codex 中说“把这个地址打开在右侧面板”。
3. 导入 `.esreplay` 或原始 JSONL，点「生成整盘复盘」。文件窗口显示全部文件，直接选择 Endstep 导出的原始文件即可，无需改名或先转换。完成后选节点、描述打法，点「提炼新打法」预演，或直接「补全并重演」。
4. 下载 `.esreplay`，在 [Endstep 本地回放](https://endstep.cc/replay/local) 选择文件。

更新源码后双击 `重启复盘.cmd` 加载新版后端，再刷新页面。重启器会核对进程属于当前安装路径；发现运行中的任务时拒绝重启，先等任务完成或在页面中停止它。

也可运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`；开发启动用 `npm start`。`CODEX_BIN` 可指定Codex路径，`PORT` 可改端口。双击HTML只支持离线阅读，不能调用后端。这是本地软件，不是Codex原生扩展。

## 牌表与换备

先读取整个replay公开信息，固定一份推定牌表。能恢复的己方完整主备牌与实际换备优先使用。对手参考列表优先从本地赛事库按已见牌及数量匹配，AI 只从候选 ID 中选择；没有合理候选时才联网找相近公开列表，后端独立下载核对来源哈希。没有看到的牌保持未知，不当作排除证据。公开数量与参考列表不一致的灵活位明确标注推定调整。

内置数据的来源和范围见 [data/README.md](data/README.md)。在项目目录运行 `npm run update:decks` 可更新本机参考库；这个命令只同步公共数据，不调用模型，不上传用户回放。同步需要访问 GitHub，失败保留原库，不阻塞已有本地数据的查询。

换备是独立AI任务，输入双方完整主备牌、先后手和该局公开数量约束。允许联网查换备指南，也可自行推理；使用网页时要求在理由中给真实链接。成对换入换出由程序核对实体数量。己方实际方案保留为事实，AI建议供对照；对手推定换备固定用于对应局搜索，不随节点改变。

牌表是事后还原；搜索不照抄原局未来手牌、抓牌顺序或行动。每节点使用三组固定手牌/库序，保留当时已知库顶；可含明确构造的交互压力情景，不是概率样本。

整盘耗时随节点数、机器性能与模型连接变化。本机一次8节点整盘实测约31分钟，单节点意图搜索及AI二筛约5分钟；这不是速度承诺。读取已有结果及下载已保留的回放无需重新搜索。进度按节点、世界显示；取消可停止工作。已完成证据与诊断保留在本机。

## 实际边界

- 每次模拟重建已审计根，再让Forge重放路径；不使用已证实丢抓牌历史的GameCopier，不以旧AI账本兜底。
- 有限预算的对抗UCT，枚举部分施法、异能、下地、模式/目标及pass。叶子用Forge策略继续到终局或预算边界，胜/负奖励为+1/−1，未终局仅用小幅材料启发值。每次模拟不调用AI；候选并非穷尽，支付、战斗与部分选择沿用Forge策略。
- 各隐藏世界独立搜索，尚非完整信息集搜索；内置策略隐藏信息使用未全面审计，有determinization/strategy-fusion偏差。材料评分不是胜率，不能证明最优。
- 根核对生命、可见区域/身份、牌数、横置、伤害、指示物、PT、命名、抓牌/下地/施法历史与已知库顶。支持普通堆叠法术与部分常见衍生物。
- 附件、部分持续效果/徽记、堆叠异能、战斗声明、地下城、昼夜等未覆盖起点会拒绝搜索并列缺口；不能宣称所有机制都已恢复。
- 先按引擎胜负筛出胜局，再集中交AI二筛：与同一固定世界的原打法比较，判断是否更稳、优势更明确、值得指导原局。不是所有胜局都保留，更不为了赢而换牌。预算内没有胜局或AI不认可改善，就不给推荐回放。
- 自然语言变为受限玩法目标，Forge决定时机、费用、响应及后续。目标完成、引擎获胜、AI认可并且动作/终局能一致重放后才提供下载。失败与未完路线只保留私有诊断。
- 回放来自真实引擎轨迹，保留源前缀、截断原局未来，注明来源、种子、假设和范围。gzip/JSONL重读通过后导出。当前样本已通过Endstep官方解码器并在网站加载棋盘、跳到引擎终局；这不代表所有牌或策略均已验证。

## 数据与开发

服务只监听127.0.0.1，检查Host、会话及写请求来源。对局、模型输入、诊断、复盘和输出在 `.endstep-data/`，已忽略，不要发布到GitHub。复盘资料通过Codex发给模型；检索访问公开网页。后端不读取或复制Codex凭据。`jobs/<任务ID>/model-requests.jsonl` 记录模型排队、实际请求时长、错误类型/HTTP 状态、重试和恢复；不记录原始推理或认证信息。`progress.jsonl` 保留完整阶段时间线，页面中的最近进度仍限制为100条。

原HTML、Markdown、TXT、原始JSONL和结构化JSON导出全部保留。`npm run build` 生成无用户对局的离线阅读页。旧手动协议和账本仅兼容旧文件，不是当前生成主流程。

```powershell
npm test
npm run test:forge
```

第二项是真实Forge自检，不调用AI。可设置 `REPLAY_SAMPLE` 跑私有样本回归，`ENDSTEP_DECODER` 校验缓存官方解码器。HTTP替身只验证传输，不能当模型/规则质量证明。

模块见 [studio-architecture.md](studio-architecture.md)。官方依据：[Forge](https://github.com/Card-Forge/forge)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 搜索](https://learn.chatgpt.com/docs/web-search)。
