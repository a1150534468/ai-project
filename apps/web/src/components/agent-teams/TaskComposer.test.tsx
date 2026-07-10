import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskComposer } from "./TaskComposer";

describe("TaskComposer", () => {
  it("renders themed selectors instead of native browser selects", () => {
    const html = renderToStaticMarkup(
      <TaskComposer
        taskGoal=""
        teams={[]}
        selectedTeamId=""
        models={[{ model: "MiniMax-M3", displayName: "MiniMax M3" }]}
        selectedModel="MiniMax-M3"
        knowledgeBases={[{ id: "kb-1", name: "合同知识库", ownerType: "USER", latticeCount: 2 }]}
        selectedKbIds={["kb-1"]}
        attachAllOwn={false}
        attachments={[]}
        attachmentError=""
        isSubmitting={false}
        onTaskGoalChange={vi.fn()}
        onSelectedTeamChange={vi.fn()}
        onModelChange={vi.fn()}
        onKnowledgeSelectionChange={vi.fn()}
        onAddFiles={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).not.toContain("<select");
    expect(html).toContain("智能推荐新团队");
    expect(html).toContain("MiniMax M3");
    expect(html).toContain("合同知识库");
    expect(html).toContain("上传文件");
  });
});
