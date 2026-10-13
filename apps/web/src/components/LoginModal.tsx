/**
 * 登录弹窗。整站未登录可浏览，点到需要登录的动作时弹出它（而非跳整页登录）。
 * 复用现有 `Login`/`Register`（embedded 变体，去掉全屏外壳），登录/注册成功后把 token 交回去。
 *
 * 登录态与「开/关」都由 `App.tsx` 持有：这里只负责「浮上来、切登录/注册、把 token 回传」。
 */
import { Modal } from "../motion";
import Login from "./Login";
import Register from "./Register";
import type { AuthView } from "../app/useAuthSession";

interface LoginModalProps {
  readonly open: boolean;
  readonly view: AuthView;
  readonly onViewChange: (view: AuthView) => void;
  /** 登录/注册成功，拿到 token。由 App 落 token + 关弹窗。 */
  readonly onAuthed: (token: string) => void;
  readonly onClose: () => void;
}

const PANEL = "w-full max-w-[420px] rounded-[18px] bg-surface-muted p-4 shadow-xl";

export default function LoginModal({ open, view, onViewChange, onAuthed, onClose }: LoginModalProps) {
  return (
    <Modal open={open} onClose={onClose} label={view === "register" ? "创建账户" : "登录账户"}>
      <div className={PANEL}>
        {view === "register" ? (
          <Register embedded onAuthed={onAuthed} onSwitchToLogin={() => onViewChange("login")} />
        ) : (
          <Login embedded onLogin={onAuthed} onSwitchToRegister={() => onViewChange("register")} />
        )}
      </div>
    </Modal>
  );
}
