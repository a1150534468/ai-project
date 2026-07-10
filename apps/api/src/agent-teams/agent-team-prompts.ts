export function buildTeamRecommendationPrompt(taskGoal: string): string {
  return [
    "根据用户任务创建一个可复用的 Agent 团队。",
    "只输出 JSON，不要 Markdown。",
    "团队成员必须 3 到 10 个。",
    "每个成员必须有 name、role、responsibility、systemPrompt、skills、isCore。",
    "systemPrompt 必须是中文，可直接作为该 Agent 的系统提示词。",
    "",
    `用户任务：${taskGoal}`,
    "",
    "输出 JSON 字段：teamName、teamDescription、mainAgentPrompt、members。",
  ].join("\n");
}

export function buildWorkflowPlanPrompt(taskGoal: string, teamJson: string): string {
  return [
    "你是主 Agent，请基于任务和团队生成串行工作流。",
    "只输出 JSON，不要 Markdown。",
    "步骤数量必须 3 到 12 个。",
    "每个步骤必须包含 title、goal、memberName、input。",
    "input 必须是 JSON object，不要输出字符串。",
    "",
    `用户任务：${taskGoal}`,
    "",
    `团队：${teamJson}`,
  ].join("\n");
}
