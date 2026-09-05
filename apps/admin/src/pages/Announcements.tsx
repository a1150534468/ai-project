/**
 * 公告管理：一张列表 + 新增弹窗，行内可停用/启用与删除。
 *
 * 重写时收掉的几处：
 * 1. 「停用/启用」那个按钮的 onClick 是一段 14 行的内联 async 闭包，塞在 `<tbody>` 里，
 *    错误处理与删除那条各写一份。现在两个动作都是页面里的命名函数，报错走同一条。
 * 2. 列表没有加载态：进页面的第一帧就摆着「暂无公告」，看着像真的没有公告。
 * 3. 新增弹窗的「发布」在请求飞行中没禁用，连点会发两条；标题/正文也没 trim，
 *    敲一串空格能过 `!title` 那道判断，发出去是一条空白公告。
 * 4. 弹窗里的输入区与页脚的提交键原来靠各自的 onClick 对齐条件；现在正文是一张真 `<form>`，
 *    页脚的按钮用 `form=` 关联过去 —— 条件只写一处，标题里按回车也能提交。
 * 5. 那句 `// eslint-disable-next-line react-hooks/exhaustive-deps` —— 本仓用的是 biome，
 *    根本没有这条规则；依赖也不缺，`show` 在 ui.tsx 里是稳定引用。
 */
import { type FormEvent, useEffect, useState } from "react";
import * as api from "../api.js";
import { errMsg, Field, Modal, Panel, Pill, type ToastKind, useConfirm, useToast } from "../ui.js";

export function AnnouncementsPage() {
  const [rows, setRows] = useState<readonly api.Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const { show, node: toastNode } = useToast();
  const { confirm, node: confirmNode } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listAnnouncements()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((error) => {
        if (!cancelled) show(errMsg(error), "err");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, show]);

  const reload = () => setNonce((n) => n + 1);

  async function toggleActive(row: api.Announcement) {
    try {
      await api.updateAnnouncement(row.id, { active: !row.active });
      show("已更新");
      reload();
    } catch (error) {
      show(errMsg(error), "err");
    }
  }

  async function remove(row: api.Announcement) {
    const ok = await confirm({
      title: "删除公告",
      message: `确认删除公告"${row.title}"？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAnnouncement(row.id);
      show("已删除");
      reload();
    } catch (error) {
      show(errMsg(error), "err");
    }
  }

  return (
    <div>
      {toastNode}
      {confirmNode}
      <Panel
        title="公告管理"
        actions={
          <button className="btn sm" type="button" onClick={() => setCreateOpen(true)}>
            新增公告
          </button>
        }
      >
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td>
                    <Pill kind={row.active ? "g" : "n"}>{row.active ? "启用" : "停用"}</Pill>
                  </td>
                  <td className="muted">{new Date(row.createdAt).toLocaleString()}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn ghost sm" type="button" onClick={() => void toggleActive(row)}>
                        {row.active ? "停用" : "启用"}
                      </button>
                      <button className="btn danger sm" type="button" onClick={() => void remove(row)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="muted">
                    暂无公告
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <CreateAnnouncement
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          show("已发布");
          reload();
        }}
        onNotify={show}
      />
    </div>
  );
}

/** 页脚的提交键靠这个 id 关联到正文里的 `<form>`：Modal 的 footer 是 body 的兄弟节点，包不进去。 */
const FORM_ID = "announcement-create";

function CreateAnnouncement({
  open,
  onClose,
  onCreated,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onNotify: (text: string, kind?: ToastKind) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !busy && title.trim() !== "" && body.trim() !== "";

  function close() {
    setTitle("");
    setBody("");
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      // 后台发的公告一律直接生效，所以 active 恒为 true；定时区间由服务端字段留着，界面暂不给
      await api.createAnnouncement({ title: title.trim(), body: body.trim(), active: true });
      setTitle("");
      setBody("");
      onCreated();
    } catch (error) {
      onNotify(errMsg(error), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新增公告"
      onClose={close}
      footer={
        <div className="modal-footer-actions">
          <button className="btn ghost" type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="btn" type="submit" form={FORM_ID} disabled={!ready}>
            {busy ? "发布中…" : "发布"}
          </button>
        </div>
      }
    >
      <form id={FORM_ID} style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={submit}>
        <Field label="标题">
          <input value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="正文">
          <textarea rows={4} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
