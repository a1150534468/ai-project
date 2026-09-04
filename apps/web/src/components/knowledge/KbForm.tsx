/**
 * 新建 / 改名共用的一张表单。原来那版有两个入口却只有一条出路：「编辑」把名字回填进
 * 这张表单，提交仍旧走 POST（`handleRenameKb` 写好了但没有任何调用点），于是改个名字
 * 变成多一个同名库。现在表单不认「模式」，只认 `editing` —— 标题、按钮文案，以及提交后
 * 走 PATCH 还是 POST，全从这一个值来，页面无从走错。
 *
 * 输入框的圆角、描边、聚焦环由 index.css 的 base/components 层统一给了 input/textarea，
 * 这里只补内边距和占位符颜色，不再把那一串重写一遍。
 */
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { Button, buttonClass, cx } from "../ui";
import type { KbDraft } from "./useKnowledgeState";

const FIELD = "w-full px-4 py-2.5 text-sm placeholder:text-ink-tertiary";

export interface KbFormProps {
  readonly draft: KbDraft;
  /** true = 在改一个已有的库，false = 在建新的 */
  readonly editing: boolean;
  readonly saving: boolean;
  readonly onChange: (patch: Partial<KbDraft>) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

export default function KbForm({ draft, editing, saving, onChange, onSubmit, onCancel }: KbFormProps) {
  // 名称是唯一的必填项：空着就不给点，省一次注定被后端退回来的往返
  const ready = draft.name.trim() !== "";

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        // 真的用 <form>：在名称框里按回车就能提交，不用非得挪到按钮上
        event.preventDefault();
        if (ready && !saving) onSubmit();
      }}
    >
      <h3 className="text-sm font-bold uppercase tracking-wider text-ink">{editing ? "编辑知识库" : "新建知识库"}</h3>

      <input
        aria-label="知识库名称"
        placeholder="知识库名称"
        value={draft.name}
        onChange={(event) => onChange({ name: event.target.value })}
        className={FIELD}
      />
      <textarea
        aria-label="知识库描述"
        placeholder="描述（可选）"
        rows={3}
        value={draft.description}
        onChange={(event) => onChange({ description: event.target.value })}
        className={cx(FIELD, "resize-none")}
      />

      <div className="flex gap-2">
        <RippleButton
          type="submit"
          disabled={!ready || saving}
          className={buttonClass({ size: "lg", shape: "rounded", className: "flex-1" })}
        >
          <Icon icon={editing ? "mdi:content-save-outline" : "mdi:plus"} className="text-lg" aria-hidden />
          {editing ? "保存修改" : "创建"}
        </RippleButton>

        {/* 取消只在编辑时有意义：新建态下这张表单本来就是空的 */}
        {editing && (
          <Button variant="outline" size="lg" shape="rounded" disabled={saving} onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </form>
  );
}
