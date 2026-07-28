# 行政区划数据集（vendored 快照）

| 项 | 值 |
| --- | --- |
| 数据集 | [china-division](https://www.npmjs.com/package/china-division)（民政部县以上行政区划数据的开源整理，即 geo 域文件头所称 "lcn" 来源） |
| 版本 | 2.7.0 |
| 获取方式 | npm registry tarball `package/dist/{cities,areas}.json` 原样落盘 |
| 获取日期 | 2026-07-28 |
| cities.json | 342 条地级记录，sha256 `3f569aaa0bfbeba72f1597657511c64f54107baae71710fef7146f390a41af32` |
| areas.json | 2978 条县级记录，sha256 `fbe1575eecba4ffd4d50c3d2d6887bd873ceca6a203fb2d66698b5007826b6b6` |

## 更新流程

1. 下载新版数据集，替换本目录两个 JSON（保持原样，不做任何手改）；
2. 更新本 README 的版本/日期/sha256；
3. `pnpm run geo:generate` 重新生成 `src/resolution/geo/administrative-division.generated.ts`；
4. `pnpm run geo:validate` 通过（含与人工策展表的一致性、条目数异常增减检查）后一并提交。

生成产物与数据集的对应关系由 geo:validate 的漂移校验强制：只改数据集不重新生成、
或手改生成产物，CI 会失败（geo-domain-refactor-plan §9.3/§9.4）。
