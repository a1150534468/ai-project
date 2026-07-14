import { useState, useEffect, useCallback, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Icon } from "@iconify/react";
import {
  canBindWechat,
  wechatBindStart,
  wechatBindStatus,
  wechatUnbind,
} from "../desktopBridge";
import {
  createWechatBinding,
  listWechatBindings,
  deleteWechatBinding,
  listAgents,
  listModels,
  type WechatBinding,
  type AgentOption,
} from "../api";

const DEFAULT_WECHAT_MODEL = "MiniMax-M3";

interface WechatBindProps {
  token: string;
}

type BindingState = "qr" | "scanned" | "confirmed" | "disconnected" | "wait" | "expired";

export default function WechatBind({ token }: WechatBindProps) {
  const [canBind] = useState(() => canBindWechat());
  const [qrData, setQrData] = useState<{ qr: string; qrUrl?: string } | null>(null);
  const [bindingState, setBindingState] = useState<BindingState>("disconnected");
  const [bindings, setBindings] = useState<WechatBinding[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [models, setModels] = useState<{ model: string; displayName: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_WECHAT_MODEL);
  const [isLoading, setIsLoading] = useState(false);
  const [isBindingLoading, setIsBindingLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load agents on mount
  useEffect(() => {
    listAgents(token)
      .then((res) => {
        const allAgents = [...(res.presets ?? []), ...(res.custom ?? [])];
        setAgents(allAgents);
        if (allAgents.length > 0) {
          setSelectedAgentId(allAgents[0].id);
        }
      })
      .catch((err) => {
        console.error("Failed to load agents:", err);
      });
    listModels()
      .then((res) => setModels(res))
      .catch((err) => {
        console.error("Failed to load models:", err);
      });
  }, [token]);

  // Load bindings on mount
  useEffect(() => {
    loadBindings();
  }, []);

  const loadBindings = useCallback(async () => {
    try {
      const list = await listWechatBindings(token);
      setBindings(list);
    } catch (err) {
      console.error("Failed to load bindings:", err);
    }
  }, [token]);

  // Poll binding status when QR is shown
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const status = await wechatBindStatus();
        setBindingState(status.state as BindingState);

        if (status.state === "confirmed") {
          clearInterval(pollIntervalRef.current!);
          pollIntervalRef.current = null;
        }
      } catch (err) {
        console.error("Failed to poll binding status:", err);
      }
    }, 2000);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleGenerateQr = async () => {
    setIsLoading(true);
    setError("");
    try {
      const result = await wechatBindStart();
      setQrData(result);
      setBindingState("qr");
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成二维码失败");
      setQrData(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmBinding = async () => {
    if (!selectedAgentId) {
      setError("请选择一个 Agent");
      return;
    }

    setIsBindingLoading(true);
    setError("");
    stopPolling();

    try {
      // deviceId 从桌面连接器状态取（preload 未把 deviceId 直接挂 window.aiAssistantDesktop，需经 IPC 查）
      const bridge =
        typeof window !== "undefined"
          ? (window as unknown as {
              aiAssistantDesktop?: {
                deviceId?: string;
                getConnectorStatus?: () => Promise<{ activeDeviceId?: string; registeredDeviceId?: string }>;
              };
            }).aiAssistantDesktop
          : undefined;
      const status = await bridge?.getConnectorStatus?.().catch(() => undefined);
      const deviceId = status?.activeDeviceId || status?.registeredDeviceId || bridge?.deviceId;

      if (!deviceId) {
        throw new Error("设备未连接，请确认已在桌面客户端登录且连接器在线后重试");
      }

      await createWechatBinding(token, deviceId, selectedAgentId, selectedModel);
      setQrData(null);
      setBindingState("disconnected");
      setSelectedAgentId("");
      await loadBindings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "绑定失败");
      // Resume polling if binding failed
      startPolling();
    } finally {
      setIsBindingLoading(false);
    }
  };

  const handleUnbind = async (bindingId: string) => {
    setError("");
    setIsBindingLoading(true);
    try {
      await deleteWechatBinding(token, bindingId);
      // 桌面本地清理为 best-effort，不阻断列表刷新
      await wechatUnbind().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "解绑失败，请重试");
    } finally {
      await loadBindings().catch(() => undefined);
      setIsBindingLoading(false);
    }
  };

  const stateLabel = {
    qr: "等待扫描",
    scanned: "已扫描",
    confirmed: "已确认",
    disconnected: "未连接",
    wait: "处理中",
    expired: "已过期",
  };

  if (!canBind) {
    return (
      <div className="flex flex-col items-center justify-center min-h-full p-8 bg-[#f5f7fa]">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center shadow-sm border border-gray-100">
          <Icon icon="mdi:information-outline" className="text-4xl text-gray-400 mb-4 mx-auto" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">请在桌面客户端使用</h2>
          <p className="text-sm text-gray-600">
            微信接入功能仅在桌面客户端中可用，请在 AI 助手桌面应用中打开本页面。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full p-6 lg:p-8 bg-[#f5f7fa]">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">微信接入</h1>
          <p className="text-sm text-gray-600">
            将您的微信与 AI 助手绑定，实现便捷的微信对接。
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* QR Code Section */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-6">生成二维码</h2>

              {qrData ? (
                <div className="space-y-6">
                  {/* QR Code Display */}
                  <div className="flex justify-center">
                    {qrData.qrUrl ? (
                      <img
                        src={qrData.qrUrl}
                        alt="WeChat QR Code"
                        className="w-64 h-64 border border-gray-200 rounded-lg"
                      />
                    ) : (
                      <div className="flex justify-center items-center">
                        <QRCodeSVG value={qrData.qr} size={256} level="H" includeMargin={true} />
                      </div>
                    )}
                  </div>

                  {/* Status Display */}
                  <div className="text-center">
                    <p className="text-sm text-gray-600 mb-3">状态：</p>
                    <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-full">
                      <Icon
                        icon="mdi:check-circle"
                        className={`text-lg ${
                          bindingState === "confirmed" ? "text-green-600" : "text-blue-600"
                        }`}
                      />
                      <span className="text-sm font-medium text-gray-900">
                        {stateLabel[bindingState]}
                      </span>
                    </div>
                  </div>

                  {/* Agent Selection - Only show after confirmed */}
                  {bindingState === "confirmed" && (
                    <div className="space-y-3 pt-4 border-t border-gray-100">
                      <label className="block text-sm font-medium text-gray-900">
                        选择 Agent
                      </label>
                      <select
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand/30"
                      >
                        <option value="">-- 请选择 --</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </select>
                      <label className="block text-sm font-medium text-gray-900 pt-1">
                        回复模型
                      </label>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand/30"
                      >
                        {models.length === 0 && (
                          <option value={DEFAULT_WECHAT_MODEL}>{DEFAULT_WECHAT_MODEL}</option>
                        )}
                        {models.map((m) => (
                          <option key={m.model} value={m.model}>
                            {m.displayName || m.model}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500">
                        发图片/文件时若所选模型不支持，会自动用 MiniMax-M3 回复
                      </p>
                      {agents.length === 0 && (
                        <p className="text-xs text-gray-500">
                          暂无 Agent，请先在主界面创建
                        </p>
                      )}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-3 pt-4 border-t border-gray-100">
                    <button
                      onClick={() => {
                        stopPolling();
                        setQrData(null);
                        setBindingState("disconnected");
                        setSelectedAgentId("");
                      }}
                      className="flex-1 px-4 py-2.5 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      取消
                    </button>
                    {bindingState === "confirmed" && (
                      <button
                        onClick={handleConfirmBinding}
                        disabled={isBindingLoading || !selectedAgentId}
                        className="flex-1 px-4 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        {isBindingLoading && (
                          <Icon icon="mdi:loading" className="text-lg animate-spin" />
                        )}
                        <span>确认绑定</span>
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12">
                  <Icon icon="mdi:qrcode" className="text-6xl text-gray-300 mb-4 mx-auto" />
                  <p className="text-sm text-gray-600 mb-6">
                    点击下方按钮生成微信二维码，使用个人微信扫描
                  </p>
                  <button
                    onClick={handleGenerateQr}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 px-6 py-3 bg-brand text-white rounded-lg font-medium hover:bg-brand/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading && (
                      <Icon icon="mdi:loading" className="text-lg animate-spin" />
                    )}
                    <span>生成二维码</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Bindings List */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm h-fit">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">已绑定列表</h3>

              {bindings.length > 0 ? (
                <div className="space-y-3">
                  {bindings.map((binding) => (
                    <div
                      key={binding.id}
                      className="p-3 bg-gray-50 rounded-lg border border-gray-100"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900 truncate">
                            {binding.targetId}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Device: {binding.deviceId.slice(0, 8)}...
                          </p>
                          <div className="flex items-center gap-1 mt-2">
                            <div
                              className={`w-2 h-2 rounded-full ${
                                binding.online ? "bg-green-500" : "bg-gray-400"
                              }`}
                            />
                            <span className="text-xs text-gray-600">
                              {binding.online ? "在线" : "离线"}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleUnbind(binding.id)}
                          className="text-xs text-red-600 hover:text-red-700 font-medium flex-none"
                        >
                          解绑
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <Icon icon="mdi:link-off" className="text-3xl text-gray-300 mb-2 mx-auto" />
                  <p className="text-xs text-gray-500">暂无绑定</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
