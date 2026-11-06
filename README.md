# 本地赛事牌表库

`deck-catalog.json` 是公开赛事参考列表，不包含用户回放或从用户隐藏手牌推断的数据。

- 来源：[modometa/modometa-mtgo-data](https://github.com/modometa/modometa-mtgo-data)，上游原始赛事来源为 [Magic Online](https://www.mtgo.com/decklists)。
- 随 0.4.1 提供的快照：2026-11-06 下载，20 份近期 Legacy 赛事文件，381 份按主备牌组成去重的列表。它不覆盖全部类型，也不保证与某位对手完全相同。
- 快照保存上游提交版本、赛事日期、原始网址、文件 SHA-256；下载时还核对 Git blob SHA-1。整份列表另有完整性哈希。
- 快照只保留参考列表与来源，没有复制上游采集器或分类器代码。上游仓库自身的许可说明见 [LICENSE.md](https://github.com/modometa/modometa-mtgo-data/blob/main/LICENSE.md)。

应用在本地按已观察牌的数量下界和特征稀有度检索候选，再让 AI 选择一个现有 ID；看不到的牌不作负面证据。整盘公开事实可对参考灵活位作明确标记的推定修正。

## 更新

```powershell
npm run update:decks
```

默认同步最近两个月中最新的20份 Legacy 赛事文件，去重后写入 `.endstep-data/deck-catalog.json`。查询时合并内置和本机库。该命令只访问固定 GitHub 仓库，不调用 AI、不上传对局、不修改内置快照。GitHub 匿名请求有限额，达到限额时稍后再更新。

维护发布快照时，运行：

```powershell
node deck-catalog.js --output data/deck-catalog.json
```

发布时应同步更新本文的日期、文件数与列表数。
