import { useState, useEffect } from "react";
import { Icon } from "@iconify/react";
import { motion } from "motion/react";
import { RippleButton, useToast, spring } from "../motion";
import { getBalance, listModels } from "../api";
import { formatBalanceLabel } from "../balanceSync";

interface SettingsPageProps {
  token: string;
  uid?: string;
  userName?: string;
  preferredModel?: string;
  onPreferredModelChange?: (model: string) => void;
  onLogout?: () => void;
}

export default function SettingsPage({
  token,
  uid = "未知用户",
  userName = "用户",
  preferredModel = "",
  onPreferredModelChange,
  onLogout,
}: SettingsPageProps) {
  const toast = useToast();
  const [balance, setBalance] = useState<number | null>(null);
  const [models, setModels] = useState<Array<{ model: string; displayName: string }>>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // 获取余额
        const balanceData = await getBalance(token);
        setBalance(balanceData.balance);

        // 获取模型列表
        const modelsList = await listModels();
        setModels(modelsList);

        // 从 localStorage 读取保存的模型偏好
        const savedModel = preferredModel || localStorage.getItem("preferredModel");
        if (savedModel && modelsList.some((m) => m.model === savedModel)) {
          setSelectedModel(savedModel);
        } else if (modelsList.length > 0) {
          setSelectedModel(modelsList[0].model);
        }
      } catch (err) {
        setMessage(`加载数据失败: ${err instanceof Error ? err.message : "未知错误"}`);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [preferredModel, token]);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    setIsSaving(true);
    setTimeout(() => {
      localStorage.setItem("preferredModel", model);
      onPreferredModelChange?.(model);
      setMessage("默认模型已保存");
      toast.show("ok", "默认模型已保存");
      setIsSaving(false);
    }, 200);
  };

  const handleLogout = () => {
    toast.show("ok", "正在登出...");
    setTimeout(() => {
      onLogout?.();
    }, 400);
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="border-b border-gray-100 bg-white">
        <div className="max-w-6xl mx-auto px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">设置</h1>
          <p className="text-gray-500">管理账号信息和偏好设置</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Account Section */}
        <div className="bg-white rounded-xl2 border border-gray-100 p-6 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center mb-6">
            <Icon icon="mdi:account-circle-outline" className="text-2xl text-brand mr-3" />
            <h2 className="text-lg font-bold text-gray-900">账号信息</h2>
          </div>

          <div className="space-y-4">
            {/* User ID */}
            <div className="pb-4 border-b border-gray-100 last:border-0">
              <p className="text-xs text-gray-500 uppercase font-medium mb-2">用户 ID</p>
              <p className="text-sm font-mono text-gray-900">{uid}</p>
            </div>

            {/* User Name */}
            <div className="pb-4 border-b border-gray-100 last:border-0">
              <p className="text-xs text-gray-500 uppercase font-medium mb-2">用户名</p>
              <p className="text-sm text-gray-900">{userName}</p>
            </div>

            {/* Balance */}
            <div className="pb-4 border-b border-gray-100 last:border-0">
              <p className="text-xs text-gray-500 uppercase font-medium mb-2">算力点余额</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-brand">{formatBalanceLabel(balance)}</span>
              </div>
              <p className="text-xs text-gray-400 mt-2">1 RMB = 100 点</p>
            </div>
          </div>
        </div>

        {/* Model Preference */}
        <div className="bg-white rounded-xl2 border border-gray-100 p-6 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center mb-6">
            <Icon icon="mdi:robot-outline" className="text-2xl text-brand mr-3" />
            <h2 className="text-lg font-bold text-gray-900">默认模型</h2>
          </div>

          {models.length > 0 ? (
            <div className="space-y-3">
              {models.map((model) => (
                <motion.label
                  key={model.model}
                  className="flex items-center p-4 border border-gray-100 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors"
                  whileHover={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}
                >
                  <motion.div
                    initial={false}
                    animate={selectedModel === model.model ? { scale: 1.2 } : { scale: 1 }}
                    transition={spring.snappy}
                  >
                    <input
                      type="radio"
                      name="model"
                      value={model.model}
                      checked={selectedModel === model.model}
                      onChange={(e) => handleModelChange(e.target.value)}
                      className="w-4 h-4 text-brand cursor-pointer"
                    />
                  </motion.div>
                  <div className="ml-3 flex-1">
                    <p className="text-sm font-medium text-gray-900">{model.displayName}</p>
                  </div>
                  {selectedModel === model.model && (
                    <motion.div
                      initial={{ scale: 0, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0, opacity: 0 }}
                      transition={spring.bouncy}
                    >
                      <Icon icon="mdi:check-circle" className="text-brand text-lg" />
                    </motion.div>
                  )}
                </motion.label>
              ))}
              <p className="text-xs text-gray-500 mt-4">
                <Icon icon="mdi:information-outline" className="inline mr-1" />
                所选模型已保存到本地，用于新对话时的默认选择
              </p>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <Icon icon="mdi:loading" className="text-2xl mx-auto mb-2 animate-spin" />
              <p className="text-sm">加载模型列表中...</p>
            </div>
          )}
        </div>

        {/* Logout Section */}
        <div className="bg-white rounded-xl2 border border-gray-100 p-6 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center mb-6">
            <Icon icon="mdi:logout-variant" className="text-2xl text-gray-400 mr-3" />
            <h2 className="text-lg font-bold text-gray-900">登出</h2>
          </div>

          <p className="text-sm text-gray-500 mb-4">
            登出后需要重新输入用户名和密码才能登录
          </p>
          <RippleButton
            onClick={handleLogout}
            className="w-full px-4 py-2.5 bg-red-50 text-red-600 rounded-lg font-medium hover:bg-red-100 transition-colors flex items-center justify-center gap-2"
          >
            <Icon icon="mdi:logout-variant" />
            登出登录
          </RippleButton>
        </div>

        {/* Message Toast */}
        {message && (
          <div className="fixed bottom-8 left-8 right-8 max-w-sm mx-auto bg-gray-900 text-white px-6 py-3 rounded-lg text-sm font-medium shadow-lg">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
