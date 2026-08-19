# 岗位召回链路现状

**最后更新**：2026-08-13（自 job-recall 方案 §1 现状盘点迁入，方案其余部分未落地已删）

## 现状

岗位数据无本地存储，每次查询实时调海绵网关（`src/sponge/sponge.service.ts` 的
`fetchJobs`，`POST {SPONGE_API_BASE_URL}/ai/api/job/list`）。查询参数：
`cityNameList` / `regionNameList` / `brandAliasList` / `storeNameList` /
`searchJobName` / `jobIdList` / `location{longitude,latitude,range}` / `onlySignableJobs`，
分页返回 `jobs + total`。（`jobCategoryList` 已不再下传 API——模型猜的工种词与海绵
类目字典对不上、精确匹配基本落空，改为召回后本地软排序。）

召回智能全部在查询参数构造层（`src/tools/duliday/job-list/search.util.ts` 等）：

- **品牌**：`brandAliasList` 精确/子串匹配，0 命中时拼音模糊回指
  （`brand-fuzzy-match.util.ts`，拼音重叠 ≥0.5）；
- **品类词**（"咖啡"）：人工维护的品类→品牌清单展开（目前仅咖啡品类启用）；
- **工种**：不下传 API，召回后 `rankJobsByRequestedCategories` 按
  `scoreJobAgainstRequestedCategories`（完全相等 +10 / 包含 +6 / 字符重叠 +2）做
  本地软排序（匹配岗位排前、不过滤），无同义词能力；
- **门店**：`storeNameList` 是 API 侧精确匹配；`searchJobName` 整名模糊匹配是
  按门店/地标找岗的首选（jobName 形如「品牌-门店-工种-用工形式」）；
- **距离**：geocode 得坐标 → 带 `location` 扫最多 10 页 × 20 = 200 条，页序非
  服务端距离排序。

## 已知缺口（backlog，未立项）

| # | 缺口 | 后果 |
|---|------|------|
| G1 | 语义/同义鸿沟："想找做咖啡的""有没有骑手的活"无法映射到品牌/工种，除非人工品类表恰好覆盖（品类表仅咖啡启用；工种评分无同义词库） | 有岗说没岗，候选人流失 |
| G2 | 门店名对不上：企微备注/口述门店名与后台不一致时 `storeNameList` 精确匹配 0 结果（裁定：备注门店名慎用，优先品牌+region 召回） | 兜底靠本地子串，覆盖有限 |
| G3 | 密集城市距离截断：单城市在招 >200 条时 10 页扫描可能漏掉真正最近的门店 | "附近没岗"假阴性 |
| G4 | 品牌口误超出拼音容错：错字/简称/旧名超出拼音重叠 0.5 的能力半径 | 误判"该品牌没岗" |

四个缺口的共性：都是召回问题（找不到），不是事实问题（说错了）。历史上的混合检索
方案（本地索引+向量）经评审未立项——设计红线是"索引只做召回、不做事实源"，如重启
立项须从该红线出发（原方案见 git 历史 `docs/todo/job-recall-hybrid-retrieval-plan.md`）。
