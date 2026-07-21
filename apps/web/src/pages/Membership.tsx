import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Icon } from "@iconify/react";
import { listMembershipCards, buyMembership, myMemberships, type PaymentMethod, type UserMembership } from "../api";
import { RippleButton, Stagger, StaggerItem, spring, useToast } from "../motion";
import { paymentMethodLabel } from "./Billing";

interface MembershipCard {
  id: number;
  name: string;
  priceFen: number;
  durationDays: number;
  cadence: string;
  grantPoints: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MembershipProps {
  token: string;
}

export default function Membership({ token }: MembershipProps) {
  const [membershipCards, setMembershipCards] = useState<MembershipCard[]>([]);
  const [userMemberships, setUserMemberships] = useState<UserMembership[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [cardsLoaded, setCardsLoaded] = useState(false);
  const [myMembershipsLoaded, setMyMembershipsLoaded] = useState(false);
  const toast = useToast();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("alipay");

  const handleLoadCards = async () => {
    try {
      setMessage("");
      setLoading(true);
      const cards = await listMembershipCards(token);
      setMembershipCards(cards);
      setCardsLoaded(true);
    } catch (err) {
      setMessage(`加载月卡失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMyMemberships = async () => {
    try {
      setMessage("");
      setLoading(true);
      const memberships = await myMemberships(token);
      setUserMemberships(memberships);
      setMyMembershipsLoaded(true);
    } catch (err) {
      setMessage(`加载我的会员失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleBuyCard = async (cardId: number) => {
    try {
      setMessage("");
      setLoading(true);
      const result = await buyMembership(token, cardId, paymentMethod);
      toast.show("ok", "购买成功，请完成支付");
      setTimeout(() => {
        window.location.href = result.payUrl;
      }, 500);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "未知错误";
      toast.show("err", `购买失败: ${errorMsg}`);
      setMessage(`购买失败: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    handleLoadCards();
    handleLoadMyMemberships();
  }, []);

  return (
    <div className="flex-1 overflow-auto bg-[#f5f7fa]">
      <div className="max-w-5xl mx-auto p-6">
        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="text-[28px] font-bold text-[#1d1d1f] tracking-tight">会员与订阅</h1>
          <p className="text-sm text-gray-500 mt-1">升级您的订阅计划以获得更多权益</p>
        </div>

        <div className="bg-white rounded-2xl p-5 mb-6 border border-gray-50">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-[#1d1d1f]">支付方式</h3>
              <p className="text-xs text-gray-400 mt-1">购买会员时使用当前选择的支付方式</p>
            </div>
            <div className="inline-flex rounded-full bg-gray-50 p-1">
              {(["alipay", "wxpay"] as PaymentMethod[]).map((method) => {
                const active = paymentMethod === method;
                return (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    disabled={loading}
                    className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                      active ? "bg-white text-brand-ink shadow-sm" : "text-gray-500 "
                    }`}
                  >
                    <Icon icon={method === "wxpay" ? "ri:wechat-pay-fill" : "ri:alipay-fill"} className="text-lg" />
                    {paymentMethodLabel(method)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 可购月卡列表 */}
        <div className="mb-8">
          <h3 className="text-base font-semibold text-[#1d1d1f] mb-4">订阅方案</h3>
          {cardsLoaded && membershipCards.length > 0 ? (
            <Stagger className="grid grid-cols-3 gap-4">
              {membershipCards.map((card) => {
                const price = card.priceFen / 100;
                const pricePerDay = (price / card.durationDays).toFixed(2);
                return (
                  <StaggerItem key={card.id}>
                    <motion.div
                      className="bg-white rounded-2xl p-6 border border-gray-50 transition-all"
                      whileHover={{ y: -5 }}
                      transition={spring.snappy}
                    >
                      <h4 className="text-sm font-semibold text-[#1d1d1f] mb-1">{card.name}</h4>
                      <p className="text-xs text-gray-400 mb-4">时长: {card.durationDays} 天</p>

                      <p className="text-3xl font-bold text-[#1d1d1f]">
                        ¥{price.toFixed(2)}
                        <span className="text-base font-normal text-gray-400">/月</span>
                      </p>
                      <p className="text-[10px] text-gray-400 mt-1">约 {pricePerDay} 元/天</p>

                      <div className="mt-4 pt-4 border-t border-gray-50">
                        <ul className="space-y-2">
                          <li className="flex items-center text-xs text-gray-600">
                            <Icon icon="mdi:check-circle" className="text-brand mr-2 flex-none" />
                            每周期 {card.grantPoints.toLocaleString()} 积分
                          </li>
                          <li className="flex items-center text-xs text-gray-600">
                            <Icon icon="mdi:check-circle" className="text-brand mr-2 flex-none" />
                            周期: {card.cadence}
                          </li>
                          <li className="flex items-center text-xs text-gray-600">
                            <Icon icon="mdi:check-circle" className="text-brand mr-2 flex-none" />
                            自动续费
                          </li>
                        </ul>
                      </div>

                      <RippleButton
                        onClick={() => handleBuyCard(card.id)}
                        disabled={loading}
                        className="w-full mt-5 py-2.5 bg-brand text-white text-xs font-medium rounded-full transition-all disabled:opacity-50"
                      >
                        {loading ? "处理中..." : "立即购买"}
                      </RippleButton>
                    </motion.div>
                  </StaggerItem>
                );
              })}
            </Stagger>
          ) : cardsLoaded ? (
            <p className="text-gray-500 col-span-3 text-center py-8">暂无可用月卡</p>
          ) : (
            <div className="col-span-3 text-center py-8">
              <p className="text-gray-500 mb-4">正在加载月卡列表...</p>
            </div>
          )}
        </div>

        {/* 我的会员 */}
        <div className="bg-white rounded-2xl p-6 border border-gray-50">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-[#1d1d1f]">我的会员</h3>
            <span className="text-xs text-gray-400">共 {userMemberships.length} 个</span>
          </div>

          {myMembershipsLoaded && userMemberships.length > 0 ? (
            <div className="space-y-3">
              {userMemberships.map((membership) => {
                const startDate = new Date(membership.startAt);
                const expiresDate = new Date(membership.expiresAt);
                const now = new Date();
                const daysLeft = Math.ceil((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                const isActive = now < expiresDate;

                return (
                  <div
                    key={membership.id}
                    className="p-4 bg-brand-soft rounded-2xl border border-brand-soft"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Icon
                            icon="mdi:crown"
                            className={`text-lg ${isActive ? "text-amber-500" : "text-gray-400"}`}
                          />
                          <span className="text-sm font-semibold text-[#1d1d1f]">会员卡 #{membership.cardId}</span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${
                              isActive
                                ? "bg-brand-soft text-brand-ink"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {isActive ? "活跃" : "已过期"}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-4 mt-3">
                          <div>
                            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide mb-1">开始日期</p>
                            <p className="text-sm font-medium text-gray-700">
                              {startDate.toLocaleDateString("zh-CN")}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide mb-1">过期日期</p>
                            <p className="text-sm font-medium text-gray-700">
                              {expiresDate.toLocaleDateString("zh-CN")}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide mb-1">
                              剩余天数
                            </p>
                            <p className={`text-sm font-medium ${isActive ? "text-brand-ink" : "text-gray-500"}`}>
                              {isActive ? `${daysLeft} 天` : "已过期"}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : myMembershipsLoaded ? (
            <div className="text-center py-8">
              <Icon icon="mdi:information-outline" className="text-4xl text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">暂无会员卡，立即购买享受特权</p>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">正在加载会员信息...</p>
            </div>
          )}
        </div>

        {/* 消息提示 */}
        {message && (
          <div
            className={`mt-6 rounded-2xl p-4 border ${
              message.includes("失败") || message.includes("错误")
                ? "bg-red-50 border-red-200 text-red-700"
                : "bg-brand-soft border-brand/30 text-brand-ink"
            }`}
          >
            <div className="flex items-start gap-3">
              <Icon
                icon={message.includes("失败") || message.includes("错误") ? "mdi:alert-circle" : "mdi:check-circle"}
                className="text-xl flex-none mt-0.5"
              />
              <p className="text-sm">{message}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
