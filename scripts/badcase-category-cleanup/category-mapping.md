# BadCase「分类」清洗映射提案

总记录 3795，有分类值的取值种类 174。

## 迁移后分布

| 新分类 | 记录数 |
| --- | ---: |
| 3-就近岗位推荐 | 2388 |
| 7-预约、取消与改期 | 402 |
| 5-岗位详情、薪资与福利 | 271 |
| 2-品牌与门店识别 | 220 |
| 15-其他 | 172 |
| 1-地区、城市与位置识别 | 133 |
| 9-无岗承接与拉群 | 74 |
| 4-岗位条件与班次匹配 | 70 |
| 11-图片与上下文理解 | 31 |
| 6-报名与收资 | 18 |
| 1-不该触达（工单/条件误判） | 3 |
| 12-内部术语与异常输出 | 2 |
| 13-敏感条件与合规表达 | 2 |
| 14-人工/非Agent归因 | 1 |

## 逐值映射（按记录数降序）

| 原值 | 记录数 | → 新值 | 依据 |
| --- | ---: | --- | --- |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 668 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 494 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported | 399 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 206 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| job_detail_lookup_required | 206 | 5-岗位详情、薪资与福利 | 守卫规则 job_detail_lookup_required |
| 3-岗位推荐-范围/门店/距离 | 127 | 3-就近岗位推荐 | 旧主聊分类 |
| 6-预约/收资流程 | 116 | 7-预约、取消与改期 | 旧主聊分类 |
| 13-其他 | 94 | 15-其他 | 旧主聊分类 |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict | 87 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 87 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict | 84 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| district_level_distance_claim | 77 | 1-地区、城市与位置识别 | 守卫规则 district_level_distance_claim |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 69 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| 4-岗位推荐-条件/班次不匹配 | 65 | 4-岗位条件与班次匹配 | 旧主聊分类 |
| 11-情绪/话术 | 60 | 15-其他 | 旧主聊分类 |
| 2-地区/位置/距离 | 55 | 1-地区、城市与位置识别 | 旧主聊分类 |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 54 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| 5-岗位详情/薪资/福利口径 | 42 | 5-岗位详情、薪资与福利 | 旧主聊分类 |
| 9-拉群/无岗维护 | 39 | 9-无岗承接与拉群 | 旧主聊分类 |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 38 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, ac… | 34 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| group_promise_without_invite | 34 | 9-无岗承接与拉群 | 守卫规则 group_promise_without_invite |
| semantic_review:brand_or_geo_ambiguity_ignored | 32 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 32 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| 1-品牌/门店识别 | 28 | 2-品牌与门店识别 | 旧主聊分类 |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 22 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, active_booking_state_conf… | 22 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored | 22 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| 7-已约面/改期/入职跟进 | 19 | 7-预约、取消与改期 | 旧主聊分类 |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 18 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| settlement_cycle_mismatch | 18 | 5-岗位详情、薪资与福利 | 守卫规则 settlement_cycle_mismatch |
| semantic_review:(no findings) | 17 | 15-其他 | 语义审查无发现 |
| ungrounded_job_recommendation | 16 | 3-就近岗位推荐 | 守卫规则 ungrounded_job_recommendation |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 16 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 14 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 14 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 14 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 13 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 13 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| 10-图片/证件识别 | 12 | 11-图片与上下文理解 | 旧主聊分类 |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 12 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| tool_failure_success_claim | 12 | 7-预约、取消与改期 | 守卫规则 tool_failure_success_claim |
| 8-多消息/引用/上下文承接 | 10 | 11-图片与上下文理解 | 旧主聊分类 |
| semantic_review:active_booking_state_conflict, job_recommendation_not_best_suppo… | 10 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, ac… | 10 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| identity_misregistration_coaching | 10 | 6-报名与收资 | 守卫规则 identity_misregistration_coaching |
| image_description_not_saved | 9 | 11-图片与上下文理解 | 守卫规则 image_description_not_saved |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 9 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| booking_form_field_mismatch | 8 | 6-报名与收资 | 守卫规则 booking_form_field_mismatch |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 7 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 7 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 6 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 6 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 6 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 5 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 5 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 4 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| precheck_blocked_booking_claim | 4 | 7-预约、取消与改期 | 守卫规则 precheck_blocked_booking_claim |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 4 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 4 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, active_booking_state_conflict | 3 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, br… | 3 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 3 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:active_booking_state_conflict, brand_or_geo_ambiguity_ignored | 3 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, active_booking_state_conf… | 3 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 3 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| wait_notice_time_fabrication | 3 | 7-预约、取消与改期 | 守卫规则 wait_notice_time_fabrication |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 3 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 3 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 3 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| requested_brand_mismatch | 3 | 2-品牌与门店识别 | 守卫规则 requested_brand_mismatch |
| 1-不该触达（工单/条件误判） | 3 | （不变） | 复聊分类，保留 |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, job_recommendation_not_best_suppo… | 2 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, active_booking_state_conf… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 2 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 2 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, active_booking_state_conf… | 2 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| internal_output_leak | 2 | 12-内部术语与异常输出 | 守卫规则 internal_output_leak |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 2 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 2 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 2 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 2 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| quota_promise | 2 | 5-岗位详情、薪资与福利 | 守卫规则 quota_promise |
| summer_worker_alternative_upsell | 2 | 4-岗位条件与班次匹配 | 守卫规则 summer_worker_alternative_upsell |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 2 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| discriminatory_screening_leak | 2 | 13-敏感条件与合规表达 | 守卫规则 discriminatory_screening_leak |
| job_detail_lookup_required, requested_brand_mismatch | 2 | 5-岗位详情、薪资与福利 | 守卫规则 job_detail_lookup_required |
| unsupported_schedule_window_claim | 2 | 4-岗位条件与班次匹配 | 守卫规则 unsupported_schedule_window_claim |
| 12-人工/非Agent归因 | 1 | 14-人工/非Agent归因 | 旧主聊分类 |
| semantic_review:job_recommendation_not_best_supported, active_booking_state_conf… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, job_recommendation_not_best_suppo… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:brand_or_geo_ambiguity_ignored, active_booking_state_conflict, j… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, brand_or_geo_ambiguity_ignored, a… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:active_booking_state_conflict, job_recommendation_not_best_suppo… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| brand_name_violation | 1 | 2-品牌与门店识别 | 守卫规则 brand_name_violation |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| group_promise_without_invite, image_description_not_saved | 1 | 9-无岗承接与拉群 | 守卫规则 group_promise_without_invite |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| ungrounded_job_recommendation, booking_form_field_mismatch | 1 | 3-就近岗位推荐 | 守卫规则 ungrounded_job_recommendation |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| confirmed_booking_time_missing | 1 | 7-预约、取消与改期 | 守卫规则 confirmed_booking_time_missing |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, ac… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| district_level_distance_claim, settlement_cycle_mismatch | 1 | 1-地区、城市与位置识别 | 守卫规则 district_level_distance_claim |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| salary_fabrication | 1 | 5-岗位详情、薪资与福利 | 守卫规则 salary_fabrication |
| job_shift_polarity_mismatch | 1 | 4-岗位条件与班次匹配 | 守卫规则 job_shift_polarity_mismatch |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, ac… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, active_booking_state_conflict, a… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, active_booking_state_conf… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, active_booking_state_conflict, b… | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, ac… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, job_recommendation_not_best_supp… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, active_booking_state_conflict, j… | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, brand_or_geo_ambiguity_ig… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, jo… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:brand_or_geo_ambiguity_ignored, brand_or_geo_ambiguity_ignored, … | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:active_booking_state_conflict, brand_or_geo_ambiguity_ignored, b… | 1 | 2-品牌与门店识别 | 语义审查多数 finding=brand_or_geo_ambiguity_ignored |
| semantic_review:active_booking_state_conflict, active_booking_state_conflict, ac… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:job_recommendation_not_best_supported, job_recommendation_not_be… | 1 | 3-就近岗位推荐 | 语义审查多数 finding=job_recommendation_not_best_supported |
| semantic_review:brand_or_geo_ambiguity_ignored, active_booking_state_conflict, a… | 1 | 7-预约、取消与改期 | 语义审查多数 finding=active_booking_state_conflict |
| PR619回归测试 | 1 | 15-其他 | 旧主聊分类 |