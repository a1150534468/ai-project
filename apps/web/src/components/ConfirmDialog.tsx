import React, { useState, useCallback } from "react";
import { Icon } from "@iconify/react";
import { Modal, RippleButton } from "../motion";

interface ConfirmDialogProps {
  title: string;
  message: string;
  onConfirm: () => Promise<void> | void;
  onCancel?: () => void;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
  children?: React.ReactNode;
}

export function useConfirm() {
  const [dialog, setDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmText: string;
    cancelText: string;
    isDangerous: boolean;
    loading?: boolean;
  } | null>(null);

  const confirm = useCallback((options: Omit<ConfirmDialogProps, "children">) => {
    return new Promise<boolean>((resolve) => {
      setDialog({
        open: true,
        title: options.title,
        message: options.message,
        confirmText: options.confirmText || "确认",
        cancelText: options.cancelText || "取消",
        isDangerous: options.isDangerous || false,
        loading: false,
        onConfirm: async () => {
          try {
            setDialog((prev) => prev ? { ...prev, loading: true } : null);
            await options.onConfirm();
            setDialog(null);
            resolve(true);
          } catch (err) {
            setDialog((prev) => prev ? { ...prev, loading: false } : null);
            resolve(false);
          }
        },
        onCancel: () => {
          options.onCancel?.();
          setDialog(null);
          resolve(false);
        },
      });
    });
  }, []);

  const Dialog = () => {
    if (!dialog?.open || !dialog) return null;

    return (
      <Modal
        open={dialog.open}
        onClose={dialog.onCancel}
        className="bg-surface rounded-2xl shadow-lg max-w-sm w-full p-6 mx-4"
      >
        <div className="flex items-start gap-3 mb-4">
          {dialog.isDangerous && (
            <Icon icon="mdi:alert-circle" className="text-red-500 text-xl flex-none mt-1" />
          )}
          <h2 className="text-lg font-semibold text-ink">{dialog.title}</h2>
        </div>

        <p className="text-sm text-ink-secondary mb-6">{dialog.message}</p>

        <div className="flex gap-3">
          <RippleButton
            onClick={dialog.onCancel}
            disabled={dialog.loading}
            className="flex-1 px-4 py-2 border border-hairline-subtle rounded-lg text-sm font-medium text-ink disabled:opacity-50 transition-colors"
          >
            {dialog.cancelText}
          </RippleButton>
          <RippleButton
            onClick={dialog.onConfirm}
            disabled={dialog.loading}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors ${
              dialog.isDangerous
                ? "bg-red-500 disabled:opacity-50"
                : "bg-brand disabled:opacity-50"
            }`}
          >
            {dialog.loading ? (
              <Icon icon="mdi:loading" className="inline animate-spin mr-1" />
            ) : null}
            {dialog.confirmText}
          </RippleButton>
        </div>
      </Modal>
    );
  };

  return { confirm, Dialog };
}
