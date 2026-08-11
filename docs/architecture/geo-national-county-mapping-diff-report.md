# 全国县级市映射开关对照报告

> 日期：2026-08-11
> 范围：仅比较 `resolveParentAdministrativeArea` 在 `GEO_NATIONAL_COUNTY_MAPPING_ENABLED` 关闭/开启时的返回值。
> 纪律：本报告和配套 spec **没有修改默认值、环境文件或部署配置**；开启态仅存在于测试进程内，调用后立即恢复。

## 结论

- 28 个输入中，24 个由 `unresolved` 变为父级命中：23 个 `DEFERRED_COUNTY_BACKFILL` 待验证条目，以及全国表补充样本义乌市。
- 昆山市、延吉市在两态下结果一致，证明人工策展表仍优先且未被全国生成表改写。
- 上海市与未知值火星市在两态下都保持 `unresolved`，开关没有把普通地级市或未知名称误判为县级市。
- 本样本未出现“已命中变未命中”或“父级被改写”。但行政区映射正确不等于海绵供应商存储口径已经验证；本报告不构成开启开关的执行授权。

## 对照表

| 输入 | 开关关闭 | 开关开启 |
|---|---|---|
| 余姚市 | unresolved | 宁波市 |
| 慈溪市 | unresolved | 宁波市 |
| 太仓市 | unresolved | 苏州市 |
| 常熟市 | unresolved | 苏州市 |
| 张家港市 | unresolved | 苏州市 |
| 胶州市 | unresolved | 青岛市 |
| 莱西市 | unresolved | 青岛市 |
| 平度市 | unresolved | 青岛市 |
| 宜都市 | unresolved | 宜昌市 |
| 当阳市 | unresolved | 宜昌市 |
| 枝江市 | unresolved | 宜昌市 |
| 松滋市 | unresolved | 荆州市 |
| 洪湖市 | unresolved | 荆州市 |
| 石首市 | unresolved | 荆州市 |
| 监利市 | unresolved | 荆州市 |
| 麻城市 | unresolved | 黄冈市 |
| 武穴市 | unresolved | 黄冈市 |
| 新民市 | unresolved | 沈阳市 |
| 枣阳市 | unresolved | 襄阳市 |
| 宜城市 | unresolved | 襄阳市 |
| 老河口市 | unresolved | 襄阳市 |
| 瑞金市 | unresolved | 赣州市 |
| 龙南市 | unresolved | 赣州市 |
| 昆山市 | 苏州市 | 苏州市 |
| 延吉市 | 延边朝鲜族自治州 | 延边朝鲜族自治州 |
| 义乌市 | unresolved | 金华市 |
| 上海市 | unresolved | unresolved |
| 火星市 | unresolved | unresolved |

## 复现方式

```bash
pnpm exec jest tests/resolution/geo/national-county-mapping-diff.spec.ts --runInBand --no-watchman
```

配套 spec 从 `DEFERRED_COUNTY_BACKFILL` 读取待验证集合，分别在进程内关闭/开启开关后调用同一个 resolver，并校验本报告逐行覆盖实际结果。若待验证集合或生成表变化，测试会要求同步更新报告。
