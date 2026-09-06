/**
 * 头像图标（Iconify 名字，前端用 `<Icon icon={...} />` 渲染）。
 *
 * 这里存的是**字符串名字**而不是 SVG：图标数据由前端的 Iconify 运行时按名字取，
 * 后端只负责说「用哪一个」。所以这些字符串必须是 mdi 集合里真实存在的名字，
 * 拼错不会报错，只会在界面上留一个空白方块。
 */

/** 用户自建 Agent 统一用这个。自建的没有固定语义，给一个「带星的人像」表示「你自己的」。 */
export const CUSTOM_AGENT_ICON = "mdi:account-star-outline";

/**
 * 81 个内置 Agent 的图标，**按 presets.md 里 `## N.` 标题的出现顺序排列**。
 *
 * ⚠️ 这个数组是靠下标和 presets.md 对齐的，没有任何一处代码校验它们是否真的对上
 * （见 presets.ts 的 `presetIconAt(idx)`）。所以：
 *
 * - 往 presets.md 中间插一个 Agent，会让它后面所有人的图标整体错位一格；
 * - 删一个同理。**两个文件必须一起改，而且只能往末尾追加。**
 *
 * 每行后面注掉的编号和名字就是为了让这件事能被肉眼核对 —— 它们不参与运行，
 * 而 presets.test.ts 会拿 presets.md 的真实标题把这份对齐关系钉住（数量相等 + 逐位相同）。
 */
export const PRESET_AGENT_ICONS = [
  "mdi:assistant", // 1. 默认助手
  "mdi:clipboard-text-outline", // 2. 产品经理
  "mdi:lightbulb-on-outline", // 3. 智能产品经理
  "mdi:account-group-outline", // 4. 社群运营
  "mdi:file-document-edit-outline", // 5. 内容运营
  "mdi:storefront-outline", // 6. 商家运营
  "mdi:rocket-launch-outline", // 7. 产品运营
  "mdi:bullhorn-outline", // 8. 市场营销
  "mdi:chart-box-outline", // 9. 商业数据分析
  "mdi:calendar-check-outline", // 10. 项目管理
  "mdi:magnify-scan", // 11. SEO 专家
  "mdi:chart-line", // 12. 网站运营数据分析
  "mdi:database-eye-outline", // 13. 数据分析师
  "mdi:language-javascript", // 14. 前端工程师
  "mdi:server-network-outline", // 15. 运维工程师
  "mdi:code-braces", // 16. 开发工程师
  "mdi:bug-check-outline", // 17. 测试工程师
  "mdi:account-tie-outline", // 18. HR 人力资源管理
  "mdi:briefcase-outline", // 19. 行政
  "mdi:cash-multiple", // 20. 财务顾问
  "mdi:stethoscope", // 21. 医生
  "mdi:pencil-outline", // 22. 编辑
  "mdi:brain", // 23. 哲学家
  "mdi:cart-outline", // 24. 采购
  "mdi:scale-balance", // 25. 法务
  "mdi:translate", // 26. 翻译成中文
  "mdi:book-open-page-variant-outline", // 27. 英语单词讲解助手
  "mdi:text-box-check-outline", // 28. 文章总结
  "mdi:account-search-outline", // 29. 招聘
  "mdi:emoticon-outline", // 30. 表情符号翻译
  "mdi:format-letter-case", // 31. 英文润色
  "mdi:microphone-outline", // 32. 会议摘要
  "mdi:presentation", // 33. PPT 教练
  "mdi:fire-circle", // 34. 爆款文案
  "mdi:movie-open-outline", // 35. 影视推荐
  "mdi:music-note-outline", // 36. 歌名母版
  "mdi:medal-outline", // 37. 面试达人
  "mdi:heart-outline", // 38. 爱情教练
  "mdi:account-voice", // 39. 面试模拟
  "mdi:comment-quote-outline", // 40. 观点提炼
  "mdi:file-account-outline", // 41. 简历撰写
  "mdi:comment-edit-outline", // 42. 评论创作
  "mdi:newspaper-variant-outline", // 43. 周刊专栏
  "mdi:tag-text-outline", // 44. 营销 Slogan
  "mdi:web", // 45. 网页生成
  "mdi:card-account-details-outline", // 46. 买家画像卡片
  "mdi:unicode", // 47. Unicode 字符转换
  "mdi:head-cog-outline", // 48. 心理模型专家
  "mdi:cube-outline", // 49. 概念模型开发者
  "mdi:account-heart-outline", // 50. 认知行为研究员
  "mdi:thought-bubble-outline", // 51. 分析性思维导师
  "mdi:truck-fast-outline", // 52. 供应链管理专家
  "mdi:target-account", // 53. 数字营销助手
  "mdi:palette-outline", // 54. 数字艺术创作助手
  "mdi:video-vintage", // 55. 虚拟导演
  "mdi:heart-pulse", // 56. 个性化健康顾问
  "mdi:account-question-outline", // 57. 虚拟顾问专家
  "mdi:graph-outline", // 58. 结构化组织分析专家
  "mdi:gamepad-variant-outline", // 59. 游戏社区经理
  "mdi:controller-classic-outline", // 60. 电子游戏评论员
  "mdi:gamepad-square-outline", // 61. 电玩商店选手
  "mdi:robot-outline", // 62. ChatGPT SEO 提示（正好和兜底图标同名，不是漏填）
  "mdi:ethereum", // 63. 以太坊开发人员
  "mdi:console", // 64. Linux 终端
  "mdi:alphabetical-variant", // 65. 英语翻译和改进者
  "mdi:account-tie-voice-outline", // 66. 面试官
  "mdi:microsoft-excel", // 67. Excel 精粹
  "mdi:volume-high", // 68. 英语发音助手
  "mdi:chat-processing-outline", // 69. 英语口语练习和改进者
  "mdi:map-marker-path", // 70. 旅游指南
  "mdi:shield-check-outline", // 71. 抄袭检查工具
  "mdi:drama-masks", // 72. 角色扮演
  "mdi:advertisements", // 73. 广告商
  "mdi:book-open-variant", // 74. 故事讲述者
  "mdi:school-outline", // 75. AI 写作导师
  "mdi:compass-outline", // 76. 人生教练
  "mdi:podium", // 77. 演讲学家
  "mdi:comment-text-multiple-outline", // 78. 评论员
  "mdi:creation-outline", // 79. 魔术师
  "mdi:briefcase-check-outline", // 80. 职业顾问
  "mdi:paw-outline", // 81. 宠物行为专家
] as const;

/** 名单之外的下标（presets.md 加了 Agent 但这里忘了补）落到这个通用机器人上，不留空白方块。 */
const FALLBACK_PRESET_ICON = "mdi:robot-outline";

/** 按下标取内置 Agent 的图标。越界不报错 —— 少一个图标不值得让整个 Agent 列表 500。 */
export function presetIconAt(index: number): string {
  return PRESET_AGENT_ICONS[index] ?? FALLBACK_PRESET_ICON;
}
