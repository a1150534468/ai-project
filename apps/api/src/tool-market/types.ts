export type CategoryKey =
  | 'productivity-tasks'
  | 'web-frontend-development'
  | 'search-research'
  | 'coding-agents-ides'
  | 'devops-cloud'
  | 'browser-automation'
  | 'pdf-documents'
  | 'data-analytics'
  | 'speech-transcription'
  | 'security-passwords'
  | 'image-video-generation'
  | 'git-github'
  | 'clawdbot-tools'
  | 'finance'
  | 'communication'
  | 'health-fitness'
  | 'marketing-sales'
  | 'shopping-e-commerce'
  | 'notes-pkm'
  | 'transportation'
  | 'ai-llms'
  | 'media-streaming'
  | 'calendar-scheduling'
  | 'ios-macos-development'
  | 'smart-home-iot'
  | 'cli-utilities'
  | 'gaming'
  | 'moltbook'
  | 'agent2agent-protocols'
  | 'apple-apps-services'
  | 'personal-development'
  | 'self-hosted-automation';

export interface CategoryMeta {
  key: CategoryKey;
  label: string;
}

export const CATEGORIES: readonly CategoryMeta[] = [
  { key: 'productivity-tasks', label: '办公效率' },
  { key: 'web-frontend-development', label: '网页与前端开发' },
  { key: 'search-research', label: '搜索与信息研究' },
  { key: 'coding-agents-ides', label: '开发与编程' },
  { key: 'devops-cloud', label: '云服务与DevOps' },
  { key: 'browser-automation', label: '浏览器自动化' },
  { key: 'pdf-documents', label: 'PDF与文档处理' },
  { key: 'data-analytics', label: '数据分析' },
  { key: 'speech-transcription', label: '语音与翻译' },
  { key: 'security-passwords', label: '安全与密码' },
  { key: 'image-video-generation', label: '图像视频生成' },
  { key: 'git-github', label: 'Git代码仓库' },
  { key: 'clawdbot-tools', label: 'Openclaw扩展工具' },
  { key: 'finance', label: '金融与行情' },
  { key: 'communication', label: '社交与通讯' },
  { key: 'health-fitness', label: '健康生活' },
  { key: 'marketing-sales', label: '市场与销售' },
  { key: 'shopping-e-commerce', label: '电商购物' },
  { key: 'notes-pkm', label: '笔记与知识库' },
  { key: 'transportation', label: '交通出行' },
  { key: 'ai-llms', label: '大模型工具' },
  { key: 'media-streaming', label: '视频流媒体' },
  { key: 'calendar-scheduling', label: '日程管理' },
  { key: 'ios-macos-development', label: '苹果开发' },
  { key: 'smart-home-iot', label: '智能家居与IoT' },
  { key: 'cli-utilities', label: '命令行工具' },
  { key: 'gaming', label: '游戏娱乐' },
  { key: 'moltbook', label: 'Openclaw生态' },
  { key: 'agent2agent-protocols', label: '机器人间通讯' },
  { key: 'apple-apps-services', label: '苹果生态服务' },
  { key: 'personal-development', label: '个人开发' },
  { key: 'self-hosted-automation', label: '私有云助手' },
] as const;

export const CATEGORY_KEYS: readonly CategoryKey[] = CATEGORIES.map((c) => c.key);

export interface MarketSkill {
  id: string;
  name: string;
}
export interface MarketLegacySkill {
  name: string;
  url: string;
  desc: string;
}
export interface MarketGroup {
  label: string;
  skills: MarketLegacySkill[];
}
export interface MarketCategory {
  key: CategoryKey;
  label: string;
  total: number;
  skills: MarketSkill[];
  groups: MarketGroup[];
}
export interface MarketIndexEntry {
  key: CategoryKey;
  label: string;
  total: number;
}
