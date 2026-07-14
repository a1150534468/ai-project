package resource

import (
	"testing"

	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/videopoint"
)

// TestSettleVideoIO 覆盖「自动时长」预扣最大 15s → 按实际输出秒结算、退回差额。
func TestSettleVideoIO(t *testing.T) {
	st := newStore(t)
	s := New(st)
	const uid = "u-settle-video"
	// 有输入视频复合价：输入 2 点/秒、输出 5 点/秒。
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_seedance_2_720p_with_video", DisplayName: "有输入视频",
		PricingType: "VIDEO_IO", Rate: 2, OutputRate: 5, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create price: %v", err)
	}
	if err := videopoint.CreditInTx(st.DB, uid, 1000); err != nil {
		t.Fatalf("credit: %v", err)
	}

	// 预扣：输入 6s + 输出按最大 15s = 6*2 + 15*5 = 87
	reserved, err := s.ChargeVideoIO("video:auto-1", uid, "video_seedance_2_720p_with_video", 6, 15)
	if err != nil || reserved != 87 {
		t.Fatalf("reserve want 87 got %d err %v", reserved, err)
	}
	if bal, _ := videopoint.Balance(st.DB, uid); bal != 1000-87 {
		t.Fatalf("after reserve want %d got %d", 1000-87, bal)
	}

	// 结算：实际输出 8s = 6*2 + 8*5 = 52，应退回 87-52=35
	settled, err := s.SettleVideoIO("video:auto-1", "video_seedance_2_720p_with_video", 6, 8)
	if err != nil || settled != 52 {
		t.Fatalf("settle want 52 got %d err %v", settled, err)
	}
	if bal, _ := videopoint.Balance(st.DB, uid); bal != 1000-52 {
		t.Fatalf("after settle want %d got %d", 1000-52, bal)
	}

	// 幂等：重复结算不再退款
	settled2, err := s.SettleVideoIO("video:auto-1", "video_seedance_2_720p_with_video", 6, 8)
	if err != nil || settled2 != 52 {
		t.Fatalf("idempotent settle want 52 got %d err %v", settled2, err)
	}
	if bal, _ := videopoint.Balance(st.DB, uid); bal != 1000-52 {
		t.Fatalf("idempotent must not double-refund, want %d got %d", 1000-52, bal)
	}
}

// TestRefundVideoZeroesActualPoints 视频扣费（settled）退款后，记录实扣应清零、余额全额恢复。
func TestRefundVideoZeroesActualPoints(t *testing.T) {
	st := newStore(t)
	s := New(st)
	const uid = "u-refund-video"
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_seedance_2_480p_text", DisplayName: "无输入视频",
		PricingType: "PER_UNIT", Rate: 35, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create price: %v", err)
	}
	if err := videopoint.CreditInTx(st.DB, uid, 1000); err != nil {
		t.Fatalf("credit: %v", err)
	}

	// 扣 4s × 35 = 140，记录为 settled
	cost, err := s.ChargeVideo("video:refund-1", uid, "video_seedance_2_480p_text", 4)
	if err != nil || cost != 140 {
		t.Fatalf("charge want 140 got %d err %v", cost, err)
	}

	// 退款（视频生成失败路径）
	if err := s.RefundCharge("video:refund-1"); err != nil {
		t.Fatalf("refund: %v", err)
	}
	if bal, _ := videopoint.Balance(st.DB, uid); bal != 1000 {
		t.Fatalf("balance should restore to 1000 got %d", bal)
	}
	// 关键：settled → refunded 也要把 actual_points 清零（消费记录显示 0）
	var rec model.UsageRecord
	if err := st.DB.First(&rec, "operation_id = ?", "video:refund-1").Error; err != nil {
		t.Fatalf("find rec: %v", err)
	}
	if rec.Status != "refunded" || rec.ActualPoints != 0 {
		t.Fatalf("refunded record want status=refunded actual=0 got status=%s actual=%d", rec.Status, rec.ActualPoints)
	}

	// 退款幂等：重复退款不再多退
	if err := s.RefundCharge("video:refund-1"); err != nil {
		t.Fatalf("refund idempotent: %v", err)
	}
	if bal, _ := videopoint.Balance(st.DB, uid); bal != 1000 {
		t.Fatalf("double refund must not over-credit, got %d", bal)
	}
}

// TestSettleVideoIO_TextKey 无输入视频（PER_UNIT）自动时长也能结算。
func TestSettleVideoIO_TextKey(t *testing.T) {
	st := newStore(t)
	s := New(st)
	const uid = "u-settle-text"
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_seedance_2_720p_text", DisplayName: "无输入视频",
		PricingType: "PER_UNIT", Rate: 4, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create price: %v", err)
	}
	if err := videopoint.CreditInTx(st.DB, uid, 1000); err != nil {
		t.Fatalf("credit: %v", err)
	}
	// 预扣 15s：4*15=60
	if _, err := s.ChargeVideo("video:auto-2", uid, "video_seedance_2_720p_text", 15); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	// 结算实际 10s：4*10=40，退回 20
	settled, err := s.SettleVideoIO("video:auto-2", "video_seedance_2_720p_text", 0, 10)
	if err != nil || settled != 40 {
		t.Fatalf("settle want 40 got %d err %v", settled, err)
	}
	if bal, _ := videopoint.Balance(st.DB, uid); bal != 1000-40 {
		t.Fatalf("after settle want %d got %d", 1000-40, bal)
	}
}
